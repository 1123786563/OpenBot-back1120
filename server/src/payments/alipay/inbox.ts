/**
 * The durable alipay notification inbox (#70), backed by real PostgreSQL.
 *
 * The HTTP entry answers the gateway "success" ONLY after this insert has
 * committed; a storage failure is answered "failure" so the gateway retries.
 * A replayed message the table already holds is answered "success" again —
 * at-least-once delivery makes replays normal, and only durable receipt
 * makes them safe. Same identity with DIFFERENT content is an isolation
 * alarm: the message is stored but marked, and no consumer may act on it.
 *
 * Consumers (the order service, #68) read `state = 'inbox'` rows; claiming
 * and business matching belong to them, not to the receiving boundary.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { paymentChannelNotification } from "../../db/schema";
import type { AlipayNotificationView } from "./notification";

export interface AlipayNotifyRecord {
  channel: "alipay";
  appId: string;
  dedupeKey: string;
  payloadDigest: string;
  rawPayloadB64: string;
  view: AlipayNotificationView;
  receivedAtUs: string;
  metadata?: Record<string, string>;
}

export type AlipayNotifyReceipt =
  | { kind: "stored"; id: string }
  | { kind: "duplicate"; id: string }
  | { kind: "isolated"; id: string };

export interface AlipayNotifyInbox {
  /** Durably record one verified notification. Throws on storage failure. */
  record(notification: AlipayNotifyRecord): Promise<AlipayNotifyReceipt>;
  /** True when this exact digest is already durably held under the key. */
  isSameDigest(
    appId: string,
    dedupeKey: string,
    payloadDigest: string,
  ): Promise<boolean>;
}

export function createAlipayNotifyInbox(database: Database): AlipayNotifyInbox {
  return {
    async record(notification) {
      const [existing] = await database
        .select()
        .from(paymentChannelNotification)
        .where(
          and(
            eq(paymentChannelNotification.channel, "alipay"),
            eq(paymentChannelNotification.appId, notification.appId),
            eq(paymentChannelNotification.dedupeKey, notification.dedupeKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.payloadDigest === notification.payloadDigest) {
          // Verified replay of a message already durably held: receipt again.
          return { kind: "duplicate", id: existing.id };
        }
        // Same message identity, different content: store it, but marked so
        // no consumer acts on it, and answer success (the gateway said what
        // it said; the alarm is on the record, not on the retry loop).
        const [row] = await database
          .insert(paymentChannelNotification)
          .values({
            id: randomUUID(),
            channel: "alipay",
            appId: notification.appId,
            dedupeKey: `${notification.dedupeKey}#conflict#${notification.payloadDigest.slice(0, 16)}`,
            payloadDigest: notification.payloadDigest,
            rawPayloadB64: notification.rawPayloadB64,
            tradeNo: notification.view.provider_transaction_id,
            outTradeNo: notification.view.merchant_reference,
            tradeStatus: notification.view.raw_trade_status,
            paidAtUs: notification.view.paid_at_us,
            state: "isolated",
            receivedAtUs: notification.receivedAtUs,
            metadata: notification.metadata ?? null,
          })
          .returning({ id: paymentChannelNotification.id });
        return { kind: "isolated", id: row ? row.id : "" };
      }
      const [row] = await database
        .insert(paymentChannelNotification)
        .values({
          id: randomUUID(),
          channel: "alipay",
          appId: notification.appId,
          dedupeKey: notification.dedupeKey,
          payloadDigest: notification.payloadDigest,
          rawPayloadB64: notification.rawPayloadB64,
          tradeNo: notification.view.provider_transaction_id,
          outTradeNo: notification.view.merchant_reference,
          tradeStatus: notification.view.raw_trade_status,
          paidAtUs: notification.view.paid_at_us,
          state: "inbox",
          receivedAtUs: notification.receivedAtUs,
          metadata: notification.metadata ?? null,
        })
        .returning({ id: paymentChannelNotification.id })
        .catch((error: unknown) => {
          // Lost a concurrent insert of the same identity: the unique
          // constraint decides, and the loser re-reads the winner.
          if (
            typeof error === "object" &&
            error !== null &&
            (error as { code?: string }).code === "23505"
          ) {
            return [];
          }
          throw error;
        });
      if (row) return { kind: "stored", id: row.id };
      const [winner] = await database
        .select()
        .from(paymentChannelNotification)
        .where(
          and(
            eq(paymentChannelNotification.channel, "alipay"),
            eq(paymentChannelNotification.appId, notification.appId),
            eq(paymentChannelNotification.dedupeKey, notification.dedupeKey),
          ),
        )
        .limit(1);
      if (winner && winner.payloadDigest === notification.payloadDigest) {
        return { kind: "duplicate", id: winner.id };
      }
      return {
        kind: "isolated",
        id: winner?.id ?? "",
      };
    },
    async isSameDigest(appId, dedupeKey, payloadDigest) {
      const [existing] = await database
        .select({ digest: paymentChannelNotification.payloadDigest })
        .from(paymentChannelNotification)
        .where(
          and(
            eq(paymentChannelNotification.channel, "alipay"),
            eq(paymentChannelNotification.appId, appId),
            eq(paymentChannelNotification.dedupeKey, dedupeKey),
          ),
        )
        .limit(1);
      return existing?.digest === payloadDigest;
    },
  };
}

/** sha256 hex of the exact raw bytes — the payload digest of record. */
export function alipayNotifyDigest(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}
