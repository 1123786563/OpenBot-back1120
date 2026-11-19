/**
 * Production payment-channel adapter surface (#69/#70), shared by every
 * channel. The order/refund services (#68/#71) consume these types; the
 * channel modules implement them. Nothing here is a business state machine:
 * adapters report OBSERVED channel facts and never decide entitlement.
 */

/** Channel names matching the billing contract's ChannelName enum. */
export type PaymentChannel = "wechat" | "alipay";

/**
 * How the alipay web cashier is opened. `pc` is the desktop website payment
 * product (alipay.trade.page.pay), `wap` the mobile website product
 * (alipay.trade.wap.pay). Chosen by an explicit user entry point, never by
 * sniffing the User-Agent.
 */
export type AlipayWebsiteMode = "pc" | "wap";

/**
 * A trusted snapshot of the local order/payment attempt. Adapters receive it
 * from the order service, never from the browser: the amount and merchant
 * reference here are what the channel MUST echo, not what a caller claims.
 */
export interface ChannelPaymentSnapshot {
  /** out_trade_no — the channel-side merchant reference of this attempt. */
  merchant_reference: string;
  /** Integer fen string, exact per the billing contract. */
  amount_fen: string;
  currency: "CNY";
  /** Order expiry as a contract microsecond instant; links never outlive it. */
  expires_at_us: string;
}

/** The action a client performs to open the channel cashier. */
export interface ChannelPaymentLink {
  action_type: "redirect_url";
  /** The signed channel URL. Never truncated to fit any length limit. */
  value: string;
}

/** Canonical trade status mapped from channel facts. */
export type ChannelTradeStatus = "pending" | "succeeded" | "closed" | "unknown";

/** Where an observation's facts came from. Unknown fields stay null — an
 * adapter never fills a gap with the time it happened to look. */
export type ObservationEvidence = "notify" | "query" | "close" | "none";

export interface ChannelTradeObservation {
  status: ChannelTradeStatus;
  /** The channel's own status word (e.g. WAIT_BUYER_PAY), kept verbatim. */
  raw_trade_status: string | null;
  provider_transaction_id: string | null;
  merchant_reference: string | null;
  total_amount_fen: string | null;
  /** Channel-provided payment time as a UTC microsecond instant, or null. */
  paid_at_us: string | null;
  currency: "CNY" | null;
  evidence: ObservationEvidence;
}

/**
 * Refund request identity. `(merchant app, out_request_no)` is the channel's
 * refund idempotency key: retries MUST reuse the original out_request_no, and
 * the caller (#71) persists its immutable binding to the trade and amount
 * BEFORE the adapter is invoked.
 */
export interface ChannelRefundRequest {
  merchant_reference: string;
  /** The trade returned by this provider transaction id, or the reference. */
  provider_transaction_id: string | null;
  /** The persisted refund request number. Never regenerated on retry. */
  out_request_no: string;
  refund_amount_fen: string;
}

export type ChannelRefundStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "unknown";

export interface ChannelRefundObservation {
  out_request_no: string;
  status: ChannelRefundStatus;
  /** Actual refunded amount in fen, when the channel evidenced it. */
  refunded_fen: string | null;
  provider_transaction_id: string | null;
  merchant_reference: string | null;
  evidence: "refund_call" | "refund_query" | "none";
}

/** Which direction a statement row moves money. */
export type StatementDirection = "pay" | "refund";

export interface StatementRow {
  merchant_reference: string | null;
  provider_transaction_id: string | null;
  /** The refund request identifier the row carries, or null when absent. */
  refund_request_no: string | null;
  direction: StatementDirection;
  amount_fen: string;
  occurred_at_us: string;
  /** Beijing calendar date the bill was requested for (YYYY-MM-DD). */
  bill_date: string;
  /** Name of the file inside the bill archive the row came from. */
  source_file: string;
  /** 1-based line number inside that file's CSV data. */
  source_line: number;
}

/** Identity of one downloaded statement archive. */
export interface StatementDigest {
  bill_date: string;
  /** sha256 of the downloaded bytes; lets a human re-verify the source. */
  sha256: string;
  row_count: number;
}
