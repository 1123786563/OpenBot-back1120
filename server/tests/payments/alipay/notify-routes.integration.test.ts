import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSign } from "node:crypto";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
 *
 * Every notify_id this suite uses is prefixed with a run-unique token, and
 * the cleanup deletes ONLY rows under that prefix — a foreign suite sharing
 * the database is untouched, and two runs of this suite cannot collide.
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
    trade_no: `${RUN}0000000000001`,
    out_trade_no: `order-${RUN}-0001`,
    trade_status: "TRADE_SUCCESS",
    total_amount: "10.10",
    gmt_payment: "2026-11-19 21:00:05",
    notify_id: `${RUN}-base-1`,
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

beforeAll(async () => {
  database = createDatabase(testDatabaseUrl(), TEST_POOL);
});

afterAll(async () => {
  // Only rows this run wrote: every dedupe_key begins with this run's
  // prefix (isolated rows carry the same prefix before #conflict#), so a
  // foreign suite sharing the database — and other runs of this suite —
  // are left exactly as they were.
  await database.execute(
    sql`delete from payment_channel_notification where channel = 'alipay' and dedupe_key like ${`notify_id:${RUN}-%`}`,
  );
  await database.$client.close();
});

function buildApp(inbox: ReturnType<typeof createAlipayNotifyInbox> | null) {
  // Keep the inbox override in its existing positional slot; default database
  // assembly is covered by production-wiring.integration.test.ts.
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
        eq(paymentChannelNotification.dedupeKey, `notify_id:${RUN}-base-1`),
      );
    expect(row).toBeDefined();
    expect(row!.state).toBe("inbox");
    expect(row!.tradeNo).toBe(`${RUN}0000000000001`);
    expect(row!.outTradeNo).toBe(`order-${RUN}-0001`);
    expect(row!.tradeStatus).toBe("TRADE_SUCCESS");
    expect(row!.paidAtUs).toBe(String(Date.UTC(2026, 10, 19, 13, 0, 5) * 1000));
    // The exact raw bytes are what was persisted, not a re-serialization.
    expect(Buffer.from(row!.rawPayloadB64, "base64").toString("utf8")).toBe(
      body,
    );
  });

  test("a verified replay is answered success again and stored once", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const body = notifyBody({ notify_id: `${RUN}-replay-1` });
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
        eq(paymentChannelNotification.dedupeKey, `notify_id:${RUN}-replay-1`),
      );
    expect(rows.length).toBe(1);
  });

  test("the same notify_id with DIFFERENT content is stored isolated", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const first = notifyBody({ notify_id: `${RUN}-conflict-1` });
    // Same notify_id, different amount — a mismatched-content alarm.
    const second = notifyBody({
      notify_id: `${RUN}-conflict-1`,
      total_amount: "0.01",
    });
    for (const body of [first, second]) {
      const response = await app.request("/payment-callbacks/alipay", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("success");
    }
    const inboxRows = await database
      .select()
      .from(paymentChannelNotification)
      .where(
        eq(paymentChannelNotification.dedupeKey, `notify_id:${RUN}-conflict-1`),
      );
    expect(inboxRows.length).toBe(1);
    const isolatedRows = await database
      .select()
      .from(paymentChannelNotification)
      .where(sql`dedupe_key like ${`notify_id:${RUN}-conflict-1#conflict#%`}`);
    expect(isolatedRows.length).toBe(1);
    expect(isolatedRows[0]!.payloadDigest).not.toBe(
      inboxRows[0]!.payloadDigest,
    );
    expect(isolatedRows[0]!.state).toBe("isolated");
  });

  test("a forged signature (wrong key) is answered failure and stored nowhere", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const fields: Record<string, string> = {
      app_id: ALIPAY_ENV.ALIPAY_APP_ID,
      trade_no: "forged",
      out_trade_no: "forged-order",
      trade_status: "TRADE_SUCCESS",
      total_amount: "9999.00",
      notify_id: `${RUN}-forged-1`,
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
        eq(paymentChannelNotification.dedupeKey, `notify_id:${RUN}-forged-1`),
      );
    expect(rows.length).toBe(0);
  });

  test("an amount flipped after signing is answered failure", async () => {
    const app = buildApp(createAlipayNotifyInbox(database));
    const honest = notifyBody({ notify_id: `${RUN}-flip-1` });
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
      notify_id: `${RUN}-other-app-1`,
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
    const body = notifyBody({ notify_id: `${RUN}-dupkeys-1` });
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
      notify_id: `${RUN}-ooo-1`,
      trade_status: "WAIT_BUYER_PAY",
    });
    const paid = notifyBody({
      notify_id: `${RUN}-ooo-2`,
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
        sql`dedupe_key in (${`notify_id:${RUN}-ooo-1`}, ${`notify_id:${RUN}-ooo-2`})`,
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
    const body = notifyBody({ notify_id: `${RUN}-storage-fail-1` });
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
        eq(
          paymentChannelNotification.dedupeKey,
          `notify_id:${RUN}-storage-fail-1`,
        ),
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
      body: notifyBody({ notify_id: `${RUN}-nosession-1` }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe(null);
  });

  test("with neither a database nor an override inbox no route is mounted", async () => {
    const app = buildApp(null);
    const response = await app.request("/payment-callbacks/alipay", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: notifyBody({ notify_id: `${RUN}-unmounted-1` }),
    });
    expect(response.status).toBe(404);
  });
});
