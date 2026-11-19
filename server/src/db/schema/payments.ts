/**
 * Payment channel tables: the durable inbound-notification inbox (#70).
 *
 * Split by owner like every schema file: the payment channel boundary owns
 * this table. Order, payment-attempt and refund tables belong to the billing
 * order service and live elsewhere; nothing here decides a business effect.
 *
 * Why an inbox table at all: the ack ("success") that stops Alipay's retry
 * schedule may only be sent AFTER the raw message is durably persisted, and
 * the business consumer (orders, #68) works asynchronously from that record.
 * A notification answered "success" from memory is a payment nobody can
 * audit after a restart.
 */
import { index, pgTable, text, unique } from "drizzle-orm/pg-core";
import { jsonb } from "./json";

export const paymentChannelNotification = pgTable(
  "payment_channel_notification",
  {
    id: text("id").primaryKey(),
    /** "alipay" / "wechat" — the contract's ChannelName. */
    channel: text("channel").notNull(),
    /** The merchant application the message claims; verified before insert. */
    appId: text("app_id").notNull(),
    /**
     * Message identity. notify_id when the gateway sent one, otherwise the
     * composite fallback (trade + status + business time + payload digest)
     * so a LATER status of the same trade is a NEW message, never swallowed.
     */
    dedupeKey: text("dedupe_key").notNull(),
    /** sha256 of the exact raw body bytes; a same-key different-digest row is an isolation alarm. */
    payloadDigest: text("payload_digest").notNull(),
    /** The exact raw request body, base64; never re-serialized. */
    rawPayloadB64: text("raw_payload_b64").notNull(),
    tradeNo: text("trade_no"),
    outTradeNo: text("out_trade_no"),
    /** The channel's own status word, verbatim. */
    tradeStatus: text("trade_status"),
    /** Channel payment time as a contract UTC microsecond instant, or null. */
    paidAtUs: text("paid_at_us"),
    /** "inbox" until a consumer claims it, "isolated" on an identity conflict. */
    state: text("state").notNull(),
    /** Contract UTC microsecond instant of receipt. */
    receivedAtUs: text("received_at_us").notNull(),
    /** Free-form verification metadata the receiver recorded (never secrets). */
    metadata: jsonb("metadata"),
  },
  (t) => [
    unique("payment_channel_notification_identity").on(
      t.channel,
      t.appId,
      t.dedupeKey,
    ),
    index("payment_channel_notification_state_idx").on(t.state, t.receivedAtUs),
  ],
);
