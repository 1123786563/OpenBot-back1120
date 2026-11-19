import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Durable receiving boundary for verified WeChat Pay notifications (#69).
 *
 * One row per (channel, mchid, event_id). The row is committed in the same
 * transaction that decides the ACK, so the channel never receives a success
 * receipt before the event survives a crash — and a re-delivered event finds
 * its committed row and is confirmed without reprocessing. Rows are retained
 * well beyond the official re-delivery window; dedupe is by EVENT identity,
 * never by signature, nonce or timestamp (a re-signed replay is the same
 * event). `content_hash` detects the conflict case: same id, different
 * content is an alarm, never an overwrite. Business consumers keep their own
 * idempotency by trade/refund identity; nothing here fulfils an order or
 * touches the credit ledger.
 */
export const wechatNotificationInbox = pgTable(
  "wechat_notification_inbox",
  {
    id: bigint("id", { mode: "bigint" })
      .generatedByDefaultAsIdentity()
      .primaryKey(),
    channel: text("channel").notNull().default("wechat"),
    mchid: text("mchid").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    /** SHA-256 of the exact verified raw envelope bytes. */
    contentHash: text("content_hash").notNull(),
    /** The decrypted, structure-checked resource payload (minimal verified event). */
    decryptedResource: text("decrypted_resource").notNull(),
    /** received | pending_processing | consumed | failed */
    state: text("state").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    signatureSerial: text("signature_serial").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("wechat_inbox_event_unique").on(
      table.channel,
      table.mchid,
      table.eventId,
    ),
    index("wechat_inbox_received_at_idx").on(table.receivedAt),
  ],
);
