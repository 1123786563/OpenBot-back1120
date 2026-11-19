/**
 * PostgreSQL persistence for verified WeChat notifications (#69).
 *
 * The ACK discipline lives here: the insert commits (or not) in ONE
 * transaction, and only a committed insert says "received". A re-delivered
 * event finds the committed row (duplicate → confirm, empty-body 200), the
 * same event id with DIFFERENT content is a conflict that alarms and refuses
 * to overwrite, and a storage failure returns an error so WeChat retries.
 * Dedupe rows are kept far beyond the official re-delivery window — retention
 * is a financial fact policy, not a cache policy.
 */

import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { wechatNotificationInbox } from "../../db/schema/billing.js";

/** Conflict is a thrown InboxConflictError, never a returned value. */
export type InboxRecordOutcome = "stored" | "duplicate";

export interface InboxEvent {
  readonly mchid: string;
  readonly eventId: string;
  readonly eventType: string;
  /** Exact verified raw envelope bytes; only their SHA-256 is stored. */
  readonly rawEnvelopeBytes: Uint8Array;
  readonly decryptedResource: Record<string, unknown>;
  readonly signatureSerial: string;
}

export function inboxContentHash(rawEnvelopeBytes: Uint8Array): string {
  return createHash("sha256").update(rawEnvelopeBytes).digest("hex");
}

export class WechatNotificationInbox {
  constructor(private readonly db: Database) {}

  /**
   * Record one verified event. Concurrent delivery of the same event id:
   * exactly one insert wins, the loser reads the committed row and confirms
   * (duplicate) — or alarms (conflict) when the content differs.
   */
  async record(event: InboxEvent): Promise<InboxRecordOutcome> {
    const contentHash = inboxContentHash(event.rawEnvelopeBytes);
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(wechatNotificationInbox)
        .values({
          mchid: event.mchid,
          eventId: event.eventId,
          eventType: event.eventType,
          contentHash,
          decryptedResource: JSON.stringify(event.decryptedResource),
          signatureSerial: event.signatureSerial,
          state: "received",
        })
        .onConflictDoNothing()
        .returning({ id: wechatNotificationInbox.id });
      if (inserted.length > 0) return "stored" as const;
      // Lost the insert race: read what committed and compare CONTENT.
      const [existing] = await tx
        .select({ contentHash: wechatNotificationInbox.contentHash })
        .from(wechatNotificationInbox)
        .where(
          sql`${wechatNotificationInbox.channel} = 'wechat' and ${wechatNotificationInbox.mchid} = ${event.mchid} and ${wechatNotificationInbox.eventId} = ${event.eventId}`,
        );
      if (!existing) {
        // Row vanished between conflict and read (retention job): treat as stored retry.
        return "stored" as const;
      }
      if (existing.contentHash !== contentHash) {
        throw new InboxConflictError(
          `notification ${event.eventId.slice(0, 8)}… redelivered with different content for merchant ${event.mchid.slice(0, 4)}…`,
        );
      }
      return "duplicate" as const;
    });
  }

  /** Alarm-surfaced count of rows still pending processing (ops/monitoring). */
  async pendingCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(wechatNotificationInbox)
      .where(eq(wechatNotificationInbox.state, "received"));
    return row?.count ?? 0;
  }
}

export class InboxConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxConflictError";
  }
}
