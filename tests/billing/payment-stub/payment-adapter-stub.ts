/**
 * The ONLY payment-channel substitute allowed by #62 (requirement §7).
 *
 * Boundary: everything below replaces exactly the external PaymentAdapter
 * surface — create / query / close / refund / queryRefund / downloadStatement
 * plus raw inbound notifications. The order service, idempotency, review,
 * freezing, ledger entries and outbox stay REAL; the stub only simulates the
 * channel TRANSPORT with scriptable outcomes. Signature verification logic
 * stays real (HMAC-SHA256 over the raw payload with per-run test keys) so the
 * forged-callback case is genuinely exercised, and the production tickets
 * (#69/#70/#72) later swap this stub for the WeChat/Alipay protocols without
 * touching any business code — no "payment already succeeded" shortcut may
 * ever exist outside this file.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type Channel = "wechat" | "alipay";

export interface CreatePaymentInput {
  order_id: string;
  merchant_reference: string;
  amount_fen: string;
  currency: "CNY";
  scenario: "h5" | "native" | "jsapi";
  return_url: string;
}
export interface PaymentLink {
  action_type: "redirect_url" | "qrcode_content";
  value: string;
  expires_at_us: string;
}

export interface ChannelPaymentState {
  status: "pending" | "succeeded" | "failed" | "closed" | "unknown";
  provider_transaction_id: string | null;
  provider_paid_at_us: string | null;
}

export interface RawNotification {
  channel: Channel;
  raw_payload_b64: string;
  protocol_metadata: Record<string, string>;
}

/** Scriptable outcomes the tests may request from the stub. */
export type ScriptedOutcome =
  | "succeed"
  | "fail"
  | "unknown" // channel cannot decide right now
  | "timeout" // adapter call hangs / no answer
  | "merchant_mismatch" // notification for a different merchant order
  | "amount_mismatch" // notification amount differs from the order
  | "lost_notification" // channel never notifies; only query reveals state
  | "out_of_order" // success notification arrives before create
  | "duplicate_notification"
  | "bad_signature"; // signed with the wrong key (forged callback)

export interface PaymentAdapter {
  create(input: CreatePaymentInput): Promise<PaymentLink>;
  query(merchantReference: string): Promise<ChannelPaymentState>;
  close(merchantReference: string): Promise<ChannelPaymentState>;
  refund(
    merchantReference: string,
    amountFen: string,
  ): Promise<{
    provider_refund_reference: string;
    status: "pending" | "succeeded" | "failed" | "unknown";
  }>;
  queryRefund(
    providerRefundReference: string,
  ): Promise<{ status: "pending" | "succeeded" | "failed" | "unknown" }>;
  downloadStatement(
    periodId: string,
  ): Promise<{ period_id: string; rows: unknown[] }>;
}

/** Real (non-stubbed) signature logic used by both stub and production tickets. */
export function signPayload(
  rawPayload: string,
  key: string,
  timestamp: string,
  nonce: string,
): string {
  return createHmac("sha256", key)
    .update(`${timestamp}\n${nonce}\n${rawPayload}`)
    .digest("base64");
}

export function verifySignature(
  rawPayload: string,
  key: string,
  metadata: Record<string, string>,
): boolean {
  const timestamp = metadata["X-Channel-Timestamp"];
  const nonce = metadata["X-Channel-Nonce"];
  const signature = metadata["X-Channel-Signature"];
  if (!timestamp || !nonce || !signature) return false;
  const expected = signPayload(rawPayload, key, timestamp, nonce);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Scriptable PaymentAdapter. One instance per test; scenarios are queued per
 * merchant reference and consumed by the corresponding adapter call.
 */
export class ScriptedPaymentStub implements PaymentAdapter {
  readonly notifications: RawNotification[] = [];
  private state = new Map<string, ChannelPaymentState>();
  private refunds = new Map<
    string,
    {
      provider_refund_reference: string;
      status: "pending" | "succeeded" | "failed" | "unknown";
    }
  >();
  private refundSeq = 0;
  private txnSeq = 0;

  constructor(
    private readonly testKey: string,
    private readonly scripts: Map<string, ScriptedOutcome> = new Map(),
  ) {}

  private outcome(merchantReference: string): ScriptedOutcome {
    return this.scripts.get(merchantReference) ?? "succeed";
  }

  async create(input: CreatePaymentInput): Promise<PaymentLink> {
    const outcome = this.outcome(input.merchant_reference);
    if (outcome === "timeout") {
      await new Promise(() => {}); // never resolves; caller must apply its own timeout policy
    }
    if (outcome === "fail") {
      this.state.set(input.merchant_reference, {
        status: "failed",
        provider_transaction_id: null,
        provider_paid_at_us: null,
      });
      throw new Error(
        `channel rejected create for ${input.merchant_reference}`,
      );
    }
    if (outcome === "out_of_order") {
      // success notification fires BEFORE create even returns
      this.markSucceeded(input);
      this.pushNotification(input, "duplicate_notification");
    }
    if (outcome === "lost_notification") {
      // state becomes succeeded silently; no notification is ever pushed
      this.markSucceeded(input);
    }
    if (
      outcome === "succeed" ||
      outcome === "amount_mismatch" ||
      outcome === "merchant_mismatch"
    ) {
      this.markSucceeded(input);
      this.pushNotification(
        input,
        outcome === "succeed" ? "duplicate_notification" : outcome,
      );
    }
    // fail/timeout already handled; all other outcomes leave pending state
    if (!this.state.has(input.merchant_reference)) {
      this.state.set(input.merchant_reference, {
        status: "pending",
        provider_transaction_id: null,
        provider_paid_at_us: null,
      });
    }
    return {
      action_type:
        input.scenario === "native" ? "qrcode_content" : "redirect_url",
      value: `https://channel.invalid/pay/${encodeURIComponent(input.merchant_reference)}`,
      expires_at_us: "1700002250000000",
    };
  }

  private markSucceeded(input: CreatePaymentInput): void {
    this.txnSeq++;
    this.state.set(input.merchant_reference, {
      status: "succeeded",
      provider_transaction_id: `txn_${this.txnSeq.toString().padStart(8, "0")}`,
      provider_paid_at_us: "1700000460000000",
    });
  }

  /** Push a raw notification (the only inbound surface of the stub). */
  pushNotification(input: CreatePaymentInput, variant: ScriptedOutcome): void {
    const body: Record<string, unknown> = {
      merchant_reference:
        variant === "merchant_mismatch"
          ? "other_order_reference"
          : input.merchant_reference,
      amount_fen: variant === "amount_mismatch" ? "1" : input.amount_fen,
      currency: input.currency,
      status: "succeeded",
    };
    const raw = JSON.stringify(body);
    const timestamp = "1700000460";
    const nonce = `n${this.txnSeq}`;
    const key =
      variant === "bad_signature" ? `${this.testKey}-forged` : this.testKey;
    this.notifications.push({
      channel: "wechat",
      raw_payload_b64: Buffer.from(raw).toString("base64"),
      protocol_metadata: {
        "X-Channel-Timestamp": timestamp,
        "X-Channel-Nonce": nonce,
        "X-Channel-Signature": signPayload(raw, key, timestamp, nonce),
      },
    });
  }

  async query(merchantReference: string): Promise<ChannelPaymentState> {
    const outcome = this.outcome(merchantReference);
    if (outcome === "unknown")
      return {
        status: "unknown",
        provider_transaction_id: null,
        provider_paid_at_us: null,
      };
    if (outcome === "timeout") await new Promise(() => {});
    return (
      this.state.get(merchantReference) ?? {
        status: "pending",
        provider_transaction_id: null,
        provider_paid_at_us: null,
      }
    );
  }

  async close(merchantReference: string): Promise<ChannelPaymentState> {
    const current = this.state.get(merchantReference);
    if (current?.status === "succeeded") return current; // close race: channel refuses to close a paid order
    this.state.set(merchantReference, {
      status: "closed",
      provider_transaction_id: null,
      provider_paid_at_us: null,
    });
    return this.state.get(merchantReference) as ChannelPaymentState;
  }

  async refund(
    merchantReference: string,
    amountFen: string,
  ): Promise<{
    provider_refund_reference: string;
    status: "pending" | "succeeded" | "failed" | "unknown";
  }> {
    const paid = this.state.get(merchantReference);
    if (paid?.status !== "succeeded")
      throw new Error(`cannot refund unpaid order ${merchantReference}`);
    const outcome = this.outcome(`${merchantReference}:refund`);
    this.refundSeq++;
    const reference = `ref_${this.refundSeq.toString().padStart(8, "0")}`;
    const status =
      outcome === "fail"
        ? "failed"
        : outcome === "unknown"
          ? "unknown"
          : "succeeded";
    this.refunds.set(reference, {
      provider_refund_reference: reference,
      status,
    });
    void amountFen; // the channel echoes the amount; mismatching refunds fail upstream
    return { provider_refund_reference: reference, status };
  }

  async queryRefund(
    providerRefundReference: string,
  ): Promise<{ status: "pending" | "succeeded" | "failed" | "unknown" }> {
    const found = this.refunds.get(providerRefundReference);
    if (!found)
      throw new Error(`unknown refund reference ${providerRefundReference}`);
    return { status: found.status === "unknown" ? "unknown" : found.status };
  }

  async downloadStatement(
    periodId: string,
  ): Promise<{ period_id: string; rows: unknown[] }> {
    return { period_id: periodId, rows: [] };
  }
}

/** Expected verdicts of the REAL verification logic against stub notifications. */
export function verifyNotification(
  raw: RawNotification,
  key: string,
): "valid" | "bad_signature" {
  const rawPayload = Buffer.from(raw.raw_payload_b64, "base64").toString(
    "utf8",
  );
  return verifySignature(rawPayload, key, raw.protocol_metadata)
    ? "valid"
    : "bad_signature";
}
