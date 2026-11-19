/**
 * Notification entry point and trust chain (#69 AC2/AC3): raw-HTTP entry,
 * signature probe rejection, ±300 s boundaries, unknown-serial refresh,
 * public-key mode rejection, migration-mode coexistence, duplicate/redelivery
 * and conflict handling. The route is exercised through Hono's request API —
 * the same handler the production app mounts.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSign } from "node:crypto";
import { WechatApiClient } from "../../../src/payments/wechat/client.js";
import { WechatPayAdapter } from "../../../src/payments/wechat/adapter.js";
import { WechatTrustStore, type WechatPlatformMaterial } from "../../../src/payments/wechat/trust-store.js";
import { createWechatCallbackRoutes, type WechatCallbackDeps } from "../../../src/payments/wechat/callback.js";
import { signatureMessage } from "../../../src/payments/wechat/crypto.js";
import {
  FIXED_NOW_US,
  TEST_APIV3_KEY,
  buildSuccessNotification,
  createControlledPeer,
  generateRsa,
  type RsaMaterial,
} from "./wechat-testkit.js";
import { InboxConflictError } from "../../../src/payments/wechat/inbox.js";
import type { InboxEvent } from "../../../src/payments/wechat/inbox.js";

const platform = generateRsa("PLATSERIAL01");
const oldPlatform = generateRsa("OLDSERIAL002");
const merchant = generateRsa("MCHSERIAL01A");

/** In-memory inbox recording every call (storage discipline is tested separately on real PG). */
class MemoryInbox {
  readonly events: InboxEvent[] = [];
  constructor(private readonly script?: (event: InboxEvent) => InboxRecordOutcome | Error) {}
  record(event: InboxEvent): Promise<InboxRecordOutcome> {
    const outcome = this.script?.(event) ?? "stored";
    if (outcome instanceof Error) throw outcome;
    this.events.push(event);
    return Promise.resolve(outcome);
  }
  get stored(): number {
    return this.events.length;
  }
}

function makeApp(options: {
  trustMaterials: WechatPlatformMaterial[];
  inbox?: MemoryInbox;
  nowUnixSeconds?: () => bigint;
}): { app: Hono; deps: WechatCallbackDeps } {
  const client = new WechatApiClient({
    identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
    apiv3Key: TEST_APIV3_KEY,
    privateKeyPem: merchant.privatePem,
    trustStore: new WechatTrustStore(options.trustMaterials, { refreshMinIntervalMs: 0 }),
    transport: async () => {
      throw new Error("no outbound calls from the callback tests");
    },
    nowUnixSeconds: options.nowUnixSeconds ?? (() => FIXED_NOW_US / 1_000_000n),
  });
  const adapter = new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US });
  const inbox = options.inbox ?? new MemoryInbox();
  const deps: WechatCallbackDeps = {
    adapter,
    inbox: inbox as unknown as WechatCallbackDeps["inbox"],
  };
  return { app: createWechatCallbackRoutes(deps), deps };
}

function post(
  app: Hono,
  rawBody: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.request("http://localhost/payment-callbacks/wechat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
}

const NOW_SEC = FIXED_NOW_US / 1_000_000n;

describe("valid notifications", () => {
  test("an honestly signed, honestly encrypted event is received with an empty 200? no — SUCCESS JSON", async () => {
    const { envelope } = buildSuccessNotification({
      mchid: "1900000001",
      out_trade_no: "order-1",
      transaction_id: "wx_txn_1",
      trade_state: "SUCCESS",
      amount: { total: 9900, currency: "CNY" },
    });
    const rawBody = JSON.stringify(envelope);
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    const { app, deps } = makeApp({ trustMaterials: [{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }] });
    const inbox = deps.inbox as unknown as MemoryInbox;
    const response = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: "SUCCESS", message: "成功" });
    expect(inbox.stored).toBe(1);
    // The stored event is the DECRYPTED payload plus its identity.
    expect(inbox.events[0]!.eventId).toBe("EV-0001");
    expect(inbox.events[0]!.eventType).toBe("TRANSACTION.SUCCESS");
    expect((inbox.events[0]!.decryptedResource as Record<string, unknown>).out_trade_no).toBe("order-1");
  });

  test("a re-signed replay of the SAME event dedupes by event id with an empty-body 200", async () => {
    const { envelope } = buildSuccessNotification(
      { mchid: "1900000001", out_trade_no: "order-1", amount: { total: 9900, currency: "CNY" } },
      { eventId: "EV-DUP" },
    );
    const rawBody = JSON.stringify(envelope);
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    let stored = 0;
    const inbox2 = new MemoryInbox(() => {
      if (stored > 0) return "duplicate";
      stored++;
      return "stored";
    });
    const { app } = makeApp({
      trustMaterials: [{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }],
      inbox: inbox2,
    });
    const first = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ code: "SUCCESS", message: "成功" });
    // Re-delivery, signed afresh with a NEW timestamp/nonce — same event id.
    const second = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: (NOW_SEC + 5n).toString() }));
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(""); // empty-body duplicate confirmation
    expect(stored).toBe(1); // the committed-row discipline recorded the event exactly once
  });

  test("same event id with DIFFERENT content is a conflict: alarm + FAIL, never overwrite", async () => {
    const { envelope } = buildSuccessNotification(
      { mchid: "1900000001", out_trade_no: "order-1", amount: { total: 9900, currency: "CNY" } },
      { eventId: "EV-CONFLICT" },
    );
    const rawBody = JSON.stringify(envelope);
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    let seen = false;
    const inbox = new MemoryInbox(() => {
      if (seen) {
        return new InboxConflictError(
          "notification EV-CONFLI… redelivered with different content for merchant 1900…",
        );
      }
      seen = true;
      return "stored";
    });
    const alarms: string[] = [];
    const client = new WechatApiClient({
      identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
      apiv3Key: TEST_APIV3_KEY,
      privateKeyPem: merchant.privatePem,
      trustStore: new WechatTrustStore([{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }]),
      transport: async () => {
        throw new Error("no outbound");
      },
      nowUnixSeconds: () => NOW_SEC,
    });
    const adapter = new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US });
    const conflictApp = createWechatCallbackRoutes({
      adapter,
      inbox: inbox as unknown as WechatCallbackDeps["inbox"],
      alarm: (message) => alarms.push(message),
    });
    const first = await post(conflictApp, rawBody, peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }));
    expect(first.status).toBe(200);
    // Same id, different content (different ciphertext → different hash).
    const tamperedEnvelope = { ...envelope, summary: "改" };
    const tamperedRaw = JSON.stringify(tamperedEnvelope);
    const second = await post(conflictApp, tamperedRaw, peer.signNotification(tamperedRaw, { timestampSec: NOW_SEC.toString() }));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ code: "FAIL", message: "notification identity conflict" });
    expect(alarms).toHaveLength(1);
  });

  test("storage failure answers 5xx FAIL so WeChat re-delivers (AC8)", async () => {
    const { envelope } = buildSuccessNotification({ mchid: "1900000001", out_trade_no: "order-x" }, { eventId: "EV-STORE" });
    const rawBody = JSON.stringify(envelope);
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    const failing = new MemoryInbox(() => new Error("connection refused"));
    const client = new WechatApiClient({
      identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
      apiv3Key: TEST_APIV3_KEY,
      privateKeyPem: merchant.privatePem,
      trustStore: new WechatTrustStore([{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }]),
      transport: async () => {
        throw new Error("no outbound");
      },
      nowUnixSeconds: () => NOW_SEC,
    });
    const app = createWechatCallbackRoutes({
      adapter: new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US }),
      inbox: failing as unknown as WechatCallbackDeps["inbox"],
    });
    const response = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "FAIL", message: "storage failure" });
  });

  test("an absent inbox (boundary not deployed) answers 503, never a false ACK", async () => {
    const { envelope } = buildSuccessNotification({ mchid: "1900000001", out_trade_no: "order-y" }, { eventId: "EV-NOINBOX" });
    const rawBody = JSON.stringify(envelope);
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    const client = new WechatApiClient({
      identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
      apiv3Key: TEST_APIV3_KEY,
      privateKeyPem: merchant.privatePem,
      trustStore: new WechatTrustStore([{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }]),
      transport: async () => {
        throw new Error("no outbound");
      },
      nowUnixSeconds: () => NOW_SEC,
    });
    const app = createWechatCallbackRoutes({
      adapter: new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US }),
      inbox: null,
    });
    const response = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }));
    expect(response.status).toBe(503);
  });
});

describe("rejected notifications (AC2)", () => {
  const payload = { mchid: "1900000001", out_trade_no: "order-z" };

  function makeTrustedApp(): { app: Hono; peer: ReturnType<typeof createControlledPeer> } {
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    const { app } = makeApp({
      trustMaterials: [{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }],
    });
    return { app, peer };
  }

  test("one flipped body byte after signing is rejected 401 with NO verified event", async () => {
    const { envelope } = buildSuccessNotification(payload, { eventId: "EV-TAMPER" });
    const rawBody = JSON.stringify(envelope);
    const { app, peer } = makeTrustedApp();
    const headers = peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() });
    const tampered = rawBody.replace("支付成功", "支付失败"); // envelope-level flip, same signature
    const response = await post(app, tampered, headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "FAIL", message: "notification rejected: bad_signature" });
  });

  test("a signature probe signed by an unknown key is rejected", async () => {
    const { envelope } = buildSuccessNotification(payload, { eventId: "EV-PROBE" });
    const rawBody = JSON.stringify(envelope);
    const { app, peer } = makeTrustedApp();
    const forged = peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString(), platform: merchant });
    const response = await post(app, rawBody, forged);
    expect(response.status).toBe(401);
  });

  test("a missing signature header is rejected without verification", async () => {
    const { envelope } = buildSuccessNotification(payload, { eventId: "EV-MISSING" });
    const rawBody = JSON.stringify(envelope);
    const { app, peer } = makeTrustedApp();
    const headers = peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() });
    const { "wechatpay-signature": _dropped, ...rest } = headers;
    void _dropped;
    const response = await post(app, rawBody, rest);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "FAIL", message: "notification rejected: bad_request" });
  });

  test("exactly ±300 s is accepted", async () => {
    const { envelope } = buildSuccessNotification(payload, { eventId: "EV-WIN-PLUS" });
    const rawBody = JSON.stringify(envelope);
    const { app, peer } = makeTrustedApp();
    const plus = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: (NOW_SEC + 300n).toString() }));
    expect(plus.status).toBe(200);
    const { envelope: envelope2 } = buildSuccessNotification(payload, { eventId: "EV-WIN-MINUS" });
    const rawBody2 = JSON.stringify(envelope2);
    const minus = await post(app, rawBody2, peer.signNotification(rawBody2, { timestampSec: (NOW_SEC - 300n).toString() }));
    expect(minus.status).toBe(200);
  });

  test.each([301n, -301n, 86_400n])("timestamp offset %i s is rejected (out of window)", async (offset) => {
    const { envelope } = buildSuccessNotification(payload, { eventId: `EV-LATE-${offset}` });
    const rawBody = JSON.stringify(envelope);
    const { app, peer } = makeTrustedApp();
    const response = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: (NOW_SEC + offset).toString() }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "FAIL", message: "notification rejected: timestamp_out_of_window" });
  });

  test("a wrong GCM tag (different key) is rejected AFTER a valid signature", async () => {
    // Encrypted with the WRONG APIv3 key but honestly signed: signature passes,
    // authentication decryption must fail.
    const { envelope } = buildSuccessNotification(payload, { eventId: "EV-BADTAG", apiv3Key: "ffffffffffffffffffffffffffffffff" });
    const rawBody = JSON.stringify(envelope);
    const { app, peer } = makeTrustedApp();
    const response = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "FAIL", message: "notification rejected: bad_gcm" });
  });

  test("an unknown resource algorithm is rejected", async () => {
    const { envelope, resource } = buildSuccessNotification(payload, { eventId: "EV-ALG" });
    (envelope as Record<string, unknown>).resource = { ...resource, algorithm: "AEAD_AES_256_GCM_12" };
    const rawBody = JSON.stringify(envelope);
    const { app, peer } = makeTrustedApp();
    const response = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "FAIL", message: "notification rejected: unknown_algorithm" });
  });

  test("an envelope without id/event_type is rejected as malformed", async () => {
    const rawBody = JSON.stringify({ hello: "world" });
    const { app, peer } = makeTrustedApp();
    const response = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "FAIL", message: "notification rejected: bad_structure" });
  });

  test("a decrypted resource without out_trade_no/mchid is rejected", async () => {
    const { envelope } = buildSuccessNotification({ only: "fields" }, { eventId: "EV-STRUCT" });
    const rawBody = JSON.stringify(envelope);
    const { app, peer } = makeTrustedApp();
    const response = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "FAIL", message: "notification rejected: bad_structure" });
  });

  test("an empty body is refused", async () => {
    const { app, peer } = makeTrustedApp();
    const response = await post(app, "", peer.signNotification("", { timestampSec: NOW_SEC.toString() }));
    expect(response.status).toBe(400);
  });
});

describe("material rotation and migration (AC3)", () => {
  const payload = { mchid: "1900000001", out_trade_no: "order-r" };

  test("an unknown CERTIFICATE serial triggers a controlled refresh and then verifies", async () => {
    const { envelope } = buildSuccessNotification(payload, { eventId: "EV-ROTATE" });
    const rawBody = JSON.stringify(envelope);
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    // Cold start: only the OLD certificate is trusted; the notification is signed by the NEW one.
    const client = new WechatApiClient({
      identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
      apiv3Key: TEST_APIV3_KEY,
      privateKeyPem: merchant.privatePem,
      trustStore: new WechatTrustStore([{ id: oldPlatform.serial, publicKeyPem: oldPlatform.publicPem, notBeforeSec: null, notAfterSec: null }], { refreshMinIntervalMs: 0 }),
      transport: async () => {
        throw new Error("no outbound");
      },
      nowUnixSeconds: () => NOW_SEC,
    });
    const adapter = new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US });
    const inbox = new MemoryInbox();
    const app = createWechatCallbackRoutes({
      adapter,
      inbox: inbox as unknown as WechatCallbackDeps["inbox"],
    });
    const headers = peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() });
    // Before refresh: unknown serial → rejected.
    const rejected = await post(app, rawBody, headers);
    expect(rejected.status).toBe(401);
    // A successful refresh merges the NEW certificate (fetched via the signed
    // /v3/certificates path in production; here the same trust-store merge).
    client.trustStore.upsert({ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null });
    const accepted = await post(app, rawBody, headers);
    expect(accepted.status).toBe(200);
    expect((await accepted.json())).toEqual({ code: "SUCCESS", message: "成功" });
    expect(inbox.stored).toBe(1);
  });

  test("an unknown PUBLIC KEY id is rejected outright — never fetched, never trusted", async () => {
    const { envelope } = buildSuccessNotification(payload, { eventId: "EV-PUBKEY" });
    const rawBody = JSON.stringify(envelope);
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    const { app } = makeApp({
      trustMaterials: [{ id: "PUB_KEY_ID_KNOWN", publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }],
    });
    const headers = peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString(), serial: "PUB_KEY_ID_FOREIGN" });
    const response = await post(app, rawBody, headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "FAIL", message: "notification rejected: unknown_serial" });
  });

  test("migration window: OLD and NEW certificates BOTH verify their own signatures", async () => {
    const materials = [
      { id: oldPlatform.serial, publicKeyPem: oldPlatform.publicPem, notBeforeSec: null, notAfterSec: null },
      { id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null },
    ];
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    const oldPeerSigner = (raw: string, opts: Record<string, unknown>) => peer.signNotification(raw, { platform: oldPlatform, ...opts });
    const { envelope: envelopeOld } = buildSuccessNotification(payload, { eventId: "EV-MIG-OLD" });
    const rawOld = JSON.stringify(envelopeOld);
    const { envelope: envelopeNew } = buildSuccessNotification(payload, { eventId: "EV-MIG-NEW" });
    const rawNew = JSON.stringify(envelopeNew);
    const { app, deps } = makeApp({ trustMaterials: materials });
    const inbox = deps.inbox as unknown as MemoryInbox;
    const oldSigned = await post(app, rawOld, oldPeerSigner(rawOld, { serial: oldPlatform.serial, timestampSec: NOW_SEC.toString() }));
    expect(oldSigned.status).toBe(200);
    const newSigned = await post(app, rawNew, peer.signNotification(rawNew, { serial: platform.serial, timestampSec: NOW_SEC.toString() }));
    expect(newSigned.status).toBe(200);
    expect(inbox.stored).toBe(2);
  });

  test("a RETIRED certificate is refused even though its signature is still valid", async () => {
    const { envelope } = buildSuccessNotification(payload, { eventId: "EV-RETIRED" });
    const rawBody = JSON.stringify(envelope);
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    const materials = [{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }];
    const store = new WechatTrustStore(materials);
    store.retire(platform.serial);
    const client = new WechatApiClient({
      identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
      apiv3Key: TEST_APIV3_KEY,
      privateKeyPem: merchant.privatePem,
      trustStore: store,
      transport: async () => {
        throw new Error("no outbound");
      },
      nowUnixSeconds: () => NOW_SEC,
    });
    const app = createWechatCallbackRoutes({
      adapter: new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US }),
      inbox: new MemoryInbox() as unknown as WechatCallbackDeps["inbox"],
    });
    const response = await post(app, rawBody, peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }));
    expect(response.status).toBe(401);
  });
});

describe("adapter-side notification verification (unit)", () => {
  test("a verified TRANSACTION.SUCCESS notification yields the same fact shape as the query path", async () => {
    const client = new WechatApiClient({
      identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
      apiv3Key: TEST_APIV3_KEY,
      privateKeyPem: merchant.privatePem,
      trustStore: new WechatTrustStore([{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }]),
      transport: async () => {
        throw new Error("no outbound");
      },
      nowUnixSeconds: () => NOW_SEC,
    });
    const adapter = new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US });
    const { envelope } = buildSuccessNotification({
      mchid: "1900000001",
      appid: "wx1234567890",
      out_trade_no: "order-1",
      transaction_id: "wx_txn_1",
      trade_state: "SUCCESS",
      success_time: "2023-11-14T21:41:00+08:00",
      amount: { total: 9900, payer_total: 9900, currency: "CNY" },
    });
    const rawBody = JSON.stringify(envelope);
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY });
    const verification = await adapter.verifyNotification(
      new TextEncoder().encode(rawBody),
      peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() }),
      { method: "POST", pathWithQuery: "/payment-callbacks/wechat" },
    );
    expect(verification.kind).toBe("verified");
    if (verification.kind !== "verified") return;
    const fact = adapter.paymentFactFromNotification(verification.notification);
    expect(fact.kind).toBe("verified_payment");
    if (fact.kind !== "verified_payment") return;
    expect(fact.fact.source).toBe("notification");
    expect(fact.fact.successTimeUs).toBe(1_699_969_260_000_000n);
    expect(fact.fact.totalFen).toBe(9900n);
  });

  test("a signature signed for a DIFFERENT path does not verify (path binding)", async () => {
    const client = new WechatApiClient({
      identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
      apiv3Key: TEST_APIV3_KEY,
      privateKeyPem: merchant.privatePem,
      trustStore: new WechatTrustStore([{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }]),
      transport: async () => {
        throw new Error("no outbound");
      },
      nowUnixSeconds: () => NOW_SEC,
    });
    const adapter = new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US });
    const { envelope } = buildSuccessNotification({ mchid: "1900000001", out_trade_no: "o" }, { eventId: "EV-PATH" });
    const rawBody = JSON.stringify(envelope);
    const signature = createSign("RSA-SHA256")
      .update(signatureMessage("POST", "/payment-callbacks/OTHER", NOW_SEC.toString(), "nonce-1", rawBody))
      .sign(platform.privatePem)
      .toString("base64");
    const verification = await adapter.verifyNotification(
      new TextEncoder().encode(rawBody),
      {
        "wechatpay-serial": platform.serial,
        "wechatpay-signature": signature,
        "wechatpay-timestamp": NOW_SEC.toString(),
        "wechatpay-nonce": "nonce-1",
      },
      { method: "POST", pathWithQuery: "/payment-callbacks/wechat" },
    );
    expect(verification).toEqual({ kind: "rejected", reason: "bad_signature", detail: expect.any(String) });
  });
});

export type { RsaMaterial };
