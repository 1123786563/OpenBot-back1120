/**
 * WeChat Pay direct-merchant API v3 adapter contracts (#69).
 *
 * Frozen protocol base (verified 2026-11-19, official docs at
 * https://pay.wechatpay.cn/doc/v3/merchant/*, Go SDK v0.2.21 used as signing
 * reference only — no runtime SDK dependency). The adapter REPORTS channel
 * facts; it never fulfils an order, never mints credits and never schedules
 * reconciliation. Every result is a discriminated union so a caller can never
 * confuse "the channel answered" with "the channel says money moved", and a
 * network fault can never surface as a business failure.
 *
 * Exact money/time discipline reuses server/src/billing-contract/money-time.ts:
 * amounts are integer fen as BigInt, instants are microsecond contract strings
 * (decimal, no floats). WeChat JSON integers are converted ONLY when they are
 * safe integers inside the official value ranges; anything else is rejected.
 */

import {
  BillingValueError,
  parseTimestampUs,
} from "../../billing-contract/money-time.js";

export { parseTimestampUs };

export type WechatScenario = "native" | "h5";

/** Official API v3 base. The controlled test peer replaces exactly this. */
export const WECHAT_API_BASE = "https://api.mch.weixin.qq.com";

/** Official notification signature clock window: ±300 seconds, inclusive. */
export const WECHAT_TIMESTAMP_SKEW_SEC = 300n;

export interface MerchantIdentity {
  /** 商户号 mchid. */
  readonly mchid: string;
  /** 应用 appid the payment attempt is bound to. */
  readonly appid: string;
  /** Merchant API certificate serial (Authorization serial_no). */
  readonly merchantSerial: string;
}

export interface CreatePaymentInput {
  readonly identity: MerchantIdentity;
  readonly outTradeNo: string;
  readonly description: string;
  /** Exact integer fen (contract decimal discipline, BigInt). */
  readonly amountFen: bigint;
  readonly currency: "CNY";
  /** Absolute business order deadline (microsecond contract string). */
  readonly orderExpiresAtUs: bigint;
  /** Our verified notification entry point, sent as notify_url. */
  readonly notifyUrl: string;
  readonly scenario: WechatScenario;
  /** H5 only: client IP resolved by a TRUSTED server-side proxy. */
  readonly h5?: { readonly payerClientIp: string };
}

/**
 * One payment action the cashier may present. `actionExpiresAtUs` never
 * crosses `orderExpiresAtUs`: the H5 link's official 5-minute life and the
 * 30-minute order deadline are separate values and separately enforced.
 */
export type PaymentActionResult =
  | {
      readonly kind: "action";
      readonly actionType: "code_url" | "h5_url";
      readonly value: string;
      readonly actionExpiresAtUs: string;
      readonly orderExpiresAtUs: string;
      readonly outTradeNo: string;
    }
  /** Terminal channel state or expired order: refresh refused. */
  | {
      readonly kind: "rejected";
      readonly reason:
        | "order_expired"
        | "terminal_payment_state"
        | "amount_or_identity_changed";
      readonly detail?: string;
    }
  /** Transport failure or untrusted answer: unknown, never a business result. */
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly retryable: boolean;
    };

/**
 * A payment fact the channel has VERIFIED (signed response or verified
 * notification), with every field the order service needs to re-check
 * merchant, application, order, amount, currency, channel transaction and the
 * actual payment instant. No field may be absent or inconsistent here; those
 * cases degrade to `identity_mismatch` / `unknown`, never to a payment.
 */
export interface VerifiedPaymentFact {
  readonly mchid: string;
  readonly appid: string;
  readonly outTradeNo: string;
  readonly transactionId: string;
  /** 交易总额 amount.total — the number the order service must match. */
  readonly totalFen: bigint;
  /** 用户实付 amount.payer_total, when present; separate semantics, never a substitute. */
  readonly payerFen: bigint | null;
  readonly currency: "CNY";
  readonly successTimeUs: bigint;
  /** "query" (signed API response) or "notification" (verified + decrypted event). */
  readonly source: "query" | "notification";
}

export type QueryPaymentResult =
  | { readonly kind: "verified_payment"; readonly fact: VerifiedPaymentFact }
  | { readonly kind: "pending" }
  | { readonly kind: "closed" }
  | { readonly kind: "not_found" }
  /** Channel answered, but fields contradict our stored attempt or are illegal. */
  | { readonly kind: "identity_mismatch"; readonly reason: string }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly retryable: boolean;
    };

export type ClosePaymentResult =
  | { readonly kind: "closed" }
  /** Official 204 never arrived or channel answered ambiguously: ask queryPayment. */
  | { readonly kind: "indeterminate_paid"; readonly reason: string }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly retryable: boolean;
    };

export type CreateRefundResult =
  | {
      readonly kind: "accepted";
      readonly outRefundNo: string;
      readonly refundId: string | null;
      /** Channel state at acceptance time (PROCESSING usually; may already be SUCCESS). */
      readonly channelStatus: string;
    }
  | { readonly kind: "rejected"; readonly reason: string }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly retryable: boolean;
    };

/**
 * Refund verdicts. `abnormal` keeps the channel's ABNORMAL state for a human:
 * it never asserts money returned, and never asserts no money is in flight.
 */
export type QueryRefundResult =
  | {
      readonly kind: "refund";
      readonly outRefundNo: string;
      readonly refundId: string | null;
      readonly outTradeNo: string;
      readonly refundFen: bigint;
      readonly currency: "CNY";
      readonly status:
        | "accepted"
        | "processing"
        | "succeeded"
        | "failed"
        | "abnormal";
      /** Raw channel state preserved verbatim for humans (e.g. ABNORMAL). */
      readonly channelState: string;
      readonly successTimeUs: bigint | null;
      readonly source: "query" | "notification";
    }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly retryable: boolean;
    };

export type TradeBillKind = "ALL" | "SUCCESS" | "REFUND";

export interface TradeBillRequest {
  readonly identity: MerchantIdentity;
  /** YYYYMMDD bill date. */
  readonly billDate: string;
  readonly billType: TradeBillKind;
}

/** A download-verified bill artifact; no partial file is ever published. */
export interface TradeBillArtifact {
  readonly mchid: string;
  readonly billDate: string;
  readonly billType: TradeBillKind;
  /** Absolute path of the atomically published, SHA1-verified file. */
  readonly publishedPath: string;
  readonly sha1: string;
  readonly byteLength: number;
}

export type TradeBillResult =
  | { readonly kind: "bill"; readonly artifact: TradeBillArtifact }
  | { readonly kind: "generating" }
  | { readonly kind: "no_bill" }
  /** Recoverable failure: rerun of the same (merchant, date, type) resumes. */
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly retryable: boolean;
    };

export interface WechatNotificationResource {
  readonly algorithm: string;
  readonly ciphertext: string;
  readonly associatedData: string | null;
  readonly nonce: string;
  readonly originalType: string | null;
}

export interface VerifiedNotification {
  /** Stable event identity (Wechatpay notification `id`). */
  readonly eventId: string;
  readonly eventType: string;
  readonly resource: WechatNotificationResource;
  /** Decrypted, structure-checked resource payload (parsed JSON object). */
  readonly decrypted: Record<string, unknown>;
  readonly eventTimeUs: bigint | null;
}

export type NotificationVerification =
  | { readonly kind: "verified"; readonly notification: VerifiedNotification }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "bad_request"
        | "timestamp_out_of_window"
        | "unknown_serial"
        | "bad_signature"
        | "unknown_algorithm"
        | "bad_gcm"
        | "bad_structure";
      readonly detail?: string;
    };

// ---------------------------------------------------------------------------
// Exact conversions between WeChat JSON integers and contract values.
// ---------------------------------------------------------------------------

/** Official amount.total upper bound is 100_000_000 fen (1M CNY); keep a safe margin. */
const MAX_OFFICIAL_FEN = 1_000_000_000n;

/** Parse WeChat's JSON integer fen into exact BigInt, rejecting unsafe values. */
export function parseWechatFen(value: unknown, field: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BillingValueError(
      "invalid_integer",
      `${field} is not a non-negative safe integer`,
    );
  }
  const v = BigInt(value);
  if (v > MAX_OFFICIAL_FEN) {
    throw new BillingValueError(
      "out_of_range",
      `${field} exceeds official range`,
    );
  }
  return v;
}

/** Serialize our exact fen BigInt into the JSON integer WeChat requires. */
export function toWechatJsonFen(fen: bigint, field: string): number {
  if (
    fen < 0n ||
    fen > MAX_OFFICIAL_FEN ||
    fen > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new BillingValueError(
      "out_of_range",
      `${field} is outside the safe JSON range`,
    );
  }
  return Number(fen);
}

/** Parse WeChat's RFC 3339 instant ("2018-06-08T10:34:56+08:00") into exact microseconds. */
export function parseWechatTimeUs(value: unknown, field: string): bigint {
  if (typeof value !== "string") {
    throw new BillingValueError(
      "invalid_integer",
      `${field} is not a string instant`,
    );
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    throw new BillingValueError("invalid_integer", `${field} is not RFC 3339`);
  }
  return parseTimestampUs((BigInt(epochMs) * 1000n).toString());
}

/** Contract microsecond string -> integer seconds for signature timestamps. */
export function contractUsToUnixSeconds(us: string): bigint {
  return parseTimestampUs(us) / 1_000_000n;
}
