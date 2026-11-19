/**
 * The alipay production channel adapter (#70): the seven traditional-gateway
 * operations behind one injectable transport.
 *
 * Protocol route (fixed by the requirement):
 *   create PC   alipay.trade.page.pay     product_code FAST_INSTANT_TRADE_PAY
 *   create WAP  alipay.trade.wap.pay      product_code QUICK_WAP_WAY
 *   query       alipay.trade.query
 *   close       alipay.trade.close
 *   refund      alipay.trade.refund
 *   queryRefund alipay.trade.fastpay.refund.query
 *   statement   alipay.data.dataservice.bill.downloadurl.query
 *
 * The route deliberately excludes the deprecated `exec()` flow and the v3
 * REST path. Nothing here invents a success fact: every observation carries
 * the evidence it came from, unknown stays unknown, and the order/refund
 * state machines (#68/#71) — never this adapter — decide entitlement or
 * retry policy.
 */

import { AlipaySdk } from "alipay-sdk";
import type {
  AlipayWebsiteMode,
  ChannelPaymentLink,
  ChannelPaymentSnapshot,
  ChannelRefundObservation,
  ChannelRefundRequest,
  ChannelTradeObservation,
} from "../types";
import { type AlipayChannelConfig, returnUrlWhitelisted } from "./config";
import {
  type AlipayGateway,
  type AlipayTransport,
  createAlipayGateway,
} from "./gateway";
import { fenToYuan, positiveFen, yuanToFen } from "./money";
import { optionalAlipayBeijingTimeToUs } from "./time";

/** The billing contract caps a redirect value at this length. */
const MAX_REDIRECT_URL_LENGTH = 2048;

const PRODUCT_CODES: Record<AlipayWebsiteMode, string> = {
  pc: "FAST_INSTANT_TRADE_PAY",
  wap: "QUICK_WAP_WAY",
};

const PAGE_PAY_METHODS: Record<AlipayWebsiteMode, string> = {
  pc: "alipay.trade.page.pay",
  wap: "alipay.trade.wap.pay",
};

/** Sub-codes the adapter interprets; anything else stays opaque. */
const SUB_TRADE_NOT_EXIST = "ACQ.TRADE_NOT_EXIST";
const SUB_TRADE_STATUS_ERROR = "ACQ.TRADE_STATUS_ERROR";
const SUB_TRADE_HAS_SUCCESS = "ACQ.TRADE_HAS_SUCCESS";

export class AlipayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlipayProtocolError";
  }
}

export interface CreateWebPaymentInput {
  snapshot: ChannelPaymentSnapshot;
  /** Explicit user entry point — never derived from a User-Agent. */
  mode: AlipayWebsiteMode;
  /** HTTPS redirect after payment; navigation only, never confirmation. */
  returnUrl: string;
}

/** Query identity: the merchant reference the channel MUST echo back. */
export interface TradeLookupInput {
  merchant_reference: string;
  provider_transaction_id: string | null;
  /** Expected exact amount in fen; a differing response is rejected. */
  expected_amount_fen: string;
}

export type AlipayStatementAddressResult =
  | { kind: "address"; url: string }
  | { kind: "not_generated"; sub_code: string | null }
  | { kind: "expired"; sub_code: string | null }
  | { kind: "transient_failure"; sub_code: string | null; reason?: string };

export interface AlipayPaymentAdapter {
  /** Build the signed cashier URL for one website mode. */
  createWebPayment(input: CreateWebPaymentInput): Promise<ChannelPaymentLink>;
  query(input: TradeLookupInput): Promise<ChannelTradeObservation>;
  close(input: TradeLookupInput): Promise<ChannelTradeObservation>;
  refund(request: ChannelRefundRequest): Promise<ChannelRefundObservation>;
  queryRefund(request: ChannelRefundRequest): Promise<ChannelRefundObservation>;
  /** Ask for the trade-bill download address of one Beijing bill date. */
  requestStatementAddress(
    billDate: string,
  ): Promise<AlipayStatementAddressResult>;
  /** The gateway URL the adapter talks to. */
  readonly gatewayUrl: string;
}

type GatewayNode = Record<string, unknown>;

function str(node: GatewayNode, key: string): string | null {
  const v = node[key];
  return typeof v === "string" ? v : null;
}

function requireExact(
  node: GatewayNode,
  key: string,
  expected: string | null,
  what: string,
): void {
  const actual = str(node, key);
  if (expected !== null && actual !== expected) {
    throw new AlipayProtocolError(
      `alipay ${what} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function mapTradeStatus(raw: string | null): ChannelTradeObservation["status"] {
  switch (raw) {
    case "WAIT_BUYER_PAY":
      return "pending";
    case "TRADE_SUCCESS":
    case "TRADE_FINISHED":
      return "succeeded";
    case "TRADE_CLOSED":
      return "closed";
    default:
      return "unknown";
  }
}

/** Trade observation from a verified query response node. */
function tradeObservationFromNode(
  node: GatewayNode,
  evidence: "query",
): ChannelTradeObservation {
  const rawStatus = str(node, "trade_status");
  let amountFen: string | null = null;
  const totalAmountRaw = str(node, "total_amount");
  if (totalAmountRaw !== null) {
    const fen = tryYuanToFen(totalAmountRaw);
    amountFen = fen === null ? null : fen.toString();
  }
  return {
    status: mapTradeStatus(rawStatus),
    raw_trade_status: rawStatus,
    provider_transaction_id: str(node, "trade_no"),
    merchant_reference: str(node, "out_trade_no"),
    total_amount_fen: amountFen,
    paid_at_us: optionalAlipayBeijingTimeToUs(str(node, "send_pay_date")),
    currency: totalAmountRaw === null ? null : "CNY",
    evidence,
  };
}

function tradeUnknown(): ChannelTradeObservation {
  return {
    status: "unknown",
    raw_trade_status: null,
    provider_transaction_id: null,
    merchant_reference: null,
    total_amount_fen: null,
    paid_at_us: null,
    currency: null,
    evidence: "none",
  };
}

function refundUnknown(
  request: ChannelRefundRequest,
  evidence: ChannelRefundObservation["evidence"],
): ChannelRefundObservation {
  return {
    out_request_no: request.out_request_no,
    status: "unknown",
    refunded_fen: null,
    provider_transaction_id: null,
    merchant_reference: null,
    evidence,
  };
}

function tryYuanToFen(yuan: string): bigint | null {
  try {
    return yuanToFen(yuan);
  } catch {
    return null;
  }
}

function tradeLookupBizContent(
  input: TradeLookupInput,
): Record<string, unknown> {
  return input.provider_transaction_id !== null
    ? { trade_no: input.provider_transaction_id }
    : { out_trade_no: input.merchant_reference };
}

export class AlipayPaymentAdapterImpl implements AlipayPaymentAdapter {
  private readonly gateway: AlipayGateway;
  /**
   * The locked official SDK builds the page-pay redirect URLs. Its request
   * signing and response cutting rules were verified against this exact
   * version's source and mirrored by `./signature` for the operations where
   * the transport is ours; page URLs go through `pageExecute` unchanged.
   */
  private readonly sdk: AlipaySdk;

  constructor(
    private readonly config: AlipayChannelConfig,
    transport: AlipayTransport,
  ) {
    this.gateway = createAlipayGateway(config, transport);
    this.sdk = new AlipaySdk({
      appId: config.appId,
      privateKey: config.merchantPrivateKey,
      signType: "RSA2",
      alipayPublicKey: config.alipayPublicKey,
      gateway: config.gatewayUrl,
      charset: "utf-8",
      version: "1.0",
      keyType: "PKCS8",
      camelcase: false,
    });
  }

  get gatewayUrl(): string {
    return this.gateway.gatewayUrl;
  }

  async createWebPayment(
    input: CreateWebPaymentInput,
  ): Promise<ChannelPaymentLink> {
    const { snapshot, mode } = input;
    if (!returnUrlWhitelisted(this.config, input.returnUrl)) {
      throw new AlipayProtocolError("return_url is not on the whitelist");
    }
    const amountYuan = fenToYuan(positiveFen(snapshot.amount_fen).toString());
    const url = this.sdk.pageExecute(PAGE_PAY_METHODS[mode], "GET", {
      return_url: input.returnUrl,
      notify_url: this.config.notifyUrl,
      bizContent: {
        out_trade_no: snapshot.merchant_reference,
        product_code: PRODUCT_CODES[mode],
        total_amount: amountYuan,
        subject: "OpenBot order payment",
      },
    });
    if (url.length > MAX_REDIRECT_URL_LENGTH) {
      // A signed URL cannot be shortened without invalidating the signature:
      // over the limit is an explicit failure, never a truncation.
      throw new AlipayProtocolError(
        `alipay redirect URL exceeds the contract length limit (${url.length} > ${MAX_REDIRECT_URL_LENGTH})`,
      );
    }
    return { action_type: "redirect_url", value: url };
  }

  async query(input: TradeLookupInput): Promise<ChannelTradeObservation> {
    const result = await this.gateway.execute<ChannelTradeObservation>(
      {
        method: "alipay.trade.query",
        bizContent: tradeLookupBizContent(input),
      },
      (node) => {
        requireExact(
          node,
          "out_trade_no",
          input.merchant_reference,
          "out_trade_no",
        );
        if (input.provider_transaction_id !== null) {
          requireExact(
            node,
            "trade_no",
            input.provider_transaction_id,
            "trade_no",
          );
        }
        if (str(node, "total_amount") !== null) {
          requireExact(
            node,
            "total_amount",
            fenToYuan(input.expected_amount_fen),
            "total_amount",
          );
        }
        return tradeObservationFromNode(node, "query");
      },
    );
    if (result.ok) return result.value;
    const failure = result.failure;
    if (failure.kind === "verify_failed") {
      // A response whose bytes do not match their signature is a security
      // event, not an unknown trade state: refuse it loudly.
      throw new AlipayProtocolError(
        "alipay query response failed signature verification",
      );
    }
    if (
      failure.kind === "business_error" &&
      failure.subCode === SUB_TRADE_NOT_EXIST
    ) {
      // The channel knows no such trade (yet): pending-with-no-facts, which
      // the order state machine keeps querying until its own deadline.
      return {
        ...tradeUnknown(),
        status: "pending",
        merchant_reference: input.merchant_reference,
      };
    }
    return tradeUnknown();
  }

  async close(input: TradeLookupInput): Promise<ChannelTradeObservation> {
    const result = await this.gateway.execute<GatewayNode>(
      {
        method: "alipay.trade.close",
        bizContent: tradeLookupBizContent(input),
      },
      (node) => node,
    );
    if (result.ok) {
      const node = result.value;
      requireExact(
        node,
        "out_trade_no",
        input.merchant_reference,
        "out_trade_no",
      );
      // A successful close answers with the trade id; the channel has just
      // moved the trade to closed.
      return {
        status: "closed",
        raw_trade_status: null,
        provider_transaction_id: str(node, "trade_no"),
        merchant_reference: str(node, "out_trade_no"),
        total_amount_fen: null,
        paid_at_us: null,
        currency: null,
        evidence: "close",
      };
    }
    const failure = result.failure;
    if (failure.kind === "business_error") {
      // Close refused. None of these is a payment fact by itself: the caller
      // verifies through query before anything records success or expiry.
      if (
        failure.subCode === SUB_TRADE_HAS_SUCCESS ||
        failure.subCode === SUB_TRADE_NOT_EXIST ||
        failure.subCode === SUB_TRADE_STATUS_ERROR
      ) {
        return tradeUnknown();
      }
    }
    if (failure.kind === "verify_failed") {
      throw new AlipayProtocolError(
        "alipay close response failed signature verification",
      );
    }
    // Timeout and transport unknowns go back to the order state machine,
    // which resolves them through query — never as failed/closed here.
    return tradeUnknown();
  }

  async refund(
    request: ChannelRefundRequest,
  ): Promise<ChannelRefundObservation> {
    const refundYuan = fenToYuan(
      positiveFen(request.refund_amount_fen).toString(),
    );
    const bizContent: Record<string, unknown> = {
      refund_amount: refundYuan,
      // The persisted refund request number is the channel idempotency key:
      // retries reuse it, a different number would be a DIFFERENT refund.
      out_request_no: request.out_request_no,
      ...(request.provider_transaction_id !== null
        ? { trade_no: request.provider_transaction_id }
        : { out_trade_no: request.merchant_reference }),
    };
    const result = await this.gateway.execute<GatewayNode>(
      { method: "alipay.trade.refund", bizContent },
      (node) => node,
    );
    if (!result.ok) {
      const evidence: ChannelRefundObservation["evidence"] =
        result.failure.kind === "timeout" ? "none" : "none";
      return refundUnknown(request, evidence);
    }
    const node = result.value;
    const echoedRequestNo = str(node, "out_request_no");
    if (
      echoedRequestNo !== null &&
      echoedRequestNo !== request.out_request_no
    ) {
      throw new AlipayProtocolError(
        "alipay refund response names a different out_request_no",
      );
    }
    const refundFee = str(node, "refund_fee");
    const actualFen = refundFee !== null ? tryYuanToFen(refundFee) : null;
    const base: ChannelRefundObservation = {
      out_request_no: request.out_request_no,
      status: "pending",
      refunded_fen: actualFen !== null ? actualFen.toString() : null,
      provider_transaction_id: str(node, "trade_no"),
      merchant_reference: str(node, "out_trade_no"),
      evidence: "refund_call",
    };
    // Refund-arrived evidence is the documented fund-change flag AND the
    // actual refund fee matching the request. code=10000 alone is NOT
    // evidence, and fund_change "N" (this call moved no funds) is resolved
    // authoritatively by queryRefund with the SAME request number.
    if (
      str(node, "fund_change") === "Y" &&
      actualFen !== null &&
      actualFen.toString() === request.refund_amount_fen
    ) {
      return { ...base, status: "succeeded" };
    }
    return base;
  }

  async queryRefund(
    request: ChannelRefundRequest,
  ): Promise<ChannelRefundObservation> {
    const bizContent: Record<string, unknown> = {
      out_request_no: request.out_request_no,
      refund_amount: fenToYuan(request.refund_amount_fen),
      ...(request.provider_transaction_id !== null
        ? { trade_no: request.provider_transaction_id }
        : { out_trade_no: request.merchant_reference }),
    };
    const result = await this.gateway.execute<GatewayNode>(
      { method: "alipay.trade.fastpay.refund.query", bizContent },
      (node) => node,
    );
    if (!result.ok) {
      const failure = result.failure;
      if (
        failure.kind === "business_error" &&
        failure.subCode === SUB_TRADE_NOT_EXIST
      ) {
        // No refund under this request number (yet). Pending, so the refund
        // state machine keeps polling; nothing succeeded here.
        return {
          out_request_no: request.out_request_no,
          status: "pending",
          refunded_fen: null,
          provider_transaction_id: null,
          merchant_reference: null,
          evidence: "refund_query",
        };
      }
      return refundUnknown(
        request,
        failure.kind === "timeout" ? "none" : "refund_query",
      );
    }
    const node = result.value;
    const refundStatus = str(node, "refund_status");
    const refundFee = str(node, "refund_fee");
    const actualFen = refundFee !== null ? tryYuanToFen(refundFee) : null;
    // A successful query is not a successful refund: only the channel's
    // explicit refund-success status is evidence, and the refunded amount
    // must equal the requested one when the channel names it.
    if (refundStatus === "REFUND_SUCCESS") {
      return {
        out_request_no: str(node, "out_request_no") ?? request.out_request_no,
        status:
          actualFen === null ||
          actualFen.toString() === request.refund_amount_fen
            ? "succeeded"
            : "unknown",
        refunded_fen: actualFen !== null ? actualFen.toString() : null,
        provider_transaction_id: str(node, "trade_no"),
        merchant_reference: str(node, "out_trade_no"),
        evidence: "refund_query",
      };
    }
    return {
      out_request_no: str(node, "out_request_no") ?? request.out_request_no,
      status: "pending",
      refunded_fen: actualFen !== null ? actualFen.toString() : null,
      provider_transaction_id: str(node, "trade_no"),
      merchant_reference: str(node, "out_trade_no"),
      evidence: "refund_query",
    };
  }

  async requestStatementAddress(
    billDate: string,
  ): Promise<AlipayStatementAddressResult> {
    const result = await this.gateway.execute<GatewayNode>(
      {
        method: "alipay.data.dataservice.bill.downloadurl.query",
        bizContent: { bill_type: "trade", bill_date: billDate },
      },
      (node) => node,
    );
    if (result.ok) {
      const url = str(result.value, "bill_download_url");
      if (url === null) {
        throw new AlipayProtocolError(
          "alipay bill address response carries no download url",
        );
      }
      return { kind: "address", url };
    }
    const failure = result.failure;
    if (failure.kind === "business_error") {
      const sub = (failure.subCode ?? "").toUpperCase();
      if (sub.includes("NOT_EXIST")) {
        return { kind: "not_generated", sub_code: failure.subCode };
      }
      if (sub.includes("EXPIRE")) {
        return { kind: "expired", sub_code: failure.subCode };
      }
      return { kind: "transient_failure", sub_code: failure.subCode };
    }
    if (failure.kind === "verify_failed") {
      throw new AlipayProtocolError(
        "alipay bill address response failed signature verification",
      );
    }
    return {
      kind: "transient_failure",
      sub_code: null,
      reason: failure.kind,
    };
  }
}

/**
 * Build the signed GET cashier URL the browser is redirected to. Done by the
 * locked SDK's `pageExecute` (see {@link AlipayPaymentAdapterImpl.sdk}); no
 * second builder exists here so the signature rule cannot drift.
 */
