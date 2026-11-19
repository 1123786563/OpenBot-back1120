/**
 * #64 credit-ledger persistence model — isolated `billing` schema.
 *
 * Ownership and integrity live in the DATABASE, not in process locks: every
 * account-owned object carries (organization_id, account_id) plus a composite
 * unique key and composite foreign keys, so a cross-account reference is
 * refused by PostgreSQL even if application code were wrong. Conservation
 * (granted = available + reserved + refund_frozen + consumed + expired +
 * revoked, every term non-negative) is a CHECK constraint. Money and time are
 * PostgreSQL bigint and BigInt in the application — never a JS number.
 *
 * Roles: migrations run as the database OWNER; the ledger service connects as
 * the restricted runtime role created by `server/scripts/billing-migrate.ts`
 * (no UPDATE/DELETE on the append-only objects — enforced again by the
 * immutability triggers installed by that script, so history cannot be
 * rewritten silently by any role).
 *
 * References:
 *   - contracts/billing/schemas/objects.yaml (CreditLot, LedgerEvent,
 *     Adjustment, OutboxRecord — the single API fact source)
 *   - docs/adr/0003-openbot-ledger-lago-billing.md (one ledger, atomic outbox)
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const billing = pgSchema("billing");

/**
 * Microsecond instants and microcredit amounts as bigint columns.
 * `mode: "bigint"` keeps them exact in the application; JSON serialization is
 * a decimal STRING at the route boundary (never a JSON number).
 */
const micros = (name: string) => bigint(name, { mode: "bigint" });

/** Immutable payload JSON: values are decimal strings written from BigInt. */
const payload = (name: string) =>
  jsonb(name).notNull().$type<Record<string, unknown>>();

// --------------------------------------------------------------------- account
/**
 * One personal payment account per stable subject and per Personal Workspace,
 * enforced by global UNIQUEs (concurrent registration still yields exactly
 * one row). Identity comes from the trusted registration entry — never from
 * email or client payer claims. A closed account keeps its history and its
 * identity is never reused.
 */
export const account = billing.table(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ownerSubjectId: text("owner_subject_id").notNull(),
    personalWorkspaceId: text("personal_workspace_id").notNull(),
    status: text("status").notNull().default("active"),
    revision: micros("revision").notNull().default(sql`1`),
    createdAtUs: micros("created_at_us").notNull(),
    updatedAtUs: micros("updated_at_us").notNull(),
  },
  (t) => [
    unique("billing_account_owner_uq").on(t.ownerSubjectId),
    unique("billing_account_workspace_uq").on(t.personalWorkspaceId),
    // The composite key every account-owned object's foreign key points at.
    unique("billing_account_org_id_uq").on(t.organizationId, t.id),
    check(
      "billing_account_status_check",
      sql`${t.status} IN ('active', 'suspended', 'closed')`,
    ),
  ],
);

// ---------------------------------------------------------------- ledger_event
/**
 * Immutable event head: one grant / adjustment / expiry fact. account_seq is
 * the per-account commit sequence, allocated inside the account lock — never
 * a global database sequence, and the recovery watermark for delivery (#73).
 */
export const ledgerEvent = billing.table(
  "ledger_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    accountId: uuid("account_id").notNull(),
    eventType: text("event_type").notNull(),
    accountSeq: micros("account_seq").notNull(),
    sourceNamespace: text("source_namespace"),
    sourceEventId: text("source_event_id"),
    adjustmentId: uuid("adjustment_id"),
    actorSubjectId: text("actor_subject_id"),
    reason: text("reason"),
    originalPeriodId: text("original_period_id"),
    occurredAtUs: micros("occurred_at_us").notNull(),
    committedAtUs: micros("committed_at_us").notNull(),
  },
  (t) => [
    unique("billing_ledger_event_org_account_id_uq").on(
      t.organizationId,
      t.accountId,
      t.id,
    ),
    unique("billing_ledger_event_account_seq_uq").on(
      t.accountId,
      t.accountSeq,
    ),
    check(
      "billing_ledger_event_type_check",
      sql`${t.eventType} IN ('credit.granted', 'credit.adjusted', 'credit.expired')`,
    ),
    foreignKey({
      name: "billing_ledger_event_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [account.organizationId, account.id],
    }),
  ],
);

// -------------------------------------------------------------- business_event
/**
 * The trusted business identity of an external grant: (source_namespace,
 * source_event_id) binds ONCE to the account, amount, period and validity.
 * The unique key deliberately excludes account/amount/period — replaying the
 * same business key through a different account or amount lands on this row
 * and is compared by full normalized content, never re-granted.
 */
export const businessEvent = billing.table(
  "business_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    accountId: uuid("account_id").notNull(),
    sourceNamespace: text("source_namespace").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    /** Normalized business content (organization, account, amount, period, validity, actor). */
    content: payload("content"),
    /**
     * The FIRST successful business response (lot id, ledger event id,
     * balances at grant time). A different HTTP idempotency key replaying the
     * same business event reads THIS snapshot — never a recomputation from
     * current balances.
     */
    firstResult: payload("first_result"),
    createdAtUs: micros("created_at_us").notNull(),
  },
  (t) => [
    unique("billing_business_event_key_uq").on(
      t.sourceNamespace,
      t.sourceEventId,
    ),
    foreignKey({
      name: "billing_business_event_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [account.organizationId, account.id],
    }),
  ],
);

// ----------------------------------------------------------------- credit_lot
/**
 * One granted bucket with its own lifecycle. Source identity, original
 * granted amount and validity are written once and can never be rewritten
 * (immutability trigger + restricted runtime role); later operations only
 * move the six right-hand components, which must always conserve the grant.
 */
export const creditLot = billing.table(
  "credit_lot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    accountId: uuid("account_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    sourcePeriodId: text("source_period_id"),
    granted: micros("granted_microcredits").notNull(),
    available: micros("available_microcredits").notNull().default(sql`0`),
    reserved: micros("reserved_microcredits").notNull().default(sql`0`),
    refundFrozen: micros("refund_frozen_microcredits").notNull().default(sql`0`),
    consumed: micros("consumed_microcredits").notNull().default(sql`0`),
    expired: micros("expired_microcredits").notNull().default(sql`0`),
    revoked: micros("revoked_microcredits").notNull().default(sql`0`),
    validFromUs: micros("valid_from_us").notNull(),
    expiresAtUs: micros("expires_at_us"),
    status: text("status").notNull().default("active"),
    revision: micros("revision").notNull().default(sql`1`),
    /** Original deduction event a compensation restores (same account, DB-checked). */
    compensationForEventId: uuid("compensation_for_event_id"),
    createdAtUs: micros("created_at_us").notNull(),
    updatedAtUs: micros("updated_at_us").notNull(),
  },
  (t) => [
    unique("billing_credit_lot_org_account_id_uq").on(
      t.organizationId,
      t.accountId,
      t.id,
    ),
    // Consumption order: nearest expiry first, then (created_at_us, id).
    index("billing_credit_lot_consumption_idx").on(
      t.accountId,
      t.expiresAtUs,
      t.createdAtUs,
      t.id,
    ),
    check(
      "billing_credit_lot_source_check",
      sql`${t.sourceType} IN ('subscription', 'pack', 'compensation')`,
    ),
    check(
      "billing_credit_lot_status_check",
      sql`${t.status} IN ('scheduled', 'active', 'frozen', 'exhausted', 'expired', 'revoked')`,
    ),
    // Conservation and non-negativity: the DB refuses what code might miss.
    check(
      "billing_credit_lot_nonnegative_check",
      sql`${t.available} >= 0 AND ${t.reserved} >= 0 AND ${t.refundFrozen} >= 0
          AND ${t.consumed} >= 0 AND ${t.expired} >= 0 AND ${t.revoked} >= 0
          AND ${t.granted} >= 0`,
    ),
    check(
      "billing_credit_lot_conservation_check",
      sql`${t.granted} = ${t.available} + ${t.reserved} + ${t.refundFrozen}
          + ${t.consumed} + ${t.expired} + ${t.revoked}`,
    ),
    // packs are long-lived and period-less; subscription carries a period AND
    // a finite expiry after valid_from; compensation carries a real expiry.
    check(
      "billing_credit_lot_pack_lifetime_check",
      sql`${t.sourceType} <> 'pack' OR (${t.sourcePeriodId} IS NULL AND ${t.expiresAtUs} IS NULL)`,
    ),
    check(
      "billing_credit_lot_subscription_period_check",
      sql`${t.sourceType} <> 'subscription' OR (${t.sourcePeriodId} IS NOT NULL AND ${t.expiresAtUs} IS NOT NULL AND ${t.expiresAtUs} > ${t.validFromUs})`,
    ),
    check(
      "billing_credit_lot_compensation_expiry_check",
      sql`${t.sourceType} <> 'compensation' OR (${t.expiresAtUs} IS NOT NULL AND ${t.expiresAtUs} > ${t.validFromUs})`,
    ),
    check(
      "billing_credit_lot_compensation_origin_check",
      sql`${t.sourceType} <> 'compensation' OR ${t.compensationForEventId} IS NOT NULL`,
    ),
    foreignKey({
      name: "billing_credit_lot_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [account.organizationId, account.id],
    }),
    // A compensation's original deduction must exist INSIDE THE SAME ACCOUNT;
    // a cross-account original is refused here, not just in code.
    foreignKey({
      name: "billing_credit_lot_origin_fk",
      columns: [t.organizationId, t.accountId, t.compensationForEventId],
      foreignColumns: [ledgerEvent.organizationId, ledgerEvent.accountId, ledgerEvent.id],
    }),
  ],
);

// ----------------------------------------------------------------- ledger_line
/**
 * Per-lot component change caused by one event, with the balances after the
 * change. (event, lot) is unique: a replayed operation can never add a
 * second line for the same pair. Component deltas always sum to zero.
 */
export const ledgerLine = billing.table(
  "ledger_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    accountId: uuid("account_id").notNull(),
    eventId: uuid("event_id").notNull(),
    lotId: uuid("lot_id").notNull(),
    deltaGranted: micros("delta_granted_microcredits").notNull().default(sql`0`),
    deltaAvailable: micros("delta_available_microcredits").notNull().default(sql`0`),
    deltaReserved: micros("delta_reserved_microcredits").notNull().default(sql`0`),
    deltaRefundFrozen: micros("delta_refund_frozen_microcredits")
      .notNull()
      .default(sql`0`),
    deltaConsumed: micros("delta_consumed_microcredits").notNull().default(sql`0`),
    deltaExpired: micros("delta_expired_microcredits").notNull().default(sql`0`),
    deltaRevoked: micros("delta_revoked_microcredits").notNull().default(sql`0`),
    balancesAfter: payload("balances_after"),
    createdAtUs: micros("created_at_us").notNull(),
  },
  (t) => [
    unique("billing_ledger_line_org_account_id_uq").on(
      t.organizationId,
      t.accountId,
      t.id,
    ),
    unique("billing_ledger_line_event_lot_uq").on(t.eventId, t.lotId),
    // The line's accounting identity: the granted delta equals the sum of the
    // six component deltas (a grant creates credit; internal moves sum to 0).
    check(
      "billing_ledger_line_identity_check",
      sql`${t.deltaGranted} = ${t.deltaAvailable} + ${t.deltaReserved}
          + ${t.deltaRefundFrozen} + ${t.deltaConsumed} + ${t.deltaExpired}
          + ${t.deltaRevoked}`,
    ),
    foreignKey({
      name: "billing_ledger_line_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [account.organizationId, account.id],
    }),
    foreignKey({
      name: "billing_ledger_line_event_fk",
      columns: [t.organizationId, t.accountId, t.eventId],
      foreignColumns: [ledgerEvent.organizationId, ledgerEvent.accountId, ledgerEvent.id],
    }),
    foreignKey({
      name: "billing_ledger_line_lot_fk",
      columns: [t.organizationId, t.accountId, t.lotId],
      foreignColumns: [creditLot.organizationId, creditLot.accountId, creditLot.id],
    }),
  ],
);

// ------------------------------------------------------------------ adjustment
/**
 * Immutable appended correction. Business uniqueness
 * (billing_account_id, original_event_id, adjustment_type) is a DATABASE
 * unique — a different HTTP idempotency key (or a process restart) cannot
 * duplicate it, and amount/period/reason are NOT part of the key so changing
 * them cannot smuggle a second correction through. The original event must
 * belong to the target account (composite FK), and the correction's own
 * source identity is independently deduplicated.
 */
export const adjustment = billing.table(
  "adjustment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    accountId: uuid("account_id").notNull(),
    originalEventId: uuid("original_event_id").notNull(),
    adjustmentType: text("adjustment_type").notNull(),
    sourceNamespace: text("source_namespace").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    signedDelta: micros("signed_delta_microcredits").notNull(),
    reason: text("reason").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    originalPeriodId: text("original_period_id"),
    effectiveAtUs: micros("effective_at_us").notNull(),
    compensationLotId: uuid("compensation_lot_id"),
    createdAtUs: micros("created_at_us").notNull(),
  },
  (t) => [
    unique("billing_adjustment_org_account_id_uq").on(
      t.organizationId,
      t.accountId,
      t.id,
    ),
    unique("billing_adjustment_scope_uq").on(
      t.accountId,
      t.originalEventId,
      t.adjustmentType,
    ),
    unique("billing_adjustment_source_uq").on(
      t.sourceNamespace,
      t.sourceEventId,
    ),
    check(
      "billing_adjustment_type_check",
      sql`${t.adjustmentType} IN ('charge_correction', 'compensation', 'late_usage_attribution', 'expiry_correction', 'revocation')`,
    ),
    check(
      "billing_adjustment_zero_only_attribution_check",
      sql`${t.signedDelta} <> 0 OR ${t.adjustmentType} = 'late_usage_attribution'`,
    ),
    check(
      "billing_adjustment_negative_no_lot_check",
      sql`${t.signedDelta} >= 0 OR ${t.compensationLotId} IS NULL`,
    ),
    foreignKey({
      name: "billing_adjustment_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [account.organizationId, account.id],
    }),
    foreignKey({
      name: "billing_adjustment_original_fk",
      columns: [t.organizationId, t.accountId, t.originalEventId],
      foreignColumns: [ledgerEvent.organizationId, ledgerEvent.accountId, ledgerEvent.id],
    }),
    foreignKey({
      name: "billing_adjustment_compensation_lot_fk",
      columns: [t.organizationId, t.accountId, t.compensationLotId],
      foreignColumns: [creditLot.organizationId, creditLot.accountId, creditLot.id],
    }),
  ],
);

// ------------------------------------------------------- recovery_allocation
/**
 * The ONE non-overridable recovery record for original deductions. Every
 * grant or adjustment that restores credits against an original deduction
 * line appends a row here IN THE SAME TRANSACTION that moves the lot
 * components — compensation grants and positive adjustments share this
 * single quota ledger, so no entry path, adjustment type, HTTP key, race or
 * crash replay can together restore more than the original deduction took.
 * The cumulative sum per (original_event_id, original_lot_id) is the quota
 * already consumed; the database guard trigger refuses any insert that
 * would push it past that line's delta_consumed.
 */
export const recoveryAllocation = billing.table(
  "recovery_allocation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    accountId: uuid("account_id").notNull(),
    originalEventId: uuid("original_event_id").notNull(),
    originalLotId: uuid("original_lot_id").notNull(),
    restored: micros("restored_microcredits").notNull(),
    /** Which trusted entry wrote it: the grant or the adjustment route. */
    restoredVia: text("restored_via").notNull(),
    /** The grant/adjustment ledger event that performed the restoration. */
    restorationEventId: uuid("restoration_event_id").notNull(),
    createdAtUs: micros("created_at_us").notNull(),
  },
  (t) => [
    unique("billing_recovery_org_account_id_uq").on(
      t.organizationId,
      t.accountId,
      t.id,
    ),
    // One row per (original deduction line, restoring event): a replayed
    // restoration can never double-count its quota consumption.
    unique("billing_recovery_line_event_uq").on(
      t.originalEventId,
      t.originalLotId,
      t.restorationEventId,
    ),
    index("billing_recovery_quota_idx").on(t.originalEventId, t.originalLotId),
    check(
      "billing_recovery_via_check",
      sql`${t.restoredVia} IN ('credit_grant', 'adjustment')`,
    ),
    check(
      "billing_recovery_positive_check",
      sql`${t.restored} > 0`,
    ),
    foreignKey({
      name: "billing_recovery_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [account.organizationId, account.id],
    }),
    foreignKey({
      name: "billing_recovery_original_fk",
      columns: [t.organizationId, t.accountId, t.originalEventId],
      foreignColumns: [ledgerEvent.organizationId, ledgerEvent.accountId, ledgerEvent.id],
    }),
    foreignKey({
      name: "billing_recovery_lot_fk",
      columns: [t.organizationId, t.accountId, t.originalLotId],
      foreignColumns: [creditLot.organizationId, creditLot.accountId, creditLot.id],
    }),
    foreignKey({
      name: "billing_recovery_event_fk",
      columns: [t.organizationId, t.accountId, t.restorationEventId],
      foreignColumns: [ledgerEvent.organizationId, ledgerEvent.accountId, ledgerEvent.id],
    }),
  ],
);

// ------------------------------------------------------------------ idempotency
/**
 * Persisted idempotency: the normalized request, its hash and the FIRST
 * business response snapshot. Written in the SAME transaction as the ledger
 * changes, so a committed grant can always be replayed and an uncommitted
 * one can never leave a "success" behind. No TTL: lifetime = ledger lifetime.
 */
export const idempotency = billing.table(
  "idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    accountId: uuid("account_id").notNull(),
    operation: text("operation").notNull(),
    logicalResourceId: text("logical_resource_id").notNull(),
    key: text("key").notNull(),
    request: payload("request"),
    requestHash: text("request_hash").notNull(),
    response: payload("response"),
    schemaVersion: text("schema_version").notNull(),
    createdAtUs: micros("created_at_us").notNull(),
  },
  (t) => [
    unique("billing_idempotency_scope_uq").on(
      t.organizationId,
      t.accountId,
      t.operation,
      t.logicalResourceId,
      t.key,
    ),
    foreignKey({
      name: "billing_idempotency_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [account.organizationId, account.id],
    }),
  ],
);

// ----------------------------------------------------------------- outbox_event
/**
 * The atomically-committed outbound record: exactly one per ledger event
 * (unique on ledger_event_id), immutable payload, watermark = the event's
 * account_seq. PENDING ONLY in this ticket — "sent" is set by the delivery
 * worker (#73) after REAL confirmation, never by the ledger write itself.
 */
export const outboxEvent = billing.table(
  "outbox_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    accountId: uuid("account_id").notNull(),
    ledgerEventId: uuid("ledger_event_id").notNull(),
    accountSeq: micros("account_seq").notNull(),
    eventType: text("event_type").notNull(),
    schemaVersion: text("schema_version").notNull(),
    payload: payload("payload"),
    createdAtUs: micros("created_at_us").notNull(),
  },
  (t) => [
    unique("billing_outbox_event_org_account_id_uq").on(
      t.organizationId,
      t.accountId,
      t.id,
    ),
    unique("billing_outbox_event_ledger_uq").on(t.ledgerEventId),
    foreignKey({
      name: "billing_outbox_event_account_fk",
      columns: [t.organizationId, t.accountId],
      foreignColumns: [account.organizationId, account.id],
    }),
    foreignKey({
      name: "billing_outbox_event_ledger_fk",
      columns: [t.organizationId, t.accountId, t.ledgerEventId],
      foreignColumns: [ledgerEvent.organizationId, ledgerEvent.accountId, ledgerEvent.id],
    }),
  ],
);

// -------------------------------------------------------------- outbox_delivery
/**
 * Mutable delivery metadata, deliberately separate from the immutable
 * business content: the ledger can rewrite THIS projection without ever
 * touching an event.
 */
export const outboxDelivery = billing.table(
  "outbox_delivery",
  {
    outboxEventId: uuid("outbox_event_id").primaryKey(),
    status: text("status").notNull().default("pending"),
    attempts: micros("attempts").notNull().default(sql`0`),
    leaseUntilUs: micros("lease_until_us"),
    publishedAtUs: micros("published_at_us"),
    updatedAtUs: micros("updated_at_us").notNull(),
  },
  (t) => [
    check(
      "billing_outbox_delivery_status_check",
      sql`${t.status} IN ('pending', 'sent', 'failed')`,
    ),
    foreignKey({
      name: "billing_outbox_delivery_event_fk",
      columns: [t.outboxEventId],
      foreignColumns: [outboxEvent.id],
    }),
  ],
);
