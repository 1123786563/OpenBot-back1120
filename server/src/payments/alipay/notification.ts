/**
 * Inbound alipay async notifications (#70).
 *
 * The gateway POSTs an application/x-www-form-urlencoded body whose fields
 * ARE the protocol message. The rules that decide whether it is real:
 *   - the raw body is decoded exactly ONCE (the form decode); a value decoded
 *     twice silently changes bytes and can turn a forged message into a
 *     "matching" one;
 *   - repeated keys are refused outright: the official message has each field
 *     once, and an ambiguous body cannot be verified over any single reading;
 *   - the RSA2 signature is verified over the sorted remaining fields with
 *     both `sign` and `sign_type` removed;
 *   - the trusted configuration decides identity: app_id must equal the
 *     configured application, seller_id (when the gateway sends it) the
 *     configured merchant;
 *   - the channel never states a currency; a message that carries an explicit
 *     non-CNY one is rejected, and a currency-less amount is accepted only in
 *     the domestic-CNY product semantics the configuration stands for;
 *   - amounts are converted yuan->fen exactly and compared to the order
 *     snapshot; a mismatch is isolation, never a payment.
 *
 * Matching against the order snapshot is exported for the order service
 * (#68), which consumes persisted notifications asynchronously — the HTTP
 * entry answers for durable RECEIPT, not for business effect.
 */

import { BillingValueError } from "../../billing-contract/money-time";
import type { ChannelPaymentSnapshot, ChannelTradeStatus } from "../types";
import type { AlipayChannelConfig } from "./config";
import { yuanToFen } from "./money";
import { verifyAlipayNotification } from "./signature";
import { optionalAlipayBeijingTimeToUs } from "./time";

export class AlipayNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlipayNotificationError";
  }
}

/**
 * Decode the raw body exactly once into single-valued fields. Duplicate keys
 * and bodies that are not a well-formed form are refused.
 */
export function parseAlipayNotifyForm(rawBody: string): Record<string, string> {
  if (!rawBody) throw new AlipayNotificationError("empty notify body");
  const params = new URLSearchParams(rawBody);
  const fields: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in fields) {
      throw new AlipayNotificationError(`duplicate notify field ${key}`);
    }
    fields[key] = value;
  }
  return fields;
}

/**
 * The adapter verifies only what the trusted configuration can decide, and
 * returns the OBSERVED facts verbatim. Business matching against the order
 * snapshot is {@link matchNotificationAgainstSnapshot}.
 */
export interface AlipayNotificationView {
  status: ChannelTradeStatus;
  raw_trade_status: string | null;
  provider_transaction_id: string | null;
  merchant_reference: string | null;
  total_amount_fen: string | null;
  paid_at_us: string | null;
  app_id: string | null;
  seller_id: string | null;
  notify_id: string | null;
  notify_type: string | null;
  notify_time: string | null;
}

export function mapAlipayTradeStatus(raw: string | null): ChannelTradeStatus {
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

export function alipayNotificationView(
  fields: Record<string, string>,
): AlipayNotificationView {
  let totalAmountFen: string | null = null;
  const totalAmountRaw = fields.total_amount ?? null;
  if (totalAmountRaw !== null) {
    try {
      totalAmountFen = yuanToFen(totalAmountRaw).toString();
    } catch (error) {
      if (error instanceof BillingValueError) {
        throw new AlipayNotificationError(
          `notify total_amount is not an exact yuan amount: ${JSON.stringify(totalAmountRaw)}`,
        );
      }
      throw error;
    }
  }
  const rawStatus = fields.trade_status ?? null;
  if (rawStatus !== null && mapAlipayTradeStatus(rawStatus) === "unknown") {
    throw new AlipayNotificationError(
      `unrecognized trade_status ${JSON.stringify(rawStatus)}`,
    );
  }
  return {
    status: mapAlipayTradeStatus(rawStatus),
    raw_trade_status: rawStatus,
    provider_transaction_id: fields.trade_no ?? null,
    merchant_reference: fields.out_trade_no ?? null,
    total_amount_fen: totalAmountFen,
    paid_at_us: optionalAlipayBeijingTimeToUs(fields.gmt_payment ?? null),
    app_id: fields.app_id ?? null,
    seller_id: fields.seller_id ?? null,
    notify_id: fields.notify_id ?? null,
    notify_type: fields.notify_type ?? null,
    notify_time: fields.notify_time ?? null,
  };
}

export type AlipayNotificationVerdict =
  | { kind: "verified"; view: AlipayNotificationView }
  | { kind: "rejected"; reason: string };

/**
 * Verify one notification at the receiving boundary: signature first, then
 * application and merchant identity from the trusted configuration. The
 * reason strings are safe to log (no payload content, no amounts).
 */
export function verifyAlipayNotificationFields(
  fields: Record<string, string>,
  config: AlipayChannelConfig,
): AlipayNotificationVerdict {
  if (!verifyAlipayNotification(fields, config.alipayPublicKey)) {
    return { kind: "rejected", reason: "signature_verification_failed" };
  }
  if (fields.app_id !== config.appId) {
    return { kind: "rejected", reason: "app_id_mismatch" };
  }
  if (
    fields.seller_id !== undefined &&
    fields.seller_id !== "" &&
    fields.seller_id !== config.sellerId
  ) {
    return { kind: "rejected", reason: "seller_id_mismatch" };
  }
  const explicitCurrency = fields.currency;
  if (explicitCurrency !== undefined && explicitCurrency !== "CNY") {
    return { kind: "rejected", reason: "currency_mismatch" };
  }
  try {
    return { kind: "verified", view: alipayNotificationView(fields) };
  } catch (error) {
    if (error instanceof AlipayNotificationError) {
      return { kind: "rejected", reason: error.message };
    }
    throw error;
  }
}

export type NotificationMatch =
  | { kind: "matched" }
  | { kind: "mismatched"; reason: "merchant_reference" | "amount" };

/**
 * Business matching for the async consumer: the notification must echo the
 * order snapshot's merchant reference and exact amount. A currency-less
 * amount is accepted under the configuration's domestic-CNY semantics; an
 * explicit non-CNY currency was already refused at verification.
 */
export function matchNotificationAgainstSnapshot(
  view: AlipayNotificationView,
  snapshot: ChannelPaymentSnapshot,
): NotificationMatch {
  if (view.merchant_reference !== snapshot.merchant_reference) {
    return { kind: "mismatched", reason: "merchant_reference" };
  }
  if (view.total_amount_fen !== snapshot.amount_fen) {
    return { kind: "mismatched", reason: "amount" };
  }
  return { kind: "matched" };
}

/**
 * Dedupe identity of a persisted notification. notify_id is the gateway's
 * own message id and the primary key; when a message arrives without one,
 * the fallback binds channel + application + trade + observed status +
 * business time + payload digest, so a LATER status of the same trade is a
 * NEW message (dropping status from the identity would lose it).
 */
export function alipayNotificationIdentity(
  fields: Record<string, string>,
  digest: string,
): {
  notify_id: string | null;
  fallback_key: string;
} {
  const notifyId = fields.notify_id?.trim() || null;
  if (notifyId) return { notify_id: notifyId, fallback_key: "" };
  const fallback = [
    fields.app_id ?? "",
    fields.trade_no ?? "",
    fields.trade_status ?? "",
    fields.gmt_payment ?? "",
    digest,
  ].join("|");
  return { notify_id: null, fallback_key: `notify_id_absent:${fallback}` };
}
