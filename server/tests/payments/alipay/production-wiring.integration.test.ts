import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSign, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../../../src/app";
import { loadConfig } from "../../../src/config";
import { createDatabase, type Database } from "../../../src/db/client";
import { paymentChannelNotification } from "../../../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "../../support/database";
import { testEnvironment } from "../../support/environment";
import { generateTestRsaMaterial, type TestRsaMaterial } from "./helpers";

/**
 * The PRODUCTION assembly path for the notify entry (#70), which is the
 * branch the entry tests above do not cover: they pass an inbox explicitly,
 * while the real entry point passes ONLY the deployment config and the
 * shared database. This test builds createApp exactly that way — the inbox
 * parameter left undefined — and proves the alipay-configured deployment
 * mounts `POST /payment-callbacks/alipay` on a real PostgreSQL inbox: a
 * signed notification is answered "success" only after its insert commits.
 *
 * Signature material is generated per run; no production keys exist here.
 */

const material: TestRsaMaterial = generateTestRsaMaterial();
const RUN = randomUUID().replaceAll("-", "").slice(0, 12);

const ALIPAY_ENV = {
  ALIPAY_APP_ID: "2021000198765432",
  ALIPAY_SELLER_ID: "2088000000000000",
  ALIPAY_MERCHANT_PRIVATE_KEY: material.merchantPrivateKey,
  ALIPAY_PUBLIC_KEY: material.alipayPublicKey,
  ALIPAY_NOTIFY_URL: "https://openbot.example.invalid/payment-callbacks/alipay",
  ALIPAY_RETURN_URL_WHITELIST: "https://app.example.invalid",
  ALIPAY_GATEWAY_URL: "http://127.0.0.1:9/gateway.do",
};

function notifyBody(): string {
  const fields: Record<string, string> = {
    app_id: ALIPAY_ENV.ALIPAY_APP_ID,
    seller_id: ALIPAY_ENV.ALIPAY_SELLER_ID,
    trade_no: `${RUN}0000000000001`,
    out_trade_no: `order-${RUN}-0001`,
    trade_status: "TRADE_SUCCESS",
    total_amount: "10.10",
    gmt_payment: "2026-11-19 21:00:05",
    notify_id: `${RUN}-wired-1`,
    notify_type: "trade_status_sync",
    sign_type: "RSA2",
  };
  const content = Object.keys(fields)
    .filter((k) => k !== "sign" && k !== "sign_type" && fields[k] !== "")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("&");
  const sign = createSign("RSA-SHA256")
    .update(content, "utf8")
    .sign(material.alipayPrivateKey, "base64");
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  params.set("sign", sign);
  return params.toString();
}

let database: Database;

beforeAll(async () => {
  database = createDatabase(testDatabaseUrl(), TEST_POOL);
});

afterAll(async () => {
  await database.execute(
    sql`delete from payment_channel_notification where channel = 'alipay' and dedupe_key like ${`notify_id:${RUN}-%`}`,
  );
  await database.$client.close();
});

/** createApp as index.ts calls it: config and the shared database, nothing else. */
function buildProductionShapedApp(): ReturnType<typeof createApp> {
  const args: unknown[] = [loadConfig(testEnvironment({ ...ALIPAY_ENV }))];
  // Optional services the deployment does not pass …
  while (args.length < 25) args.push(undefined);
  // … except `attachmentDatabase`, the shared database every store is built
  // from (createApp's 26th parameter, 0-based 25) …
  args.push(database);
  // … and the remaining optionals, INCLUDING the inbox override left unset
  // (alipayNotifyInboxParam is 0-based 40; 41 arguments in total).
  while (args.length < 41) args.push(undefined);
  return createApp(
    ...(args as Parameters<
      typeof createApp extends (...args: infer A) => unknown ? A : never
    >),
  );
}

describe("production wiring: the configured deployment mounts the notify entry", () => {
  test("the route built from (config, database) alone durably holds a verified notify", async () => {
    const app = buildProductionShapedApp();
    const body = notifyBody();
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("success");
    const [row] = await database
      .select()
      .from(paymentChannelNotification)
      .where(
        eq(paymentChannelNotification.dedupeKey, `notify_id:${RUN}-wired-1`),
      );
    expect(row).toBeDefined();
    expect(row!.state).toBe("inbox");
    expect(row!.tradeNo).toBe(`${RUN}0000000000001`);
    expect(row!.appId).toBe(ALIPAY_ENV.ALIPAY_APP_ID);
    expect(Buffer.from(row!.rawPayloadB64, "base64").toString("utf8")).toBe(
      body,
    );
  });

  test("the wired route still refuses a forged signature without storing", async () => {
    const app = buildProductionShapedApp();
    const fields: Record<string, string> = {
      app_id: ALIPAY_ENV.ALIPAY_APP_ID,
      trade_no: `${RUN}0000000000002`,
      out_trade_no: `order-${RUN}-0002`,
      trade_status: "TRADE_SUCCESS",
      total_amount: "9999.00",
      notify_id: `${RUN}-wired-forged-1`,
      sign_type: "RSA2",
    };
    const content = Object.keys(fields)
      .filter((k) => k !== "sign" && k !== "sign_type")
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("&");
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) params.set(k, v);
    // Signed by the MERCHANT key, not the platform key: verification must fail.
    params.set(
      "sign",
      createSign("RSA-SHA256")
        .update(content, "utf8")
        .sign(material.merchantPrivateKey, "base64"),
    );
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    expect(await response.text()).toBe("failure");
    const rows = await database
      .select()
      .from(paymentChannelNotification)
      .where(
        eq(
          paymentChannelNotification.dedupeKey,
          `notify_id:${RUN}-wired-forged-1`,
        ),
      );
    expect(rows.length).toBe(0);
  });
});
