/**
 * Adapter operations against a controlled WeChat HTTP peer (#69 AC1/AC4/AC5/AC6):
 * create/query/close/refund/query-refund/bill plus H5 refresh, expiry
 * separation, timeouts-as-unknown and identity mismatch discipline. The
 * production signing/verification stack runs for real; only the WeChat
 * gateway is replaced.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createSign } from "node:crypto";
import { WechatApiClient, WechatTransportError } from "../../../src/payments/wechat/client.js";
import { WechatPayAdapter } from "../../../src/payments/wechat/adapter.js";
import { WechatTrustStore } from "../../../src/payments/wechat/trust-store.js";
import { signatureMessage } from "../../../src/payments/wechat/crypto.js";
import {
  FIXED_NOW_US,
  TEST_APIV3_KEY,
  createControlledPeer,
  generateRsa,
  type PeerAnswer,
} from "./wechat-testkit.js";
import type { CreatePaymentInput } from "../../../src/payments/wechat/types.js";

const platform = generateRsa("PUBSERIAL00A");
const merchant = generateRsa("MCHSERIAL00A");

const ORDER_EXPIRES_US = FIXED_NOW_US + 30n * 60n * 1_000_000n; // +30 min, business order deadline

function makeAdapter(
  script?: (request: import("../../../src/payments/wechat/client.js").WechatTransportRequest, authorization: string) => PeerAnswer | Promise<PeerAnswer>,
  options: { timeoutMs?: number; nowUnixSeconds?: () => bigint } = {},
) {
  const peer = createControlledPeer({
    platform,
    apiv3Key: TEST_APIV3_KEY,
    nowUnixSeconds: options.nowUnixSeconds ?? (() => FIXED_NOW_US / 1_000_000n),
    script,
  });
  const client = new WechatApiClient({
    identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
    apiv3Key: TEST_APIV3_KEY,
    privateKeyPem: merchant.privatePem,
    trustStore: new WechatTrustStore([{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }]),
    transport: peer.transport,
    nowUnixSeconds: options.nowUnixSeconds ?? (() => FIXED_NOW_US / 1_000_000n),
    timeoutMs: options.timeoutMs ?? 1_000,
  });
  const adapter = new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US });
  return { peer, client, adapter };
}

function nativeInput(overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput {
  return {
    identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
    outTradeNo: "order-20261119-0001",
    description: "OpenBot credits",
    amountFen: 9900n,
    currency: "CNY",
    orderExpiresAtUs: ORDER_EXPIRES_US,
    notifyUrl: "https://example.invalid/payment-callbacks/wechat",
    scenario: "native",
    ...overrides,
  };
}

describe("createPayment (Native / H5)", () => {
  test("native prepay hits the official path and returns code_url with a bounded action expiry (AC1/AC4)", async () => {
    const { adapter, peer } = makeAdapter(() => ({ status: 200, json: { code_url: "weixin://wxpay/bizpayurl?pr=abc" } }));
    const result = await adapter.createPayment(nativeInput());
    expect(result.kind).toBe("action");
    if (result.kind !== "action") return;
    expect(result.actionType).toBe("code_url");
    expect(result.value).toBe("weixin://wxpay/bizpayurl?pr=abc");
    // action expiry = min(issued+5min, order deadline): here the 5-minute bound wins.
    expect(result.actionExpiresAtUs).toBe((FIXED_NOW_US + 5n * 60n * 1_000_000n).toString());
    expect(result.orderExpiresAtUs).toBe(ORDER_EXPIRES_US.toString());
    expect(result.orderExpiresAtUs > result.actionExpiresAtUs).toBe(true);

    const request = peer.requests[0]!;
    const url = new URL(request.url);
    expect(request.method).toBe("POST");
    expect(url.pathname).toBe("/v3/pay/transactions/native");
    const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    expect(body.out_trade_no).toBe("order-20261119-0001");
    expect((body.amount as Record<string, unknown>).total).toBe(9900);
    expect((body.amount as Record<string, unknown>).currency).toBe("CNY");
    expect(request.authorization).toContain("WECHATPAY2-SHA256-RSA2048");
  });

  test("h5 prepay includes trusted client IP scene info and returns h5_url", async () => {
    const { adapter, peer } = makeAdapter(() => ({ status: 200, json: { h5_url: "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=x" } }));
    const result = await adapter.createPayment(
      nativeInput({ scenario: "h5", h5: { payerClientIp: "203.0.113.7" } }),
    );
    expect(result.kind).toBe("action");
    if (result.kind !== "action") return;
    expect(result.actionType).toBe("h5_url");
    const body = JSON.parse(peer.requests[0]!.body ?? "{}") as Record<string, unknown>;
    expect((body.scene_info as Record<string, unknown>).payer_client_ip).toBe("203.0.113.7");
  });

  test("h5 without a trusted client IP is refused locally", async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.createPayment(nativeInput({ scenario: "h5" }));
    expect(result.kind).toBe("rejected");
  });

  test("an expired order is refused before any network call", async () => {
    const { adapter, peer } = makeAdapter(() => ({ status: 200, json: { code_url: "weixin://x" } }));
    const result = await adapter.createPayment(nativeInput({ orderExpiresAtUs: FIXED_NOW_US - 1n }));
    expect(result).toEqual({ kind: "rejected", reason: "order_expired" });
    expect(peer.requests).toHaveLength(0);
  });

  test("action expiry never crosses the order deadline (short order)", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, json: { code_url: "weixin://x" } }));
    const result = await adapter.createPayment(
      nativeInput({ orderExpiresAtUs: FIXED_NOW_US + 2n * 60n * 1_000_000n }),
    );
    if (result.kind !== "action") throw new Error("expected action");
    expect(result.actionExpiresAtUs).toBe((FIXED_NOW_US + 2n * 60n * 1_000_000n).toString());
  });
});

describe("H5 refresh and order expiry separation (AC5)", () => {
  const firstLinkTime = FIXED_NOW_US;

  test("a live order refreshes with the same out_trade_no and original deadline", async () => {
    // Clock has advanced 5 minutes: the first link just expired, the order (30 min) is live.
    const laterUs = FIXED_NOW_US + 5n * 60n * 1_000_000n;
    const { client, peer } = makeAdapter(() => ({ status: 200, json: { h5_url: "https://wx.tenpay.com/refreshed" } }), {
      nowUnixSeconds: () => laterUs / 1_000_000n,
    });
    const adapterWithClock = new WechatPayAdapter({ client, nowUs: () => laterUs });
    const result = await adapterWithClock.refreshPaymentLink(
      nativeInput({ scenario: "h5", h5: { payerClientIp: "203.0.113.7" } }),
      undefined,
    );
    expect(result.kind).toBe("action");
    if (result.kind !== "action") return;
    expect(result.value).toBe("https://wx.tenpay.com/refreshed");
    expect(result.orderExpiresAtUs).toBe(ORDER_EXPIRES_US.toString()); // ORIGINAL deadline
    expect(peer.requests[0]!.url).toContain("/v3/pay/transactions/h5");
    const body = JSON.parse(peer.requests[0]!.body ?? "{}") as Record<string, unknown>;
    expect(body.out_trade_no).toBe("order-20261119-0001"); // SAME attempt
    expect(body.amount).toEqual({ total: 9900, currency: "CNY" }); // ORIGINAL amount
    void firstLinkTime;
  });

  test("refresh is refused once the order deadline passed, even though the H5 cycle would allow it", async () => {
    const afterOrderUs = ORDER_EXPIRES_US + 1n;
    const { client, peer } = makeAdapter(() => ({ status: 200, json: { h5_url: "https://wx.tenpay.com/late" } }));
    const late = new WechatPayAdapter({ client, nowUs: () => afterOrderUs });
    const result = await late.refreshPaymentLink(
      nativeInput({ scenario: "h5", h5: { payerClientIp: "203.0.113.7" } }),
      undefined,
    );
    expect(result).toEqual({ kind: "rejected", reason: "order_expired" });
    expect(peer.requests).toHaveLength(0);
  });

  test("a terminal payment state refuses refresh without a network call", async () => {
    const { adapter, peer } = makeAdapter(() => ({ status: 200, json: { h5_url: "https://wx.tenpay.com/x" } }));
    const result = await adapter.refreshPaymentLink(
      nativeInput({ scenario: "h5", h5: { payerClientIp: "203.0.113.7" } }),
      { terminal: true },
    );
    expect(result).toEqual({ kind: "rejected", reason: "terminal_payment_state" });
    expect(peer.requests).toHaveLength(0);
  });
});

describe("queryPayment (商户单号查单, AC1/AC4)", () => {
  const successBody = {
    out_trade_no: "order-20261119-0001",
    trade_state: "SUCCESS",
    trade_state_desc: "支付成功",
    mchid: "1900000001",
    appid: "wx1234567890",
    transaction_id: "wx_txn_1000001",
    success_time: "2023-11-14T21:41:00+08:00",
    amount: { total: 9900, payer_total: 9900, currency: "CNY" },
  };

  test("GET carries the merchant-number path and mandatory mchid query", async () => {
    const { adapter, peer } = makeAdapter(() => ({ status: 200, json: successBody }));
    const result = await adapter.queryPayment("order-20261119-0001");
    expect(result.kind).toBe("verified_payment");
    const request = peer.requests[0]!;
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(url.pathname).toBe("/v3/pay/transactions/out-trade-no/order-20261119-0001");
    expect(url.searchParams.get("mchid")).toBe("1900000001");
    expect(request.body ?? "").toBe("");
  });

  test("a verified SUCCESS answer carries every fact the order service needs (AC4)", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, json: successBody }));
    const result = await adapter.queryPayment("order-20261119-0001");
    if (result.kind !== "verified_payment") throw new Error(`expected verified, got ${result.kind}`);
    expect(result.fact).toEqual({
      mchid: "1900000001",
      appid: "wx1234567890",
      outTradeNo: "order-20261119-0001",
      transactionId: "wx_txn_1000001",
      totalFen: 9900n,
      payerFen: 9900n,
      currency: "CNY",
      successTimeUs: 1_699_969_260_000_000n,
      source: "query",
    });
  });

  test("missing success_time degrades to identity_mismatch, never to a payment (AC4)", async () => {
    const broken = { ...successBody, success_time: undefined };
    const { adapter } = makeAdapter(() => ({ status: 200, json: broken }));
    const result = await adapter.queryPayment("order-20261119-0001");
    expect(result.kind).toBe("identity_mismatch");
  });

  test("a different merchant or appid can never verify (AC4)", async () => {
    const other = { ...successBody, mchid: "1999999999" };
    const { adapter } = makeAdapter(() => ({ status: 200, json: other }));
    expect((await adapter.queryPayment("order-20261119-0001")).kind).toBe("identity_mismatch");
    const otherApp = { ...successBody, appid: "wx9999999999" };
    const { adapter: adapter2 } = makeAdapter(() => ({ status: 200, json: otherApp }));
    expect((await adapter2.queryPayment("order-20261119-0001")).kind).toBe("identity_mismatch");
  });

  test("a foreign currency can never verify (AC4)", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, json: { ...successBody, amount: { total: 9900, currency: "USD" } } }));
    expect((await adapter.queryPayment("order-20261119-0001")).kind).toBe("identity_mismatch");
  });

  test.each([
    ["NOTPAY", "pending"],
    ["ACCEPT", "pending"],
    ["USER_PAYING", "pending"],
    ["CLOSED", "closed"],
    ["REVOKED", "closed"],
    ["PAYERROR", "closed"],
  ])("trade_state %s maps to %s", async (state, kind) => {
    const { adapter } = makeAdapter(() => ({ status: 200, json: { ...successBody, trade_state: state } }));
    const result = await adapter.queryPayment("order-20261119-0001");
    expect(result.kind).toBe(kind);
  });

  test("an unmapped trade_state is unknown, not pending and not closed", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, json: { ...successBody, trade_state: "SOMETHING_NEW" } }));
    const result = await adapter.queryPayment("order-20261119-0001");
    expect(result.kind).toBe("unknown");
  });

  test("unknown merchant number answers not_found", async () => {
    const { adapter } = makeAdapter(() => ({ status: 404, json: { code: "NOT_FOUND" } }));
    expect((await adapter.queryPayment("missing")).kind).toBe("not_found");
  });

  test("a timeout is unknown and retryable — never a business result (AC8)", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, fault: "timeout" }), { timeoutMs: 50 });
    const result = await adapter.queryPayment("order-20261119-0001");
    expect(result).toEqual({ kind: "unknown", reason: expect.stringContaining("timeout"), retryable: true });
  });

  test("a network error is unknown and retryable (AC8)", async () => {
    const { adapter } = makeAdapter(() => ({ status: 0, fault: "network_error" }));
    const result = await adapter.queryPayment("order-20261119-0001");
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") expect(result.retryable).toBe(true);
  });

  test("a tampered success answer never verifies (signature failure = unknown)", async () => {
    // Peer signs honestly; client verifies; simulate tampering by scripting a response whose
    // signature was made over a DIFFERENT body.
    const peer = createControlledPeer({
      platform,
      apiv3Key: TEST_APIV3_KEY,
      nowUnixSeconds: () => FIXED_NOW_US / 1_000_000n,
    });
    const client = new WechatApiClient({
      identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
      apiv3Key: TEST_APIV3_KEY,
      privateKeyPem: merchant.privatePem,
      trustStore: new WechatTrustStore([{ id: platform.serial, publicKeyPem: platform.publicPem, notBeforeSec: null, notAfterSec: null }]),
      transport: async (request) => {
        const url = new URL(request.url);
        const timestampSec = "1700000460";
        const nonce = "n";
        const signature = createSign("RSA-SHA256")
          .update(signatureMessage(request.method, `${url.pathname}${url.search}`, timestampSec, nonce, '{"trade_state":"SUCCESS","amount":{"total":1}}'))
          .sign(platform.privatePem)
          .toString("base64");
        return {
          status: 200,
          headers: {
            "wechatpay-serial": platform.serial,
            "wechatpay-signature": signature,
            "wechatpay-timestamp": timestampSec,
            "wechatpay-nonce": nonce,
          },
          bodyBytes: new TextEncoder().encode(
            JSON.stringify({
              out_trade_no: "order-20261119-0001",
              trade_state: "SUCCESS",
              mchid: "1900000001",
              appid: "wx1234567890",
              transaction_id: "wx_txn_1",
              success_time: "2023-11-14T21:41:00+08:00",
              amount: { total: 9900, currency: "CNY" },
            }),
          ),
        };
      },
      nowUnixSeconds: () => FIXED_NOW_US / 1_000_000n,
    });
    const adapter = new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US });
    const result = await adapter.queryPayment("order-20261119-0001");
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") expect(result.retryable).toBe(false);
    void peer;
  });
});

describe("closePayment (关单, AC1/AC8)", () => {
  test("official empty-body 204 is a clean close", async () => {
    const { adapter, peer } = makeAdapter(() => ({ status: 204 }));
    const result = await adapter.closePayment("order-20261119-0001");
    expect(result).toEqual({ kind: "closed" });
    const url = new URL(peer.requests[0]!.url);
    expect(url.pathname).toBe("/v3/pay/transactions/out-trade-no/order-20261119-0001/close");
    expect(JSON.parse(peer.requests[0]!.body ?? "{}")).toEqual({ mchid: "1900000001" });
  });

  test("close racing a payment (403 ORDERPAID) is indeterminate: the query decides (AC8)", async () => {
    const { adapter } = makeAdapter(() => ({ status: 403, json: { code: "ORDERPAID" } }));
    const result = await adapter.closePayment("order-20261119-0001");
    expect(result.kind).toBe("indeterminate_paid");
  });

  test("close timeout stays unknown and retryable", async () => {
    const { adapter } = makeAdapter(() => ({ status: 204, fault: "timeout" }), { timeoutMs: 50 });
    const result = await adapter.closePayment("order-20261119-0001");
    expect(result).toEqual({ kind: "unknown", reason: expect.stringContaining("timeout"), retryable: true });
  });
});

describe("refunds (AC6)", () => {
  const refundBody = (status: string) => ({
    out_trade_no: "order-20261119-0001",
    out_refund_no: "refund-0001",
    refund_id: "wx_refund_1",
    refund_status: undefined,
    status,
    amount: { refund: 4900, total: 9900, currency: "CNY" },
    success_time: "2023-11-14T22:00:00+08:00",
  });

  test("a refund submission is accepted with the SAME out_refund_no echoed", async () => {
    const { adapter, peer } = makeAdapter(() => ({ status: 200, json: refundBody("PROCESSING") }));
    const result = await adapter.createRefund({
      outTradeNo: "order-20261119-0001",
      outRefundNo: "refund-0001",
      refundFen: 4900n,
      totalFen: 9900n,
    });
    expect(result).toEqual({ kind: "accepted", outRefundNo: "refund-0001", refundId: "wx_refund_1", channelStatus: "PROCESSING" });
    const request = peer.requests[0]!;
    expect(new URL(request.url).pathname).toBe("/v3/refund/domestic/refunds");
    const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    expect(body.out_refund_no).toBe("refund-0001");
    expect(body.amount).toEqual({ refund: 4900, total: 9900, currency: "CNY" });
  });

  test("a refund submission timeout is unknown; the retry REUSES the same number (AC6)", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, fault: "timeout" }), { timeoutMs: 50 });
    const first = await adapter.createRefund({
      outTradeNo: "order-20261119-0001",
      outRefundNo: "refund-0001",
      refundFen: 4900n,
      totalFen: 9900n,
    });
    expect(first.kind).toBe("unknown");
    // The retry path: same out_refund_no, queried first.
    const { adapter: adapter2, peer } = makeAdapter(() => ({ status: 200, json: refundBody("PROCESSING") }));
    const queried = await adapter2.queryRefund("refund-0001");
    expect(queried.kind).toBe("refund");
    const retried = await adapter2.createRefund({
      outTradeNo: "order-20261119-0001",
      outRefundNo: "refund-0001", // SAME number, no new refund created
      refundFen: 4900n,
      totalFen: 9900n,
    });
    expect(retried.kind).toBe("accepted");
    expect((retried as { outRefundNo: string }).outRefundNo).toBe("refund-0001");
    expect(peer.requests.filter((r) => r.url.includes("/refunds")).length).toBe(2);
  });

  test.each([
    ["PROCESSING", "processing"],
    ["AUDITING", "processing"],
    ["SUCCESS", "succeeded"],
    ["CLOSED", "failed"],
    ["ABNORMAL", "abnormal"],
  ])("queryRefund maps %s to %s", async (state, expected) => {
    const { adapter } = makeAdapter(() => ({ status: 200, json: refundBody(state) }));
    const result = await adapter.queryRefund("refund-0001");
    if (result.kind !== "refund") throw new Error(`expected refund, got ${result.kind}`);
    expect(result.status).toBe(expected);
    expect(result.channelState).toBe(state); // raw channel state preserved (esp. ABNORMAL)
  });

  test("ABNORMAL keeps the channel state and never asserts money movement", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, json: refundBody("ABNORMAL") }));
    const result = await adapter.queryRefund("refund-0001");
    if (result.kind !== "refund") throw new Error("expected refund");
    expect(result.status).toBe("abnormal");
    expect(result.successTimeUs).toBeNull();
  });

  test("succeeded refunds carry the exact success instant", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, json: refundBody("SUCCESS") }));
    const result = await adapter.queryRefund("refund-0001");
    if (result.kind !== "refund") throw new Error("expected refund");
    expect(result.successTimeUs).toBe(1_699_970_400_000_000n);
  });

  test("a temporarily missing refund is not_found, not failed", async () => {
    const { adapter } = makeAdapter(() => ({ status: 404, json: { code: "NOT_FOUND" } }));
    expect((await adapter.queryRefund("refund-unknown")).kind).toBe("not_found");
  });

  test("refund query timeout is unknown and retryable", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, fault: "timeout" }), { timeoutMs: 50 });
    const result = await adapter.queryRefund("refund-0001");
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") expect(result.retryable).toBe(true);
  });

  test("a channel echo of a DIFFERENT refund number is unknown, never accepted", async () => {
    const { adapter } = makeAdapter(() => ({ status: 200, json: refundBody("PROCESSING") }));
    const result = await adapter.createRefund({
      outTradeNo: "order-20261119-0001",
      outRefundNo: "refund-OTHER",
      refundFen: 4900n,
      totalFen: 9900n,
    });
    expect(result.kind).toBe("unknown");
  });

  test("a parameter rejection (400) is a refusal, not an unknown", async () => {
    const { adapter } = makeAdapter(() => ({ status: 400, json: { code: "PARAM_ERROR" } }));
    expect((await adapter.createRefund({
      outTradeNo: "order-20261119-0001",
      outRefundNo: "refund-bad",
      refundFen: 4900n,
      totalFen: 9900n,
    })).kind).toBe("rejected");
  });
});

describe("trade bill download (AC7)", () => {
  const billCsv = "记账日期,商户订单号,微信支付单号\n2026-11-19,order-1,wx_txn_1\n";
  const gzipBytes = (() => {
    const { gzipSync } = require("node:zlib") as typeof import("node:zlib");
    return new Uint8Array(gzipSync(Buffer.from(billCsv)));
  })();
  const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

  test("a matching bill is verified and published whole (AC7)", async () => {
    let downloadUrlSeen = "";
    const dir = mkdtempSync(join(tmpdir(), "wechat-bill-test-"));
    const { adapter, peer } = makeAdapter((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v3/bill/tradebill") {
        downloadUrlSeen = `https://api.mch.weixin.qq.com/v3/billdownload/file?token=test`;
        return {
          status: 200,
          json: { bill_type: "ALL", hash_type: "SHA1", hash_value: sha1(gzipBytes), download_url: downloadUrlSeen },
        };
      }
      return { status: 200, bytes: gzipBytes };
    });
    try {
      const result = await adapter.downloadTradeBill({ billDate: "20261119", billType: "ALL" });
      expect(result.kind).toBe("bill");
      if (result.kind !== "bill") return;
      expect(result.artifact.billDate).toBe("20261119");
      expect(result.artifact.mchid).toBe("1900000001");
      expect(result.artifact.sha1).toBe(sha1(gzipBytes));
      expect(existsSync(result.artifact.publishedPath)).toBe(true);
      expect(readFileSync(result.artifact.publishedPath, "utf8")).toBe(billCsv); // decompressed content
      expect(result.artifact.byteLength).toBe(Buffer.byteLength(billCsv));
      // The download was signed too, and went to the official host.
      const download = peer.requests.find((r) => r.url.includes("billdownload"))!;
      expect(new URL(download.url).hostname).toBe("api.mch.weixin.qq.com");
      expect(download.authorization).toContain("WECHATPAY2-SHA256-RSA2048");
      expect(downloadUrlSeen).toContain("billdownload");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tampered bill is never published (AC7)", async () => {
    const tampered = gzipBytes.slice(0, gzipBytes.length - 4); // truncated
    const { adapter } = makeAdapter((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v3/bill/tradebill") {
        return {
          status: 200,
          json: { hash_type: "SHA1", hash_value: sha1(gzipBytes), download_url: "https://api.mch.weixin.qq.com/v3/billdownload/file?token=t" },
        };
      }
      return { status: 200, bytes: tampered };
    });
    const result = await adapter.downloadTradeBill({ billDate: "20261119", billType: "ALL" });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.retryable).toBe(false);
  });

  test("an unknown digest algorithm is refused without publishing", async () => {
    const { adapter } = makeAdapter((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v3/bill/tradebill") {
        return {
          status: 200,
          json: { hash_type: "SM3", hash_value: "aa".repeat(32), download_url: "https://api.mch.weixin.qq.com/x" },
        };
      }
      return { status: 200, bytes: gzipBytes };
    });
    const result = await adapter.downloadTradeBill({ billDate: "20261119", billType: "ALL" });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toContain("unknown digest");
  });

  test("a download to a non-official host is refused", async () => {
    const { adapter } = makeAdapter((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v3/bill/tradebill") {
        return {
          status: 200,
          json: { hash_type: "SHA1", hash_value: sha1(gzipBytes), download_url: "https://evil.example.com/bill" },
        };
      }
      throw new Error("must not be contacted");
    });
    const result = await adapter.downloadTradeBill({ billDate: "20261119", billType: "ALL" });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toContain("allow-listed");
  });

  test("bill still generating (202) and no bill (404) are separately identifiable (AC7)", async () => {
    const { adapter } = makeAdapter(() => ({ status: 202, json: { code: "GENERATING" } }));
    expect((await adapter.downloadTradeBill({ billDate: "20261119", billType: "ALL" })).kind).toBe("generating");
    const { adapter: adapter2 } = makeAdapter(() => ({ status: 404, json: { code: "NO_BILL_EXIST" } }));
    expect((await adapter2.downloadTradeBill({ billDate: "20261119", billType: "ALL" })).kind).toBe("no_bill");
  });

  test("download timeout is a RECOVERABLE failure: rerunning re-requests the metadata (AC7)", async () => {
    let metadataRequests = 0;
    const { adapter, peer } = makeAdapter((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v3/bill/tradebill") {
        metadataRequests++;
        return {
          status: 200,
          json: { hash_type: "SHA1", hash_value: sha1(gzipBytes), download_url: "https://api.mch.weixin.qq.com/v3/billdownload/file?token=t" },
        };
      }
      return { status: 200, fault: "timeout" };
    }, { timeoutMs: 50 });
    const first = await adapter.downloadTradeBill({ billDate: "20261119", billType: "ALL" });
    expect(first.kind).toBe("failed");
    if (first.kind === "failed") expect(first.retryable).toBe(true);
    // Second run (fresh 5-minute URL): succeeds.
    const recovered = await makeAdapter((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v3/bill/tradebill") {
        metadataRequests++;
        return {
          status: 200,
          json: { hash_type: "SHA1", hash_value: sha1(gzipBytes), download_url: "https://api.mch.weixin.qq.com/v3/billdownload/file?token=t2" },
        };
      }
      return { status: 200, bytes: gzipBytes };
    });
    const second = await recovered.adapter.downloadTradeBill({ billDate: "20261119", billType: "ALL" });
    expect(second.kind).toBe("bill");
    expect(metadataRequests).toBeGreaterThanOrEqual(1);
    void peer;
  });
});

describe("transport error classification", () => {
  test("timeouts classify separately from verification failures", () => {
    expect(new WechatTransportError("timeout", "x").classification).toBe("timeout");
    expect(new WechatTransportError("bad_signature", "x").classification).toBe("bad_signature");
  });
});
