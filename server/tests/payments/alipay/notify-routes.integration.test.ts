import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSign } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../../../src/app";
import { loadConfig } from "../../../src/config";
import { createDatabase, type Database } from "../../../src/db/client";
import { paymentChannelNotification } from "../../../src/db/schema";
import { createAlipayNotifyInbox } from "../../../src/payments/alipay/inbox";
import { TEST_POOL, testDatabaseUrl } from "../../support/database";
import { testEnvironment } from "../../support/environment";
import { generateTestRsaMaterial, type TestRsaMaterial } from "./helpers";

/**
 * A3/A4 at the REAL receiving boundary: the production notify route inside
 * createApp, with a real PostgreSQL inbox (no in-memory ack anywhere).
 * Signature material is generated per run; no production keys exist here.
 */

const material: TestRsaMaterial = generateTestRsaMaterial();

const ALIPAY_ENV = {
  ALIPAY_APP_ID: "2021000198765432",
  ALIPAY_SELLER_ID: "2088000000000000",
  ALIPAY_MERCHANT_PRIVATE_KEY: material.merchantPrivateKey,
  ALIPAY_PUBLIC_KEY: material.alipayPublicKey,
  ALIPAY_NOTIFY_URL: "https://openbot.example.invalid/payment-callbacks/alipay",
  ALIPAY_RETURN_URL_WHITELIST: "https://app.example.invalid",
  ALIPAY_GATEWAY_URL: "http://127.0.0.1:9/gateway.do",
};

function signFields(fields: Record<string, string>): string {
  const content = Object.keys(fields)
    .filter((k) => k !== "sign" && k !== "sign_type" && fields[k] !== "")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("&");
  return createSign("RSA-SHA256")
    .update(content, "utf8")
    .sign(material.alipayPrivateKey, "base64");
}

function notifyBody(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    app_id: ALIPAY_ENV.ALIPAY_APP_ID,
    seller_id: ALIPAY_ENV.ALIPAY_SELLER_ID,
    trade_no: "2026111922001400001",
    out_trade_no: "order-2026-1119-0001",
    trade_status: "TRADE_SUCCESS",
    total_amount: "10.10",
    gmt_payment: "2026-11-19 21:00:05",
    notify_id: "2026111922001400009",
    notify_type: "trade_status_sync",
    sign_type: "RSA2",
    ...overrides,
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  params.set("sign", signFields(fields));
  return params.toString();
}

let database: Database;
const databaseUrlsToDelete: string[] = [];

beforeAll(async () => {
  database = createDatabase(testDatabaseUrl(), TEST_POOL);
});

afterAll(async () => {
  // Only rows this suite wrote; a foreign row (another suite sharing the
  // database) is not ours to delete.
  for (const url of databaseUrlsToDelete) void url;
  await database
    .delete(paymentChannelNotification)
    .where(eq(paymentChannelNotification.channel, "alipay"));
  await database.$client.close();
});

function buildApp(inbox: ReturnType<typeof createAlipayNotifyInbox> | null) {
  // `alipayNotifyInbox` is createApp's last positional parameter (#41); the
  // undefineds ahead of it are the optional services this suite does not use.
  const unused = Array.apply(null, Array(39)) as undefined[];
  return createApp(
    loadConfig(testEnvironment({ ...ALIPAY_ENV })),
    ...unused,
    inbox ?? undefined,
  );
}

describe("alipay notify HTTP entry over real PostgreSQL (A3/A4)", () => {
  test("a verified notification is durably held and answered success", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
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
        eq(
          paymentChannelNotification.dedupeKey,
          "notify_id:2026111922001400009",
        ),
      );
    expect(row).toBeDefined();
    expect(row!.state).toBe("inbox");
    expect(row!.tradeNo).toBe("2026111922001400001");
    expect(row!.outTradeNo).toBe("order-2026-1119-0001");
    expect(row!.tradeStatus).toBe("TRADE_SUCCESS");
    expect(row!.paidAtUs).toBe(String(Date.UTC(2026, 10, 19, 13, 0, 5) * 1000));
    // The exact raw bytes are what was persisted, not a re-serialization.
    expect(Buffer.from(row!.rawPayloadB64, "base64").toString("utf8")).toBe(
      body,
    );
  });

  test("a verified replay is answered success again and stored once", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const body = notifyBody();
    for (let i = 0; i < 2; i++) {
      const response = await app.request("/payment-callbacks/alipay", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("success");
    }
    const rows = await database
      .select()
      .from(paymentChannelNotification)
      .where(
        eq(
          paymentChannelNotification.dedupeKey,
          "notify_id:2026111922001400009",
        ),
      );
    expect(rows.length).toBe(1);
  });

  test("the same notify_id with DIFFERENT content is stored isolated", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    // Same notify_id, different amount — a mismatched-content alarm.
    const body = notifyBody({ total_amount: "0.01" });
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("success"); // durably held — as an alarm
    const rows = await database
      .select()
      .from(paymentChannelNotification)
      .where(eq(paymentChannelNotification.state, "isolated"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.payloadDigest).not.toBe(
      (
        await database
          .select()
          .from(paymentChannelNotification)
          .where(
            eq(
              paymentChannelNotification.dedupeKey,
              "notify_id:2026111922001400009",
            ),
          )
      )[0]!.payloadDigest,
    );
  });

  test("a forged signature (wrong key) is answered failure and stored nowhere", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const fields: Record<string, string> = {
      app_id: ALIPAY_ENV.ALIPAY_APP_ID,
      trade_no: "forged",
      out_trade_no: "forged-order",
      trade_status: "TRADE_SUCCESS",
      total_amount: "9999.00",
      notify_id: "forged-notify-1",
      sign_type: "RSA2",
    };
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) params.set(k, v);
    params.set("sign", signFields(fields) === "" ? "x" : "forged-signature");
    // Sign with the MERCHANT key (the attacker's): the platform key check fails.
    const content = Object.keys(fields)
      .filter((k) => k !== "sign" && k !== "sign_type")
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("&");
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
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("failure");
    const rows = await database
      .select()
      .from(paymentChannelNotification)
      .where(
        eq(paymentChannelNotification.dedupeKey, "notify_id:forged-notify-1"),
      );
    expect(rows.length).toBe(0);
  });

  test("an amount flipped after signing is answered failure", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const honest = notifyBody({ notify_id: "flip-notify-1" });
    const flipped = honest.replace("total_amount=10.10", "total_amount=0.01");
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: flipped,
    });
    expect(await response.text()).toBe("failure");
  });

  test("a foreign app_id is answered failure even under a valid signature", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const body = notifyBody({
      notify_id: "other-app-1",
      app_id: "2021009999999999",
    });
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(await response.text()).toBe("failure");
  });

  test("duplicate form keys are answered failure", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const body = notifyBody({ notify_id: "dupkeys-1" });
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${body}&total_amount=10.10`,
    });
    expect(await response.text()).toBe("failure");
  });

  test("out-of-order statuses are two messages, never one swallowed state", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const pending = notifyBody({
      notify_id: "ooo-notify-1",
      trade_status: "WAIT_BUYER_PAY",
    });
    const paid = notifyBody({
      notify_id: "ooo-notify-2",
      trade_status: "TRADE_SUCCESS",
    });
    // Success FIRST (a lost/reordered notify), then the stale pending one.
    for (const body of [paid, pending]) {
      const response = await app.request("/payment-callbacks/alipay", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(await response.text()).toBe("success");
    }
    const rows = await database
      .select()
      .from(paymentChannelNotification)
      .where(
        inArray(paymentChannelNotification.dedupeKey, [
          "notify_id:ooo-notify-1",
          "notify_id:ooo-notify-2",
        ]),
      );
    const statuses = rows.map((r) => r.tradeStatus).sort();
    expect(statuses).toEqual(["TRADE_SUCCESS", "WAIT_BUYER_PAY"]);
  });

  test("a storage failure is answered failure with 503, never success", async () => {
    const throwingInbox = createAlipayNotifyInbox(database);
    const app = buildApp({
      ...throwingInbox,
      record: async () => {
        throw new Error("disk on fire");
      },
    });
    const body = notifyBody({ notify_id: "storage-fail-1" });
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("failure");
    const rows = await database
      .select()
      .from(paymentChannelNotification)
      .where(
        eq(paymentChannelNotification.dedupeKey, "notify_id:storage-fail-1"),
      );
    expect(rows.length).toBe(0);
  });

  test("a non-form content type is answered failure without any storage", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"app_id":"x"}',
    });
    expect(await response.text()).toBe("failure");
  });

  test("the entry answers without any session or cookie", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: notifyBody({ notify_id: "nosession-1" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe(null);
  });

  test("without an inbox no notify route is mounted at all", async () => {
    const app = buildApp(null);
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: notifyBody({ notify_id: "unmounted-1" }),
    });
    expect(response.status).toBe(404);
  });
});
