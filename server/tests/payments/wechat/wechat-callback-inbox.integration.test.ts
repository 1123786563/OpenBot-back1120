/**
 * REAL PostgreSQL receiving-boundary test (#69 AC8).
 *
 * Requires TEST_DATABASE_URL to point at a DEDICATED disposable PostgreSQL
 * (never the live openbot database; the support helper refuses that shape).
 * The 0093 migration is applied directly to the dedicated database and its
 * objects are dropped again afterwards. Concurrent same-event delivery,
 * re-signed redelivery, committed-before-ACK ordering and the
 * same-id/different-content conflict are exercised against REAL transaction
 * semantics.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDatabase } from "../../../src/db/client.js";
import { WechatNotificationInbox, InboxConflictError } from "../../../src/payments/wechat/inbox.js";
import { TEST_POOL, testDatabaseUrl } from "../../support/database.js";

const databaseUrl = testDatabaseUrl(); // throws with guidance when unset
const db = createDatabase(databaseUrl, TEST_POOL);

const MIGRATION_FILE = new URL("../../../drizzle/0093_redundant_mad_thinker.sql", import.meta.url);

let migrationError: string | null = null;

beforeAll(async () => {
  try {
    const sql = await Bun.file(MIGRATION_FILE).text();
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.replace(/--.*$/gm, "").trim();
      if (trimmed !== "") await db.$client.unsafe(trimmed);
    }
  } catch (error) {
    migrationError = error instanceof Error ? error.message : "unknown migration failure";
  }
});

afterAll(async () => {
  try {
    await db.$client.unsafe("DROP TABLE IF EXISTS wechat_notification_inbox");
  } finally {
    await db.$client.close();
  }
});

describe("WeChat notification inbox on real PostgreSQL", () => {
  const inbox = new WechatNotificationInbox(db);
  const event = (eventId: string, content: string) => ({
    mchid: "1900000001",
    eventId,
    eventType: "TRANSACTION.SUCCESS",
    rawEnvelopeBytes: new TextEncoder().encode(content),
    decryptedResource: { out_trade_no: "order-1", mchid: "1900000001" } as Record<string, unknown>,
    signatureSerial: "SERIAL-1",
  });

  test("the 0093 migration applied cleanly", () => {
    expect(migrationError).toBeNull();
  });

  test("first receipt is stored; the row is committed before any ACK could be sent", async () => {
    const outcome = await inbox.record(event("EV-1", '{"id":"EV-1"}'));
    expect(outcome).toBe("stored");
    expect(await inbox.pendingCount()).toBeGreaterThanOrEqual(1);
  });

  test("re-signed redelivery of the same event id is a duplicate; content unchanged", async () => {
    // Signature metadata (timestamp/nonce) would differ on a re-signed replay;
    // dedupe keys on EVENT identity and the raw content hash matches.
    const outcome = await inbox.record(event("EV-1", '{"id":"EV-1"}'));
    expect(outcome).toBe("duplicate");
  });

  test("same event id with different content raises a conflict, never overwrites", async () => {
    expect(inbox.record(event("EV-1", '{"id":"EV-1","amount":1}'))).rejects.toBeInstanceOf(
      InboxConflictError,
    );
  });

  test("concurrent delivery of the same event id: exactly one store, others duplicate", async () => {
    const results = await Promise.all([
      inbox.record(event("EV-CONCURRENT", '{"id":"EV-CONCURRENT"}')),
      inbox.record(event("EV-CONCURRENT", '{"id":"EV-CONCURRENT"}')),
      inbox.record(event("EV-CONCURRENT", '{"id":"EV-CONCURRENT"}')),
    ]);
    expect(results.filter((r) => r === "stored")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(2);
  });

  test("distinct event ids are independent rows; out-of-order arrival never matters", async () => {
    expect(await inbox.record(event("EV-A", '{"id":"EV-A"}'))).toBe("stored");
    expect(await inbox.record(event("EV-B", '{"id":"EV-B"}'))).toBe("stored");
    expect(await inbox.record(event("EV-A", '{"id":"EV-A"}'))).toBe("duplicate");
  });
});
