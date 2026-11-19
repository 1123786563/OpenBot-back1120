import { afterAll, describe, expect, test } from "bun:test";
import {
  AlipayPaymentAdapterImpl,
  AlipayProtocolError,
} from "../../../src/payments/alipay/adapter";
import type { AlipayChannelConfig } from "../../../src/payments/alipay/config";
import { createFetchAlipayTransport } from "../../../src/payments/alipay/gateway";
import {
  ControlledAlipayGateway,
  generateTestRsaMaterial,
  type RecordedGatewayRequest,
  type TestRsaMaterial,
  testAlipayConfig,
  testVerifyNotification,
  testVerifyRequest,
} from "./helpers";

/**
 * A1/A4/A5 protocol boundary: the REAL production adapter against a
 * controlled loopback HTTP service standing in for the gateway. Every
 * captured request is signature-verified here with the merchant public key,
 * exactly as the real gateway would.
 */

const material: TestRsaMaterial = generateTestRsaMaterial();
const gateway = new ControlledAlipayGateway(material.alipayPrivateKey);
const gatewayUrl = gateway.start();
const config: AlipayChannelConfig = testAlipayConfig(material, gatewayUrl);
const adapter = new AlipayPaymentAdapterImpl(
  config,
  createFetchAlipayTransport(config.requestTimeoutMs),
);

afterAll(() => gateway.stop());

const expiresAtMs = Date.now() + 60 * 60_000;
const expectedTimeExpire = new Date(expiresAtMs + 8 * 60 * 60_000)
  .toISOString()
  .slice(0, 19)
  .replace("T", " ");
const SNAPSHOT = {
  merchant_reference: "order-2026-1119-0001",
  amount_fen: "1010",
  currency: "CNY" as const,
  // Keep the order live regardless of when this protocol suite runs.
  expires_at_us: String(expiresAtMs * 1000),
};

function lastRequest(): RecordedGatewayRequest {
  const request = gateway.requests.at(-1);
  if (!request) throw new Error("no request captured");
  return request;
}

describe("page pay entry (A1/A2): SDK pageExecute, PC and WAP", () => {
  test("PC builds a signed redirect URL carrying FAST_INSTANT_TRADE_PAY", async () => {
    const link = await adapter.createWebPayment({
      snapshot: SNAPSHOT,
      mode: "pc",
      returnUrl: "https://app.example.invalid/return",
    });
    expect(link.action_type).toBe("redirect_url");
    const url = new URL(link.value);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      config.gatewayUrl,
    );
    const params = Object.fromEntries(url.searchParams);
    expect(params.method).toBe("alipay.trade.page.pay");
    const biz = JSON.parse(params.biz_content);
    expect(biz.product_code).toBe("FAST_INSTANT_TRADE_PAY");
    expect(biz.out_trade_no).toBe(SNAPSHOT.merchant_reference);
    expect(biz.total_amount).toBe("10.10");
    // The cashier's life is bound to the order: the official absolute
    // deadline field, in Beijing wall clock, is signed INTO the request.
    expect(biz.time_expire).toBe(expectedTimeExpire);
    expect(params.return_url).toBe("https://app.example.invalid/return");
    expect(params.notify_url).toBe(config.notifyUrl);
    expect(params.app_id).toBe(config.appId);
    // The redirect URL must verify at the boundary with the merchant key.
    expect(testVerifyRequest(params, material.merchantPublicKey)).toBe(true);
  });

  test("WAP builds a signed redirect URL carrying QUICK_WAP_WAY and the same deadline", async () => {
    const link = await adapter.createWebPayment({
      snapshot: SNAPSHOT,
      mode: "wap",
      returnUrl: "https://app.example.invalid/return",
    });
    const params = Object.fromEntries(new URL(link.value).searchParams);
    expect(params.method).toBe("alipay.trade.wap.pay");
    const biz = JSON.parse(params.biz_content);
    expect(biz.product_code).toBe("QUICK_WAP_WAY");
    expect(biz.time_expire).toBe(expectedTimeExpire);
    expect(testVerifyRequest(params, material.merchantPublicKey)).toBe(true);
  });

  test("an expired snapshot builds no cashier link at all", async () => {
    await expect(
      adapter.createWebPayment({
        snapshot: {
          ...SNAPSHOT,
          expires_at_us: String((Date.now() - 60_000) * 1000),
        },
        mode: "pc",
        returnUrl: "https://app.example.invalid/return",
      }),
    ).rejects.toThrow(/expired/);
    // The deadline boundary itself: one second into the future builds
    // one (already floored to the second), one millisecond in the past does not.
    const boundaryFuture = String((Date.now() + 1_000) * 1000);
    const link = await adapter.createWebPayment({
      snapshot: { ...SNAPSHOT, expires_at_us: boundaryFuture },
      mode: "pc",
      returnUrl: "https://app.example.invalid/return",
    });
    const biz = JSON.parse(
      Object.fromEntries(new URL(link.value).searchParams).biz_content,
    );
    expect(typeof biz.time_expire).toBe("string");
  });

  test("a return_url off the whitelist never becomes a cashier link", async () => {
    await expect(
      adapter.createWebPayment(
        SNAPSHOT,
        "pc",
        "https://evil.example.invalid/return",
      ),
    ).rejects.toThrow(AlipayProtocolError);
  });

  test("a zero amount is refused before anything is signed", async () => {
    await expect(
      adapter.createWebPayment({
        snapshot: { ...SNAPSHOT, amount_fen: "0" },
        mode: "pc",
        returnUrl: "https://app.example.invalid/return",
      }),
    ).rejects.toThrow();
  });
});

describe("query (A1/A4): statuses, identity, payment time", () => {
  test("the request envelope is signed and carries the trade identity", async () => {
    gateway.enqueueSigned("alipay_trade_query_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_no: "2026111922001400001",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.10",
      send_pay_date: "2026-11-19 21:00:05",
    });
    const observation = await adapter.query({
      merchant_reference: SNAPSHOT.merchant_reference,
      provider_transaction_id: null,
      expected_amount_fen: SNAPSHOT.amount_fen,
    });
    const request = lastRequest();
    expect(request.form.method).toBe("alipay.trade.query");
    expect(request.form.app_id).toBe(config.appId);
    expect(request.form.sign_type).toBe("RSA2");
    expect(JSON.parse(request.form.biz_content).out_trade_no).toBe(
      SNAPSHOT.merchant_reference,
    );
    expect(testVerifyRequest(request.form, material.merchantPublicKey)).toBe(
      true,
    );
    expect(observation.status).toBe("succeeded");
    expect(observation.raw_trade_status).toBe("TRADE_SUCCESS");
    expect(observation.provider_transaction_id).toBe("2026111922001400001");
    expect(observation.total_amount_fen).toBe("1010");
    expect(observation.paid_at_us).toBe(
      String(Date.UTC(2026, 10, 19, 13, 0, 5) * 1000),
    );
    expect(observation.evidence).toBe("query");
  });

  test("each documented trade status maps without losing the raw word", async () => {
    const cases = [
      ["WAIT_BUYER_PAY", "pending"],
      ["TRADE_SUCCESS", "succeeded"],
      ["TRADE_FINISHED", "succeeded"],
      ["TRADE_CLOSED", "closed"],
    ] as const;
    for (const [raw, expected] of cases) {
      gateway.enqueueSigned("alipay_trade_query_response", {
        code: "10000",
        msg: "Success",
        out_trade_no: SNAPSHOT.merchant_reference,
        trade_no: "2026111922001400001",
        trade_status: raw,
        total_amount: "10.10",
      });
      const observation = await adapter.query({
        merchant_reference: SNAPSHOT.merchant_reference,
        provider_transaction_id: null,
        expected_amount_fen: SNAPSHOT.amount_fen,
      });
      expect(observation.status).toBe(expected);
      expect(observation.raw_trade_status).toBe(raw);
    }
  });

  test("an unrecognized status stays unknown, not failed", async () => {
    gateway.enqueueSigned("alipay_trade_query_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_status: "SOMETHING_NEW",
      total_amount: "10.10",
    });
    const observation = await adapter.query({
      merchant_reference: SNAPSHOT.merchant_reference,
      provider_transaction_id: null,
      expected_amount_fen: SNAPSHOT.amount_fen,
    });
    expect(observation.status).toBe("unknown");
    expect(observation.raw_trade_status).toBe("SOMETHING_NEW");
  });

  test("a response naming another trade or amount is refused, not absorbed", async () => {
    gateway.enqueueSigned("alipay_trade_query_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: "someone-elses-order",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.10",
    });
    await expect(
      adapter.query({
        merchant_reference: SNAPSHOT.merchant_reference,
        provider_transaction_id: null,
        expected_amount_fen: SNAPSHOT.amount_fen,
      }),
    ).rejects.toThrow(AlipayProtocolError);

    gateway.enqueueSigned("alipay_trade_query_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_status: "TRADE_SUCCESS",
      total_amount: "0.01",
    });
    await expect(
      adapter.query({
        merchant_reference: SNAPSHOT.merchant_reference,
        provider_transaction_id: null,
        expected_amount_fen: SNAPSHOT.amount_fen,
      }),
    ).rejects.toThrow(AlipayProtocolError);
  });

  test("trade not found reads as pending-with-no-facts, keeping the reference", async () => {
    gateway.enqueueBusinessError(
      "alipay_trade_query_response",
      "40004",
      "Business Failed",
      "ACQ.TRADE_NOT_EXIST",
    );
    const observation = await adapter.query({
      merchant_reference: SNAPSHOT.merchant_reference,
      provider_transaction_id: null,
      expected_amount_fen: SNAPSHOT.amount_fen,
    });
    expect(observation.status).toBe("pending");
    expect(observation.provider_transaction_id).toBe(null);
    expect(observation.merchant_reference).toBe(SNAPSHOT.merchant_reference);
    expect(observation.evidence).toBe("none");
  });

  test("a query answer with NO amount cannot confirm any trade", async () => {
    gateway.enqueueSigned("alipay_trade_query_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_no: "2026111922001400001",
      trade_status: "TRADE_SUCCESS",
      // no total_amount
    });
    await expect(
      adapter.query({
        merchant_reference: SNAPSHOT.merchant_reference,
        provider_transaction_id: null,
        expected_amount_fen: SNAPSHOT.amount_fen,
      }),
    ).rejects.toThrow(AlipayProtocolError);
  });

  test("a success status without a transaction id degrades to unknown", async () => {
    gateway.enqueueSigned("alipay_trade_query_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.10",
      // no trade_no: the success cannot be bound to a channel transaction
    });
    const observation = await adapter.query({
      merchant_reference: SNAPSHOT.merchant_reference,
      provider_transaction_id: null,
      expected_amount_fen: SNAPSHOT.amount_fen,
    });
    expect(observation.status).toBe("unknown");
    expect(observation.raw_trade_status).toBe("TRADE_SUCCESS");
    expect(observation.provider_transaction_id).toBe(null);
    expect(observation.evidence).toBe("query");
  });

  test("an explicit non-CNY currency is a protocol error, never accepted", async () => {
    gateway.enqueueSigned("alipay_trade_query_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_no: "2026111922001400001",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.10",
      settle_currency: "USD",
    });
    await expect(
      adapter.query({
        merchant_reference: SNAPSHOT.merchant_reference,
        provider_transaction_id: null,
        expected_amount_fen: SNAPSHOT.amount_fen,
      }),
    ).rejects.toThrow(/not CNY/);
  });

  test("query currency stays unreported unless the response names it", async () => {
    gateway.enqueueSigned("alipay_trade_query_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_no: "2026111922001400001",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.10",
    });
    const observation = await adapter.query({
      merchant_reference: SNAPSHOT.merchant_reference,
      provider_transaction_id: null,
      expected_amount_fen: SNAPSHOT.amount_fen,
    });
    expect(observation.currency).toBe(null);
    expect(observation.status).toBe("succeeded");
    expect(observation.total_amount_fen).toBe("1010");
  });

  test("a tampered response body never becomes an observation", async () => {
    // Sign the honest node, then swap the trade_status bytes in transit.
    const { testSignedGatewayResponse } = await import("./helpers");
    const honest = testSignedGatewayResponse(
      "alipay_trade_query_response",
      {
        code: "10000",
        msg: "Success",
        out_trade_no: SNAPSHOT.merchant_reference,
        trade_status: "TRADE_SUCCESS",
        total_amount: "10.10",
      },
      material.alipayPrivateKey,
    );
    gateway.enqueue(honest.replace("TRADE_SUCCESS", "TRADE_FINISHED"));
    await expect(
      adapter.query({
        merchant_reference: SNAPSHOT.merchant_reference,
        provider_transaction_id: null,
        expected_amount_fen: SNAPSHOT.amount_fen,
      }),
    ).rejects.toThrow(AlipayProtocolError);
  });
});

describe("close (A4): success, payment race, timeout", () => {
  test("a successful close answers closed with the trade id", async () => {
    gateway.enqueueSigned("alipay_trade_close_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_no: "2026111922001400001",
    });
    const observation = await adapter.close({
      merchant_reference: SNAPSHOT.merchant_reference,
      provider_transaction_id: null,
      expected_amount_fen: SNAPSHOT.amount_fen,
    });
    expect(observation.status).toBe("closed");
    expect(observation.provider_transaction_id).toBe("2026111922001400001");
    expect(observation.evidence).toBe("close");
  });

  test("a close success that names no trade is a protocol error", async () => {
    gateway.enqueueSigned("alipay_trade_close_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      // no trade_no: the closed fact cannot be bound to a transaction
    });
    await expect(
      adapter.close({
        merchant_reference: SNAPSHOT.merchant_reference,
        provider_transaction_id: null,
        expected_amount_fen: SNAPSHOT.amount_fen,
      }),
    ).rejects.toThrow(/trade_no/);
  });

  test("a close success naming ANOTHER trade is refused", async () => {
    gateway.enqueueSigned("alipay_trade_close_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_no: "2026111922009999999",
    });
    await expect(
      adapter.close({
        merchant_reference: SNAPSHOT.merchant_reference,
        provider_transaction_id: "2026111922001400001",
        expected_amount_fen: SNAPSHOT.amount_fen,
      }),
    ).rejects.toThrow(AlipayProtocolError);
  });

  test("close losing the payment race is unknown — query decides, never close", async () => {
    gateway.enqueueBusinessError(
      "alipay_trade_close_response",
      "40004",
      "Business Failed",
      "ACQ.TRADE_HAS_SUCCESS",
    );
    const observation = await adapter.close({
      merchant_reference: SNAPSHOT.merchant_reference,
      provider_transaction_id: null,
      expected_amount_fen: SNAPSHOT.amount_fen,
    });
    expect(observation.status).toBe("unknown");
    expect(observation.evidence).toBe("none");
  });

  test("close after a timeout is unknown for the order state machine to resolve", async () => {
    // A transport whose socket never answers: the adapter's timeout policy fires.
    const impatient = new AlipayPaymentAdapterImpl(
      { ...config, requestTimeoutMs: 1 },
      {
        postForm: () =>
          new Promise((_resolve, reject) =>
            setTimeout(
              () =>
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                ),
              5,
            ),
          ),
      },
    );
    const observation = await impatient.close({
      merchant_reference: SNAPSHOT.merchant_reference,
      provider_transaction_id: null,
      expected_amount_fen: SNAPSHOT.amount_fen,
    });
    expect(observation.status).toBe("unknown");
  });
});

describe("refund (A5): persisted out_request_no, evidence, unknowns", () => {
  const refundRequest = {
    merchant_reference: SNAPSHOT.merchant_reference,
    provider_transaction_id: "2026111922001400001",
    out_request_no: "refund-2026-1119-0001",
    refund_amount_fen: "500",
  };

  test("the refund call carries the PERSISTED request number and exact amount", async () => {
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      out_request_no: refundRequest.out_request_no,
      trade_no: refundRequest.provider_transaction_id,
      fund_change: "Y",
      refund_fee: "5.00",
    });
    const observation = await adapter.refund(refundRequest);
    const request = lastRequest();
    expect(request.form.method).toBe("alipay.trade.refund");
    const biz = JSON.parse(request.form.biz_content);
    expect(biz.out_request_no).toBe("refund-2026-1119-0001");
    expect(biz.refund_amount).toBe("5.00");
    expect(biz.trade_no).toBe(refundRequest.provider_transaction_id);
    expect(biz.out_trade_no).toBeUndefined();
    expect(observation.status).toBe("succeeded");
    expect(observation.refunded_fen).toBe("500");
    expect(observation.evidence).toBe("refund_call");
  });

  test("code=10000 with fund_change N is NOT a refund success", async () => {
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      trade_no: refundRequest.provider_transaction_id,
      fund_change: "N",
      refund_fee: "5.00",
    });
    const observation = await adapter.refund(refundRequest);
    expect(observation.status).toBe("pending");
    expect(observation.evidence).toBe("refund_call");
  });

  test("a refund amount that does not match the request is not success", async () => {
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      fund_change: "Y",
      refund_fee: "4.00",
    });
    const observation = await adapter.refund(refundRequest);
    expect(observation.status).toBe("pending");
    expect(observation.refunded_fen).toBe("400");
  });

  test("a refund whose amount evidence is missing stays pending", async () => {
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      out_request_no: refundRequest.out_request_no,
      trade_no: refundRequest.provider_transaction_id,
      fund_change: "Y",
      // no refund_fee: the actual amount is unevidenced
    });
    const observation = await adapter.refund(refundRequest);
    expect(observation.status).toBe("pending");
    expect(observation.refunded_fen).toBe(null);
  });

  test("a refund echo naming ANOTHER order or trade is a protocol error", async () => {
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: "someone-elses-order",
      out_request_no: refundRequest.out_request_no,
      fund_change: "Y",
      refund_fee: "5.00",
    });
    await expect(adapter.refund(refundRequest)).rejects.toThrow(
      AlipayProtocolError,
    );
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      trade_no: "2026111922009999999",
      fund_change: "Y",
      refund_fee: "5.00",
    });
    await expect(adapter.refund(refundRequest)).rejects.toThrow(
      AlipayProtocolError,
    );
  });

  test("a response naming another request number is a protocol error", async () => {
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_request_no: "refund-someone-else",
      fund_change: "Y",
      refund_fee: "5.00",
    });
    await expect(adapter.refund(refundRequest)).rejects.toThrow(
      AlipayProtocolError,
    );
  });

  test("refund timeout is unknown — the state machine re-queries the SAME number", async () => {
    const impatient = new AlipayPaymentAdapterImpl(
      { ...config, requestTimeoutMs: 1 },
      {
        postForm: () =>
          new Promise((_resolve, reject) =>
            setTimeout(
              () =>
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                ),
              5,
            ),
          ),
      },
    );
    const observation = await impatient.refund(refundRequest);
    expect(observation.status).toBe("unknown");
    expect(observation.out_request_no).toBe("refund-2026-1119-0001");
  });

  test("refund query success without refund-success evidence stays pending", async () => {
    gateway.enqueueSigned("alipay_trade_fastpay_refund_query_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      out_request_no: refundRequest.out_request_no,
      trade_no: refundRequest.provider_transaction_id,
      // No refund_status field: query worked, refund arrival is NOT evidenced.
    });
    const observation = await adapter.queryRefund(refundRequest);
    const request = lastRequest();
    expect(request.form.method).toBe("alipay.trade.fastpay.refund.query");
    const biz = JSON.parse(request.form.biz_content);
    expect(biz.out_request_no).toBe("refund-2026-1119-0001");
    expect(biz.refund_amount).toBe("5.00");
    expect(observation.status).toBe("pending");
    expect(observation.evidence).toBe("refund_query");
  });

  test("explicit REFUND_SUCCESS with the matching amount is succeeded", async () => {
    gateway.enqueueSigned("alipay_trade_fastpay_refund_query_response", {
      code: "10000",
      msg: "Success",
      out_trade_no: SNAPSHOT.merchant_reference,
      out_request_no: refundRequest.out_request_no,
      trade_no: refundRequest.provider_transaction_id,
      refund_status: "REFUND_SUCCESS",
      refund_fee: "5.00",
    });
    const observation = await adapter.queryRefund(refundRequest);
    expect(observation.status).toBe("succeeded");
    expect(observation.refunded_fen).toBe("500");
  });

  test("REFUND_SUCCESS with NO amount evidence stays pending, never succeeded", async () => {
    gateway.enqueueSigned("alipay_trade_fastpay_refund_query_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      trade_no: refundRequest.provider_transaction_id,
      refund_status: "REFUND_SUCCESS",
      // no refund_fee: the channel said the word but evidenced no amount
    });
    const observation = await adapter.queryRefund(refundRequest);
    expect(observation.status).toBe("pending");
    expect(observation.refunded_fen).toBe(null);
  });

  test("REFUND_SUCCESS with an amount but no transaction binding stays pending", async () => {
    gateway.enqueueSigned("alipay_trade_fastpay_refund_query_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      refund_status: "REFUND_SUCCESS",
      refund_fee: "5.00",
      // no trade_no: the success cannot be bound to THIS trade
    });
    const observation = await adapter.queryRefund(refundRequest);
    expect(observation.status).toBe("pending");
  });

  test("a refund query naming ANOTHER request number is a protocol error", async () => {
    gateway.enqueueSigned("alipay_trade_fastpay_refund_query_response", {
      code: "10000",
      msg: "Success",
      out_request_no: "refund-someone-else",
      trade_no: refundRequest.provider_transaction_id,
      refund_status: "REFUND_SUCCESS",
      refund_fee: "5.00",
    });
    await expect(adapter.queryRefund(refundRequest)).rejects.toThrow(
      AlipayProtocolError,
    );
  });

  test("REFUND_SUCCESS over a different amount is unknown, never silently accepted", async () => {
    gateway.enqueueSigned("alipay_trade_fastpay_refund_query_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      refund_status: "REFUND_SUCCESS",
      refund_fee: "0.01",
    });
    const observation = await adapter.queryRefund(refundRequest);
    expect(observation.status).toBe("unknown");
    expect(observation.refunded_fen).toBe("1");
  });

  test("no refund under the request number yet reads as pending", async () => {
    gateway.enqueueBusinessError(
      "alipay_trade_fastpay_refund_query_response",
      "40004",
      "Business Failed",
      "ACQ.TRADE_NOT_EXIST",
    );
    const observation = await adapter.queryRefund(refundRequest);
    expect(observation.status).toBe("pending");
    expect(observation.evidence).toBe("refund_query");
  });
});

describe("refund identity binding (A5 rework regressions)", () => {
  const refundRequest = {
    merchant_reference: SNAPSHOT.merchant_reference,
    provider_transaction_id: "2026111922001400001",
    out_request_no: "refund-2026-1119-0001",
    refund_amount_fen: "500",
  };

  // The two controlled-gateway reproductions from the failed review round:
  // a fully-evidenced refund/answer that names NO trade identity must never
  // read as succeeded.
  test("refund success with NO echoed trade identity stays pending", async () => {
    // Request side knows trade-A and order-A; the response echoes only the
    // request number, fund change and amount.
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      fund_change: "Y",
      refund_fee: "5.00",
      // no trade_no, no out_trade_no: nothing binds this to trade-A
    });
    const observation = await adapter.refund(refundRequest);
    expect(observation.status).toBe("pending");
    expect(observation.provider_transaction_id).toBe(null);
    expect(observation.merchant_reference).toBe(null);
    expect(observation.refunded_fen).toBe("500");
  });

  test("refund success without echoes also stays pending when keyed by order", async () => {
    // Same shape, but the request itself is keyed by the merchant order (the
    // transaction id is unknown); the orderless success is still unbound.
    const orderKeyed = { ...refundRequest, provider_transaction_id: null };
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      fund_change: "Y",
      refund_fee: "5.00",
    });
    const observation = await adapter.refund(orderKeyed);
    expect(observation.status).toBe("pending");
    expect(observation.provider_transaction_id).toBe(null);
  });

  test("refund success keyed by trade requires the EXACT trade echo", async () => {
    // out_trade_no echo alone does not substitute for the known trade id.
    const orderKeyed = { ...refundRequest, provider_transaction_id: null };
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      out_trade_no: SNAPSHOT.merchant_reference,
      fund_change: "Y",
      refund_fee: "5.00",
      // no trade_no: the channel names the order but no transaction
    });
    const observation = await adapter.refund(orderKeyed);
    expect(observation.status).toBe("pending");
  });

  test("queryRefund success over an UNBINDABLE trade id stays pending", async () => {
    // Request known only by order-A; the response names foreign trade-B with
    // no out_trade_no echo — trade-B cannot be tied to order-A, so the word
    // REFUND_SUCCESS stays pending. The (unproven) trade id is still kept in
    // the observation for the state machine to re-check under the SAME number.
    const orderKeyed = { ...refundRequest, provider_transaction_id: null };
    gateway.enqueueSigned("alipay_trade_fastpay_refund_query_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      trade_no: "trade-B-unbound",
      refund_status: "REFUND_SUCCESS",
      refund_fee: "5.00",
      // no out_trade_no: trade-B cannot be tied to order-A
    });
    const observation = await adapter.queryRefund(orderKeyed);
    expect(observation.status).toBe("pending");
    expect(observation.provider_transaction_id).toBe("trade-B-unbound");
    expect(observation.merchant_reference).toBe(null);
  });

  test("queryRefund with a known trade id requires the exact trade echo", async () => {
    gateway.enqueueSigned("alipay_trade_fastpay_refund_query_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      out_trade_no: SNAPSHOT.merchant_reference,
      refund_status: "REFUND_SUCCESS",
      refund_fee: "5.00",
      // trade_no omitted: known trade-A is not echoed back
    });
    const observation = await adapter.queryRefund(refundRequest);
    expect(observation.status).toBe("pending");
    expect(observation.provider_transaction_id).toBe(null);
  });

  test("queryRefund success with an order-corroborated discovered trade binds", async () => {
    // Positive control of the unknown-id rule: trade id discovered AND the
    // merchant order echo matches the requested order — fully bound.
    const orderKeyed = { ...refundRequest, provider_transaction_id: null };
    gateway.enqueueSigned("alipay_trade_fastpay_refund_query_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_no: "trade-just-discovered",
      refund_status: "REFUND_SUCCESS",
      refund_fee: "5.00",
    });
    const observation = await adapter.queryRefund(orderKeyed);
    expect(observation.status).toBe("succeeded");
    expect(observation.provider_transaction_id).toBe("trade-just-discovered");
    expect(observation.merchant_reference).toBe(SNAPSHOT.merchant_reference);
  });

  test("refund call success with the exact trade echo still binds", async () => {
    // Positive control: the pre-existing succeeded path is unchanged.
    gateway.enqueueSigned("alipay_trade_refund_response", {
      code: "10000",
      msg: "Success",
      out_request_no: refundRequest.out_request_no,
      trade_no: refundRequest.provider_transaction_id,
      fund_change: "Y",
      refund_fee: "5.00",
    });
    const observation = await adapter.refund(refundRequest);
    expect(observation.status).toBe("succeeded");
    expect(observation.provider_transaction_id).toBe(
      refundRequest.provider_transaction_id,
    );
  });
});

describe("statement address (A1/A6)", () => {
  test("asks for the trade bill of one Beijing date and returns the address", async () => {
    gateway.enqueueSigned(
      "alipay_data_dataservice_bill_downloadurl_query_response",
      {
        code: "10000",
        msg: "Success",
        bill_download_url:
          "https://download.alipay.com/bill/20261119.zip?token=x",
      },
    );
    const result = await adapter.requestStatementAddress("2026-11-19");
    const request = lastRequest();
    expect(request.form.method).toBe(
      "alipay.data.dataservice.bill.downloadurl.query",
    );
    expect(JSON.parse(request.form.biz_content)).toEqual({
      bill_type: "trade",
      bill_date: "2026-11-19",
    });
    expect(result.kind).toBe("address");
    if (result.kind === "address") {
      expect(result.url.startsWith("https://download.alipay.com/")).toBe(true);
    }
  });

  test("a not-yet-generated bill is retryable, not a failure of the protocol", async () => {
    gateway.enqueueBusinessError(
      "alipay_data_dataservice_bill_downloadurl_query_response",
      "40004",
      "Business Failed",
      "ACQ.BILL_NOT_EXIST",
    );
    const result = await adapter.requestStatementAddress("2026-11-19");
    expect(result.kind).toBe("not_generated");
  });

  test("an expired address answer is distinguished from a transient failure", async () => {
    gateway.enqueueBusinessError(
      "alipay_data_dataservice_bill_downloadurl_query_response",
      "40004",
      "Business Failed",
      "ACQ.BILL_DOWNLOAD_URL_EXPIRED",
    );
    expect((await adapter.requestStatementAddress("2026-11-19")).kind).toBe(
      "expired",
    );
    gateway.enqueueBusinessError(
      "alipay_data_dataservice_bill_downloadurl_query_response",
      "40004",
      "Business Failed",
      "ACQ.SYSTEM_ERROR",
    );
    expect((await adapter.requestStatementAddress("2026-11-19")).kind).toBe(
      "transient_failure",
    );
  });
});

describe("notify helpers used by the entry tests", () => {
  test("boundary notification verifier agrees with the adapter's rules", () => {
    const fields: Record<string, string> = {
      app_id: config.appId,
      trade_no: "2026111922001400001",
      out_trade_no: SNAPSHOT.merchant_reference,
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.10",
      notify_id: "n-1",
      sign_type: "RSA2",
    };
    const { createSign } = require("node:crypto");
    const content = Object.keys(fields)
      .filter((k) => k !== "sign" && k !== "sign_type")
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("&");
    const sign = createSign("RSA-SHA256")
      .update(content, "utf8")
      .sign(material.alipayPrivateKey, "base64");
    expect(
      testVerifyNotification({ ...fields, sign }, material.alipayPublicKey),
    ).toBe(true);
  });
});
