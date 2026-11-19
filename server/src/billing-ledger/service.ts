/**
 * #64 credit-ledger service — the business core the isolated HTTP entry and
 * (later, via #67's identity adapter) the production server share.
 *
 * Invariants enforced HERE AND IN THE DATABASE:
 *  - One transaction per business operation contains: dedupe/verification,
 *    lot changes, ledger event + lines, adjustment (if any), the pending
 *    outbox record and the successful idempotency row. Nothing commits
 *    half-done; COMMIT happens before any response is sent; no network call
 *    runs inside the transaction.
 *  - HTTP idempotency (five-field scope) and business uniqueness
 *    (source namespace + event; adjustment scope) are independent: a new HTTP
 *    key over the same business event replays the FIRST result, and a
 *    different account/amount/period behind the same business key is refused.
 *  - Lock order: dedupe advisory locks (sorted) → account row → lots (by id).
 *    Advisory locks are `pg_try_advisory_xact_lock`: a concurrent duplicate
 *    answers 409 idempotency_in_progress + Retry-After and retries to
 *    convergence; a process death releases the locks with the transaction.
 *  - Money and time are BigInt everywhere; JSON carries decimal strings.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import postgresJs from "postgres";
import {
  BillingValueError,
  parsePositiveMicrocredits,
  parseSigned,
  parseTimestampUs,
} from "../billing-contract/money-time.js";
import * as schema from "./schema.js";

export const SCHEMA_VERSION = "billing.v1";

/**
 * Compensation lots live 30 days from the moment their grant arrives. The
 * window is computed by THIS service from its own clock; the request field is
 * only allowed to echo it (within a small skew tolerance for transport time).
 */
export const COMPENSATION_WINDOW_US = 30n * 24n * 60n * 60n * 1_000_000n;
const COMPENSATION_EXPIRY_TOLERANCE_US = 5n * 60n * 1_000_000n;

/** Contract-mapped failure; `code` is the closed problem+json enum. */
export class LedgerError extends Error {
  constructor(
    readonly code:
      | "missing_idempotency_key"
      | "invalid_cursor"
      | "unauthenticated"
      | "forbidden"
      | "resource_not_found"
      | "idempotency_conflict"
      | "idempotency_in_progress"
      | "state_conflict"
      | "invalid_integer"
      | "out_of_range"
      | "insufficient_credits"
      | "unknown_payer"
      | "ledger_unavailable",
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** The status each closed error code answers with (mirrors the contract). */
export const ERROR_STATUS: Record<LedgerError["code"], number> = {
  missing_idempotency_key: 400,
  invalid_cursor: 400,
  unauthenticated: 401,
  forbidden: 403,
  resource_not_found: 404,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  state_conflict: 409,
  invalid_integer: 422,
  out_of_range: 422,
  insufficient_credits: 422,
  unknown_payer: 422,
  ledger_unavailable: 503,
};

export interface ServiceCredential {
  token: string;
  /** Audited service/operator identity; the actor a credential may act as. */
  subject: string;
  organizationId: string;
  /** Account ids the credential may touch; ["*"] only in the isolated environment's registration credential. */
  accountScope: string[];
  capabilities: string[];
  /** The trusted source namespace grants from this credential dedupe under. */
  namespace: string;
}

/**
 * Fault-injection barriers for the crash-window tests (AC6a/AC6b). Controlled
 * EXCLUSIVELY by the test driver's process config/IPC — there is no HTTP
 * parameter that can reach these.
 */
export interface CommitHooks {
  beforeCommit?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
}

export interface LedgerClock {
  nowUs(): bigint;
}

export interface Components {
  granted: bigint;
  available: bigint;
  reserved: bigint;
  refundFrozen: bigint;
  consumed: bigint;
  expired: bigint;
  revoked: bigint;
}

const COMP_ZERO: Components = {
  granted: 0n,
  available: 0n,
  reserved: 0n,
  refundFrozen: 0n,
  consumed: 0n,
  expired: 0n,
  revoked: 0n,
};

interface LotRow {
  id: string;
  organizationId: string;
  accountId: string;
  sourceType: "subscription" | "pack" | "compensation";
  sourceEventId: string;
  sourcePeriodId: string | null;
  grantedMicrocredits: bigint;
  availableMicrocredits: bigint;
  reservedMicrocredits: bigint;
  refundFrozenMicrocredits: bigint;
  consumedMicrocredits: bigint;
  expiredMicrocredits: bigint;
  revokedMicrocredits: bigint;
  validFromUs: bigint;
  expiresAtUs: bigint | null;
  status: string;
  revision: bigint;
  compensationForEventId: string | null;
  createdAtUs: bigint;
  updatedAtUs: bigint;
}

interface EventRow {
  id: string;
  organizationId: string;
  accountId: string;
  eventType: string;
  accountSeq: bigint;
  sourceNamespace: string | null;
  sourceEventId: string | null;
  adjustmentId: string | null;
  actorSubjectId: string | null;
  reason: string | null;
  originalPeriodId: string | null;
  occurredAtUs: bigint;
  committedAtUs: bigint;
}

interface LedgerLineRow {
  eventId: string;
  lotId: string;
  deltaGrantedMicrocredits: bigint;
  deltaAvailableMicrocredits: bigint;
  deltaReservedMicrocredits: bigint;
  deltaRefundFrozenMicrocredits: bigint;
  deltaConsumedMicrocredits: bigint;
  deltaExpiredMicrocredits: bigint;
  deltaRevokedMicrocredits: bigint;
  balancesAfter: Record<string, string>;
}

interface AdjustmentRow {
  id: string;
  organizationId: string;
  accountId: string;
  originalEventId: string;
  adjustmentType: string;
  sourceNamespace: string;
  sourceEventId: string;
  signedDeltaMicrocredits: bigint;
  reason: string;
  actorSubjectId: string;
  originalPeriodId: string | null;
  effectiveAtUs: bigint;
  compensationLotId: string | null;
  createdAtUs: bigint;
}

/** One in-place restoration target: the row-locked source lot and its share. */
interface RestorationTarget {
  lot: LotRow;
  amount: bigint;
}

/**
 * The allocation of a recovery demand across one original deduction:
 * `allocations` (per original line) is what gets recorded as spent quota,
 * `restorations` is what moves consumed -> available in still-valid lots,
 * `expiredShare` is what becomes a fresh 30-day compensation lot.
 */
interface RecoveryPlan {
  restorations: RestorationTarget[];
  expiredShare: bigint;
  allocations: { lotId: string; amount: bigint }[];
}

const S = (v: unknown): string =>
  v === null || v === undefined ? "null-value" : String(v);

function snakeToCamel(key: string): string {
  return key.replaceAll(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Deterministic JSON (sorted keys) for normalized content and hashing.
 * `undefined` properties are OMITTED (absent ≡ undefined): a literal
 * `undefined` token would make the output invalid JSON, which is exactly how
 * the signed cursors became un-decodable on their first real round trip.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SUBJECT_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_RE = /^[\x20-\x7e]{1,128}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Contract decimal-string parsing mapped onto the closed problem codes:
 * lexical violations are invalid_integer, range violations out_of_range —
 * never an uncaught BillingValueError (which would surface as 503).
 */
function parseAmount(s: string, positive: boolean): bigint {
  try {
    const v = parsePositiveMicrocredits(s);
    if (!positive && v === 0n) return v;
    return v;
  } catch (e) {
    if (e instanceof BillingValueError)
      throw new LedgerError(e.code, e.message);
    throw e;
  }
}

function parseDelta(s: string): bigint {
  try {
    return parseSigned(s);
  } catch (e) {
    if (e instanceof BillingValueError)
      throw new LedgerError(e.code, e.message);
    throw e;
  }
}

function parseInstant(s: string): bigint {
  try {
    return parseTimestampUs(s);
  } catch (e) {
    if (e instanceof BillingValueError)
      throw new LedgerError(e.code, e.message);
    throw e;
  }
}

/** Exact string-or-null for contract decimal/identifier fields. */
function requireString(
  body: Record<string, unknown>,
  field: string,
  allowNull: boolean,
): string | null {
  const v = body[field];
  if (v === null && allowNull) return null;
  if (typeof v !== "string")
    throw new LedgerError(
      "invalid_integer",
      `${field} must be a string${allowNull ? " or null" : ""}`,
    );
  return v;
}

/** Wire shape exactly as the contract's BillingAccount object (snake_case). */
export interface AccountSnapshot {
  id: string;
  schema_version: string;
  organization_id: string;
  billing_account_id: string;
  created_at_us: string;
  updated_at_us: string;
  revision: string;
  owner_subject_id: string;
  personal_workspace_id: string;
  currency: "CNY";
  available_microcredits: string;
  reserved_microcredits: string;
  refund_frozen_microcredits: string;
  status: string;
}

export interface BillingLedgerOptions {
  clock?: LedgerClock;
  hooks?: CommitHooks;
}

/**
 * The exact postgres.js surface this module uses, with parameters typed
 * `unknown`: postgres.js SERIALIZES bigint natively (oid 20) at runtime, but
 * its 3.x type definitions omit bigint from `Serializable`, which would force
 * string conversions at ~80 parameter sites and invite double-format bugs.
 * The facade keeps the exactness (BigInt in, BigInt rows out) without lying
 * to the runtime.
 */
/**
 * The ledger's PostgreSQL pool: identical to a plain postgres.js pool except
 * int8 (oid 20) — every money and time column — parses to BigInt instead of
 * the default lossy-capable string. Money/time arithmetic then matches the
 * types in this module, and serialization back to SQL is the exact decimal
 * string of the BigInt.
 */
export function createLedgerSql(url: string, opts: { max?: number } = {}): Sql {
  return postgresJs(url, {
    ...opts,
    // Result ROW KEYS arrive as the database's snake_case; this module's row
    // types (and the API objects) are camelCase. `column.from` renames keys
    // only — SQL identifiers and parameters are untouched.
    transform: { column: { from: snakeToCamel } },
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: bigint | string) => String(x),
        parse: (x: string) => BigInt(x),
      },
    },
  });
}

export interface SqlFacade {
  <T = Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...params: unknown[]
  ): Promise<T>;
  begin<T>(fn: (tx: SqlFacade) => T | Promise<T>): Promise<T>;
  unsafe<T = Record<string, unknown>[]>(
    query: string,
    params?: unknown[],
  ): Promise<T>;
}

export class BillingLedger {
  private readonly clock: LedgerClock;
  private readonly hooks: CommitHooks | undefined;
  private readonly db: SqlFacade;

  constructor(sql: Sql, opts: BillingLedgerOptions = {}) {
    this.db = sql as unknown as SqlFacade;
    this.clock = opts.clock ?? { nowUs: () => BigInt(Date.now()) * 1000n };
    this.hooks = opts.hooks;
  }

  // ------------------------------------------------------------- account read
  async accountSnapshot(
    organizationId: string,
    accountId: string,
  ): Promise<AccountSnapshot> {
    return this.db.begin(async (tx) => {
      const acc = await this.lockAccount(tx, organizationId, accountId);
      const now = this.clock.nowUs();
      await this.materialiseExpiry(tx, acc, now);
      return this.readSnapshot(tx, acc, now);
    });
  }

  // --------------------------------------------------------- account register
  async registerAccount(
    input: {
      organizationId: string;
      ownerSubjectId: string;
      personalWorkspaceId: string;
    },
    idem: { key: string; requestId: string },
  ): Promise<{ status: 201 | 200; body: Record<string, unknown> }> {
    const now = this.clock.nowUs();
    if (!SUBJECT_RE.test(input.ownerSubjectId))
      throw new LedgerError(
        "unknown_payer",
        "owner_subject_id is not a stable subject id",
      );
    if (!ID_RE.test(input.personalWorkspaceId))
      throw new LedgerError(
        "invalid_integer",
        "personal_workspace_id violates the identifier lexical rule",
      );
    if (!UUID_RE.test(input.organizationId))
      throw new LedgerError("invalid_integer", "organization_id is not a uuid");
    if (!KEY_RE.test(idem.key))
      throw new LedgerError(
        "missing_idempotency_key",
        "Idempotency-Key violates its lexical rule",
      );

    const normalized = canonicalJson({
      operation: "registerBillingAccount",
      organization_id: input.organizationId,
      owner_subject_id: input.ownerSubjectId,
      personal_workspace_id: input.personalWorkspaceId,
      schema_version: SCHEMA_VERSION,
    });

    // The scope's billing_account_id is derived server-side from the subject,
    // so the dedupe lock is on (org, operation, subject) until the row exists.
    const lockA = `reg:${input.organizationId}:${input.ownerSubjectId}`;
    const lockB = `idem:${input.organizationId}:registerBillingAccount:${idem.key}`;
    return this.db.begin(async (tx) => {
      await this.tryLocks(tx, [lockA, lockB]);
      const existing = await tx<Record<string, unknown>[]>`
        SELECT * FROM billing.account
        WHERE owner_subject_id = ${input.ownerSubjectId}
        FOR UPDATE`;
      if (existing.length > 0) {
        const row = existing[0]!;
        if (row.personalWorkspaceId !== input.personalWorkspaceId)
          throw new LedgerError(
            "state_conflict",
            "subject already bound to a different Personal Workspace",
          );
        if (row.organizationId !== input.organizationId)
          throw new LedgerError(
            "state_conflict",
            "subject already bound to a different organization",
          );
        // One stable subject answers the SAME account whatever the key. The
        // idempotency row (keyed by the derived account id) replays the first
        // response byte-for-byte; a new key just records the mapping.
        const replayed = await this.replayIdempotency(tx, {
          organizationId: input.organizationId,
          accountId: row.id as string,
          operation: "registerBillingAccount",
          logicalResourceId: "billing_account_root",
          key: idem.key,
          normalized,
        });
        if (replayed) return { status: 201 as const, body: replayed.body };
        const snapshot = await this.readSnapshot(tx, row as never, now);
        await this.recordIdempotency(tx, {
          organizationId: input.organizationId,
          accountId: row.id as string,
          operation: "registerBillingAccount",
          logicalResourceId: "billing_account_root",
          key: idem.key,
          normalized,
          response: { billing_account: snapshot, request_id: idem.requestId },
        });
        return {
          status: 201 as const,
          body: { billing_account: snapshot, request_id: idem.requestId },
        };
      }
      let inserted: Record<string, unknown>[];
      try {
        inserted = await tx<Record<string, unknown>[]>`
          INSERT INTO billing.account
            (organization_id, owner_subject_id, personal_workspace_id, status, revision, created_at_us, updated_at_us)
          VALUES (${input.organizationId}, ${input.ownerSubjectId}, ${input.personalWorkspaceId}, 'active', 1, ${now}, ${now})
          RETURNING *`;
      } catch (e) {
        // Two subjects racing on the same Personal Workspace: the UNIQUE (not
        // a process check) decides; the loser answers a conflict.
        if ((e as { code?: string }).code === "23505")
          throw new LedgerError(
            "state_conflict",
            "personal workspace or subject already bound to another account",
          );
        throw e;
      }
      const row = inserted[0]!;
      const snapshot = await this.readSnapshot(tx, row as never, now);
      await this.recordIdempotency(tx, {
        organizationId: input.organizationId,
        accountId: row.id as string,
        operation: "registerBillingAccount",
        logicalResourceId: "billing_account_root",
        key: idem.key,
        normalized,
        response: { billing_account: snapshot, request_id: idem.requestId },
      });
      return {
        status: 201 as const,
        body: { billing_account: snapshot, request_id: idem.requestId },
      };
    });
  }

  // -------------------------------------------------------------- credit grant
  async createGrant(
    credential: ServiceCredential,
    body: Record<string, unknown>,
    idem: { key: string; requestId: string },
  ): Promise<{ status: 201; body: Record<string, unknown> }> {
    const accountId = requireString(body, "billing_account_id", false)!;
    if (!UUID_RE.test(accountId))
      throw new LedgerError(
        "invalid_integer",
        "billing_account_id is not a uuid",
      );
    const sourceEventId = requireString(body, "source_event_id", false)!;
    const sourceType = requireString(body, "source_type", false)!;
    const sourcePeriodId = requireString(body, "source_period_id", true);
    const amountStr = requireString(body, "granted_microcredits", false)!;
    const validFromStr = requireString(body, "valid_from_us", false)!;
    const expiresStr = requireString(body, "expires_at_us", true);
    const originalEventId = requireString(body, "original_event_id", true);
    const actor = requireString(body, "actor_subject_id", false)!;
    if (!ID_RE.test(sourceEventId))
      throw new LedgerError(
        "invalid_integer",
        "source_event_id violates the identifier lexical rule",
      );
    // The audited operator IS the authenticated credential subject. There is
    // no delegation in this ticket: a trusted credential cannot write history
    // on behalf of a subject it does not hold.
    if (actor !== credential.subject)
      throw new LedgerError(
        "forbidden",
        "actor_subject_id must be the authenticated credential subject",
      );
    const amount = parseAmount(amountStr, true);
    const validFrom = parseInstant(validFromStr);
    const expiresAt = expiresStr === null ? null : parseInstant(expiresStr);
    const now = this.clock.nowUs();
    if (sourceType === "pack") {
      if (
        sourcePeriodId !== null ||
        expiresAt !== null ||
        originalEventId !== null
      )
        throw new LedgerError(
          "state_conflict",
          "pack grants are period-less and long-lived",
        );
    } else if (sourceType === "subscription") {
      if (sourcePeriodId === null || !ID_RE.test(sourcePeriodId))
        throw new LedgerError(
          "state_conflict",
          "subscription grants carry their period",
        );
      if (expiresAt === null || expiresAt <= validFrom)
        throw new LedgerError(
          "state_conflict",
          "subscription grants need a finite expiry after valid_from",
        );
      if (originalEventId !== null)
        throw new LedgerError(
          "state_conflict",
          "subscription grants do not reference an original deduction",
        );
    } else if (sourceType === "compensation") {
      if (originalEventId === null || !ID_RE.test(originalEventId))
        throw new LedgerError(
          "resource_not_found",
          "compensation grants link their original deduction event",
        );
      if (sourcePeriodId !== null)
        throw new LedgerError(
          "state_conflict",
          "compensation grants are attributed to the original event's period, not a new one",
        );
    } else {
      throw new LedgerError(
        "state_conflict",
        "source_type must be subscription, pack or compensation",
      );
    }

    const businessContent = {
      billing_account_id: accountId,
      source_event_id: sourceEventId,
      source_type: sourceType,
      source_period_id: sourcePeriodId,
      granted_microcredits: amountStr,
      valid_from_us: validFromStr,
      expires_at_us: expiresStr,
      original_event_id: originalEventId,
      actor_subject_id: actor,
    };
    const businessCanonical = canonicalJson(businessContent);
    const idemNormalized = canonicalJson({
      operation: "createCreditGrant",
      organization_id: credential.organizationId,
      contract_version: SCHEMA_VERSION,
      path: "/internal/v1/billing/credit-grants",
      ...businessContent,
    });
    if (!KEY_RE.test(idem.key))
      throw new LedgerError(
        "missing_idempotency_key",
        "Idempotency-Key violates its lexical rule",
      );

    const body_response = await this.db.begin(async (tx) => {
      // Lock order: dedupe locks (sorted) → account → lots (by id).
      const locks = [
        `biz:${credential.namespace}:${sourceEventId}`,
        `idem:${credential.organizationId}:${accountId}:createCreditGrant:${sourceEventId}:${idem.key}`,
      ].sort();
      await this.tryLocks(tx, locks);

      // 1. HTTP-key replay.
      const replayed = await this.replayIdempotency(tx, {
        organizationId: credential.organizationId,
        accountId,
        operation: "createCreditGrant",
        logicalResourceId: sourceEventId,
        key: idem.key,
        normalized: idemNormalized,
      });
      if (replayed) return replayed;

      // 2. Business identity: same key + same content replays under ANY new
      //    HTTP key (from the stored FIRST result, never recomputed); same
      //    key + different content is a conflict.
      const biz = await tx<Record<string, unknown>[]>`
        SELECT * FROM billing.business_event
        WHERE source_namespace = ${credential.namespace}
          AND source_event_id = ${sourceEventId}`;
      if (biz.length > 0) {
        const stored = biz[0]!.content as Record<string, unknown>;
        if (canonicalJson(stored) !== businessCanonical)
          throw new LedgerError(
            "idempotency_conflict",
            "the same business event key is already bound to a different account/amount/period/validity",
          );
        const first = biz[0]!.firstResult as Record<string, unknown>;
        const replayBody: Record<string, unknown> = {
          ...first,
          request_id: idem.requestId,
        };
        await this.recordIdempotency(tx, {
          organizationId: credential.organizationId,
          accountId,
          operation: "createCreditGrant",
          logicalResourceId: sourceEventId,
          key: idem.key,
          normalized: idemNormalized,
          response: replayBody,
        });
        return { status: 200 as const, body: replayBody };
      }

      // 3. Account row lock; scope and status checked here.
      const acc = await this.lockAccount(
        tx,
        credential.organizationId,
        accountId,
      );
      if (acc.status !== "active")
        throw new LedgerError(
          "state_conflict",
          "credits cannot be granted to a non-active account",
        );
      const nowInTx = this.clock.nowUs();
      await this.materialiseExpiry(tx, acc, nowInTx);

      // A grant whose expiry instant is already in the past is refused in the
      // SAME transaction that would have stored it: history never answers a
      // first response that counts dead credits as spendable.
      if (
        sourceType === "subscription" &&
        expiresAt !== null &&
        expiresAt <= nowInTx
      )
        throw new LedgerError(
          "state_conflict",
          "this grant's expiry has already passed; issue a fresh lot instead of an already-expired one",
        );

      // 4. Compensation: the original deduction must exist INSIDE this
      //    account and must actually be a deduction. The recovery quota is
      //    PER ORIGINAL DEDUCTION LINE and SHARED with every other entry
      //    (positive adjustments): the dedicated recovery_allocation ledger
      //    records — in THIS transaction — how much each line has already
      //    given back, so grants and adjustments together can never restore
      //    more than the original deduction took, whatever the order, the
      //    adjustment type or the HTTP keys involved. Still-valid source
      //    lots are restored IN PLACE (consumed -> available, original
      //    validity untouched); expired source shares are never revived and
      //    become ONE fresh lot expiring arrival + 30 days, server-computed
      //    — the request may echo that instant or send null, nothing else.
      //    ANY shortfall above the remaining quota rejects the WHOLE
      //    request; nothing partial is ever written.
      let originalEvent: EventRow | null = null;
      let eventPeriodId = sourcePeriodId;
      let recoveryPlan: RecoveryPlan | null = null;
      if (sourceType === "compensation") {
        const rows = await this.eventById(
          tx,
          credential.organizationId,
          accountId,
          originalEventId!,
        );
        if (rows.length === 0)
          throw new LedgerError(
            "resource_not_found",
            "original deduction event not found in this account",
          );
        originalEvent = rows[0]!;
        recoveryPlan = await this.planRecovery(
          tx,
          credential.organizationId,
          accountId,
          originalEvent.id,
          amount,
          nowInTx,
        );
        const serverExpiry = nowInTx + COMPENSATION_WINDOW_US;
        if (
          expiresAt !== null &&
          (expiresAt < serverExpiry - COMPENSATION_EXPIRY_TOLERANCE_US ||
            expiresAt > serverExpiry + COMPENSATION_EXPIRY_TOLERANCE_US)
        )
          throw new LedgerError(
            "state_conflict",
            "compensation expiry is computed by the server as grant arrival + 30 days; the request may only echo it (or send null)",
          );
        if (recoveryPlan.expiredShare > 0n && validFrom >= serverExpiry)
          throw new LedgerError(
            "state_conflict",
            "valid_from lies beyond the server-computed compensation expiry",
          );
        eventPeriodId = originalEvent.originalPeriodId;
      }

      // 5. Lot moves + ledger event + lines + outbox + first-result +
      //    idempotency, all inside THIS transaction.
      const eventId = randomUUID();
      const nowInTxUs = nowInTx;
      const eventLines: Record<string, unknown>[] = [];
      /** The lot the response's `credit_lot` field answers with. */
      let responseLot: LotRow | null = null;
      let compensationLotRow: LotRow | null = null;

      if (recoveryPlan !== null) {
        // (a) in-place restorations inside the original still-valid lots
        for (const r of recoveryPlan.restorations) {
          const next = {
            granted: r.lot.grantedMicrocredits,
            available: r.lot.availableMicrocredits + r.amount,
            reserved: r.lot.reservedMicrocredits,
            refundFrozen: r.lot.refundFrozenMicrocredits,
            consumed: r.lot.consumedMicrocredits - r.amount,
            expired: r.lot.expiredMicrocredits,
            revoked: r.lot.revokedMicrocredits,
          };
          const updated = await tx<LotRow[]>`
            UPDATE billing.credit_lot SET
              available_microcredits = ${next.available},
              consumed_microcredits = ${next.consumed},
              status = ${this.lotStatusAfter(next, r.lot)},
              revision = revision + 1,
              updated_at_us = ${nowInTxUs}
            WHERE id = ${r.lot.id} AND organization_id = ${credential.organizationId}
            RETURNING *`;
          const lot = updated[0]!;
          eventLines.push({
            lot_id: lot.id,
            delta_granted_microcredits: "0",
            delta_available_microcredits: S(r.amount),
            delta_reserved_microcredits: "0",
            delta_refund_frozen_microcredits: "0",
            delta_consumed_microcredits: S(-r.amount),
            delta_expired_microcredits: "0",
            delta_revoked_microcredits: "0",
            balances_after: this.balancesObject(this.lotComponents(lot)),
          });
        }
        // (b) ONE fresh compensation lot for the expired source share
        if (recoveryPlan.expiredShare > 0n) {
          const compLotId = randomUUID();
          const inserted = await tx<LotRow[]>`
            INSERT INTO billing.credit_lot
              (id, organization_id, account_id, source_type, source_event_id, source_period_id,
               granted_microcredits, available_microcredits, valid_from_us, expires_at_us, status,
               revision, compensation_for_event_id, created_at_us, updated_at_us)
            VALUES (${compLotId}, ${credential.organizationId}, ${accountId}, 'compensation', ${sourceEventId},
               null, ${recoveryPlan.expiredShare}, ${recoveryPlan.expiredShare}, ${nowInTxUs},
               ${nowInTxUs + COMPENSATION_WINDOW_US}, 'active', 1, ${originalEvent!.id}, ${nowInTxUs}, ${nowInTxUs})
            RETURNING *`;
          compensationLotRow = inserted[0]!;
          eventLines.push({
            lot_id: compensationLotRow.id,
            delta_granted_microcredits: S(recoveryPlan.expiredShare),
            delta_available_microcredits: S(recoveryPlan.expiredShare),
            delta_reserved_microcredits: "0",
            delta_refund_frozen_microcredits: "0",
            delta_consumed_microcredits: "0",
            delta_expired_microcredits: "0",
            delta_revoked_microcredits: "0",
            balances_after: this.balancesObject(
              this.lotComponents(compensationLotRow),
            ),
          });
          responseLot = compensationLotRow;
        } else {
          // The restored original lot with the largest share answers as the
          // response lot (deterministic under a multi-lot restoration).
          responseLot = [...recoveryPlan.restorations].sort((a, b) =>
            a.amount > b.amount
              ? -1
              : a.amount < b.amount
                ? 1
                : a.lot.id < b.lot.id
                  ? -1
                  : 1,
          )[0]!.lot;
        }
      } else {
        // plain subscription / pack grant: one fresh lot from birth
        const lotId = randomUUID();
        const status = validFrom > nowInTxUs ? "scheduled" : "active";
        const insertLot = await tx<LotRow[]>`
          INSERT INTO billing.credit_lot
            (id, organization_id, account_id, source_type, source_event_id, source_period_id,
             granted_microcredits, available_microcredits, valid_from_us, expires_at_us, status,
             revision, compensation_for_event_id, created_at_us, updated_at_us)
          VALUES (${lotId}, ${credential.organizationId}, ${accountId}, ${sourceType}, ${sourceEventId},
             ${sourcePeriodId}, ${amount}, ${amount}, ${validFrom}, ${expiresAt}, ${status},
             1, null, ${nowInTxUs}, ${nowInTxUs})
          RETURNING *`;
        const lot = insertLot[0]!;
        responseLot = lot;
        eventLines.push({
          lot_id: lot.id,
          delta_granted_microcredits: amountStr,
          delta_available_microcredits: amountStr,
          delta_reserved_microcredits: "0",
          delta_refund_frozen_microcredits: "0",
          delta_consumed_microcredits: "0",
          delta_expired_microcredits: "0",
          delta_revoked_microcredits: "0",
          balances_after: this.balancesObject(this.lotComponents(lot)),
        });
      }

      const seq = await this.nextAccountSeq(tx, accountId);
      await tx`
        INSERT INTO billing.ledger_event
          (id, organization_id, account_id, event_type, account_seq, source_namespace, source_event_id,
           actor_subject_id, original_period_id, occurred_at_us, committed_at_us)
        VALUES (${eventId}, ${credential.organizationId}, ${accountId}, 'credit.granted', ${seq},
           ${credential.namespace}, ${sourceEventId}, ${actor}, ${eventPeriodId}, ${validFrom}, ${nowInTxUs})`;
      for (const line of eventLines) {
        const l = line as Record<string, string>;
        await tx`
          INSERT INTO billing.ledger_line
            (organization_id, account_id, event_id, lot_id, delta_granted_microcredits,
             delta_available_microcredits, delta_reserved_microcredits, delta_refund_frozen_microcredits,
             delta_consumed_microcredits, delta_expired_microcredits, delta_revoked_microcredits,
             balances_after, created_at_us)
          VALUES (${credential.organizationId}, ${accountId}, ${eventId}, ${l.lot_id},
             ${BigInt(l.delta_granted_microcredits)}, ${BigInt(l.delta_available_microcredits)},
             ${BigInt(l.delta_reserved_microcredits)}, ${BigInt(l.delta_refund_frozen_microcredits)},
             ${BigInt(l.delta_consumed_microcredits)}, ${BigInt(l.delta_expired_microcredits)},
             ${BigInt(l.delta_revoked_microcredits)}, ${l.balances_after}, ${nowInTxUs})`;
      }
      // The shared quota ledger — recorded only AFTER the grant's own ledger
      // event exists (the recovery rows reference it): from commit on, this
      // recovery is spent and visible to every later grant/adjustment, replay
      // or race.
      if (recoveryPlan !== null) {
        await this.recordRecoveryAllocations(
          tx,
          credential.organizationId,
          accountId,
          originalEvent!.id,
          eventId,
          "credit_grant",
          recoveryPlan.allocations,
          nowInTxUs,
        );
      }
      const outboxPayload = {
        schema_version: SCHEMA_VERSION,
        event_type: "credit.granted",
        ledger_event_id: eventId,
        account_seq: String(seq),
        original_period_id: eventPeriodId,
        granted_microcredits: amountStr,
        lines: eventLines,
      };
      const outboxId = await this.writeOutbox(tx, {
        organizationId: credential.organizationId,
        accountId,
        ledgerEventId: eventId,
        accountSeq: seq,
        eventType: "credit.granted",
        payload: outboxPayload,
        nowUs: nowInTxUs,
      });

      const snapshot = await this.readSnapshot(tx, acc, nowInTxUs);
      // The stored FIRST business response: a different HTTP key replaying
      // this business event answers THIS snapshot verbatim, never a
      // recomputation from current balances.
      const firstResultStored: Record<string, unknown> = {
        credit_lot: this.lotJson(responseLot!),
        ledger_event_id: eventId,
        billing_account: snapshot,
        request_id: idem.requestId,
      };
      const responseBody = firstResultStored;
      if (biz.length === 0) {
        await tx`
          INSERT INTO billing.business_event
            (organization_id, account_id, source_namespace, source_event_id, content, first_result, created_at_us)
          VALUES (${credential.organizationId}, ${accountId}, ${credential.namespace}, ${sourceEventId},
             ${businessContent}, ${firstResultStored}, ${nowInTxUs})`;
      }
      await this.recordIdempotency(tx, {
        organizationId: credential.organizationId,
        accountId,
        operation: "createCreditGrant",
        logicalResourceId: sourceEventId,
        key: idem.key,
        normalized: idemNormalized,
        response: responseBody,
      });
      this.hooks?.beforeCommit && (await this.hooks.beforeCommit());
      return { status: 201 as const, body: responseBody };
    });
    this.hooks?.afterCommit && (await this.hooks.afterCommit());
    return body_response as { status: 201; body: Record<string, unknown> };
  }

  // --------------------------------------------------------------- adjustment
  async createAdjustment(
    credential: ServiceCredential,
    body: Record<string, unknown>,
    idem: { key: string; requestId: string },
  ): Promise<{ status: 201; body: Record<string, unknown> }> {
    const accountId = requireString(body, "billing_account_id", false)!;
    if (!UUID_RE.test(accountId))
      throw new LedgerError(
        "invalid_integer",
        "billing_account_id is not a uuid",
      );
    const originalEventId = requireString(body, "original_event_id", false)!;
    const adjustmentType = requireString(body, "adjustment_type", false)!;
    const sourceEventId = requireString(body, "source_event_id", false)!;
    const deltaStr = requireString(body, "signed_delta_microcredits", false)!;
    const reason = requireString(body, "reason", false)!;
    const actor = requireString(body, "actor_subject_id", false)!;
    const periodId = requireString(body, "original_period_id", true);
    const effectiveStr = requireString(body, "effective_at_us", false)!;
    if (!ID_RE.test(originalEventId) || !ID_RE.test(sourceEventId))
      throw new LedgerError(
        "invalid_integer",
        "event identifiers violate the lexical rule",
      );
    if (reason.length === 0 || reason.length > 512)
      throw new LedgerError("invalid_integer", "reason length outside 1..512");
    // Same subject binding as grants: the audited operator is the credential.
    if (actor !== credential.subject)
      throw new LedgerError(
        "forbidden",
        "actor_subject_id must be the authenticated credential subject",
      );
    if (periodId !== null && !ID_RE.test(periodId))
      throw new LedgerError(
        "invalid_integer",
        "original_period_id violates the lexical rule",
      );
    const delta = parseDelta(deltaStr);
    const effectiveAt = parseInstant(effectiveStr);
    if (
      ![
        "charge_correction",
        "compensation",
        "late_usage_attribution",
        "expiry_correction",
        "revocation",
      ].includes(adjustmentType)
    )
      throw new LedgerError("state_conflict", "unknown adjustment_type");
    if (delta === 0n && adjustmentType !== "late_usage_attribution")
      throw new LedgerError(
        "out_of_range",
        "a zero delta is only valid for late_usage_attribution",
      );
    if (delta < 0n && adjustmentType === "compensation")
      throw new LedgerError(
        "state_conflict",
        "compensation deltas are positive ledger changes",
      );
    if (!KEY_RE.test(idem.key))
      throw new LedgerError(
        "missing_idempotency_key",
        "Idempotency-Key violates its lexical rule",
      );

    const scopeContent = {
      billing_account_id: accountId,
      original_event_id: originalEventId,
      adjustment_type: adjustmentType,
      source_event_id: sourceEventId,
      signed_delta_microcredits: deltaStr,
      reason,
      actor_subject_id: actor,
      original_period_id: periodId,
      effective_at_us: effectiveStr,
    };
    const scopeCanonical = canonicalJson(scopeContent);
    const idemNormalized = canonicalJson({
      operation: "createAdjustment",
      organization_id: credential.organizationId,
      contract_version: SCHEMA_VERSION,
      path: "/internal/v1/billing/adjustments",
      logical_resource_id: `${originalEventId}+${adjustmentType}`,
      ...scopeContent,
    });

    const body_response = await this.db.begin(async (tx) => {
      const locks = [
        `adj:${accountId}:${originalEventId}:${adjustmentType}`,
        `adjsrc:${credential.namespace}:${sourceEventId}`,
        `idem:${credential.organizationId}:${accountId}:createAdjustment:${originalEventId}+${adjustmentType}:${idem.key}`,
      ].sort();
      await this.tryLocks(tx, locks);

      const replayed = await this.replayIdempotency(tx, {
        organizationId: credential.organizationId,
        accountId,
        operation: "createAdjustment",
        logicalResourceId: `${originalEventId}+${adjustmentType}`,
        key: idem.key,
        normalized: idemNormalized,
      });
      if (replayed) return replayed;

      const acc = await this.lockAccount(
        tx,
        credential.organizationId,
        accountId,
      );
      const nowInTx = this.clock.nowUs();
      await this.materialiseExpiry(tx, acc, nowInTx);

      // Business scope: one adjustment per (account, original event, type) —
      // same content replays under any key, different content conflicts.
      const existingRows = await tx<AdjustmentRow[]>`
        SELECT * FROM billing.adjustment
        WHERE account_id = ${accountId} AND original_event_id = ${originalEventId}
          AND adjustment_type = ${adjustmentType}`;
      if (existingRows.length > 0) {
        const stored = existingRows[0]!;
        const storedCanonical = canonicalJson({
          billing_account_id: accountId,
          original_event_id: originalEventId,
          adjustment_type: adjustmentType,
          source_event_id: stored.sourceEventId,
          signed_delta_microcredits: S(stored.signedDeltaMicrocredits),
          reason: stored.reason,
          actor_subject_id: stored.actorSubjectId,
          original_period_id: stored.originalPeriodId,
          effective_at_us: S(stored.effectiveAtUs),
        });
        if (storedCanonical !== scopeCanonical)
          throw new LedgerError(
            "idempotency_conflict",
            "this (account, original event, adjustment type) is already posted with different content",
          );
        // Replay the FIRST stored response snapshot, never a recomputation:
        // the stored compensation-lot projection would otherwise drift with
        // the lot's later component/revision changes. Every successful
        // idempotency row for this scope stores the first body verbatim
        // (only request_id ever differs), so the earliest row IS that first
        // response. The rebuild below is a legacy fallback only.
        const snapRows = await tx<{ response: Record<string, unknown> }[]>`
          SELECT response FROM billing.idempotency
          WHERE organization_id = ${credential.organizationId} AND account_id = ${accountId}
            AND operation = 'createAdjustment'
            AND logical_resource_id = ${`${originalEventId}+${adjustmentType}`}
          ORDER BY created_at_us, key
          LIMIT 1`;
        const replayBody =
          snapRows.length > 0
            ? { ...snapRows[0]!.response, request_id: idem.requestId }
            : await this.adjustmentResult(
                tx,
                credential.organizationId,
                accountId,
                stored,
                idem.requestId,
              );
        await this.recordIdempotency(tx, {
          organizationId: credential.organizationId,
          accountId,
          operation: "createAdjustment",
          logicalResourceId: `${originalEventId}+${adjustmentType}`,
          key: idem.key,
          normalized: idemNormalized,
          response: replayBody,
        });
        return { status: 201 as const, body: replayBody };
      }

      const originalRows = await this.eventById(
        tx,
        credential.organizationId,
        accountId,
        originalEventId,
      );
      if (originalRows.length === 0)
        throw new LedgerError(
          "resource_not_found",
          "original event not found in this account",
        );
      const original = originalRows[0]!;
      // The original period is a historical fact: a request must not invent one.
      if (periodId !== (original.originalPeriodId ?? null))
        throw new LedgerError(
          "state_conflict",
          "original_period_id does not match the original event",
        );

      // Build the component moves. The event id exists from here on: every
      // recovery allocation row this adjustment records points at it.
      const nowUs = nowInTx;
      const adjId = randomUUID();
      const eventId = randomUUID();
      const deltas = new Map<string, Partial<Components>>();
      const bump = (lotId: string, patch: Partial<Components>) => {
        const cur = deltas.get(lotId) ?? {};
        for (const k of Object.keys(patch) as (keyof Components)[])
          cur[k] = (cur[k] ?? 0n) + patch[k]!;
        deltas.set(lotId, cur);
      };
      let compensationLotId: string | null = null;
      let compensationLotRow: LotRow | null = null;
      let positivePlan: RecoveryPlan | null = null;

      if (delta > 0n) {
        // Positive: restore the original deduction's consumed allocations
        // through the SHARED per-line recovery quota — the same ledger the
        // direct compensation grants write — so a grant and an adjustment
        // (of any type, under any HTTP key, in any order) can never
        // together restore more than the original deduction took.
        // Still-valid source lots are restored in place; expired source
        // shares become ONE server-side 30-day compensation lot. Only the
        // genuinely unmatched remainder rejects the WHOLE adjustment (zero
        // writes); an expired share alone is compensable.
        positivePlan = await this.planRecovery(
          tx,
          credential.organizationId,
          accountId,
          originalEventId,
          delta,
          nowUs,
        );
        for (const r of positivePlan.restorations)
          bump(r.lot.id, { available: r.amount, consumed: -r.amount });
        if (positivePlan.expiredShare > 0n) {
          const lotId = randomUUID();
          const compExpires = nowUs + COMPENSATION_WINDOW_US;
          const inserted = await tx<LotRow[]>`
            INSERT INTO billing.credit_lot
              (id, organization_id, account_id, source_type, source_event_id, source_period_id,
               granted_microcredits, available_microcredits, valid_from_us, expires_at_us, status,
               revision, compensation_for_event_id, created_at_us, updated_at_us)
            VALUES (${lotId}, ${credential.organizationId}, ${accountId}, 'compensation', ${sourceEventId},
               ${original.originalPeriodId}, ${positivePlan.expiredShare}, ${positivePlan.expiredShare}, ${nowUs}, ${compExpires}, 'active',
               1, ${originalEventId}, ${nowUs}, ${nowUs})
            RETURNING *`;
          compensationLotRow = inserted[0]!;
          compensationLotId = lotId;
          bump(lotId, {
            granted: positivePlan.expiredShare,
            available: positivePlan.expiredShare,
          });
        }
      } else if (delta < 0n) {
        // Negative: withdraw revocable available from the original event's
        // grant lines — never reserved/consumed/frozen, never negative.
        const grantLines = await tx<LedgerLineRow[]>`
          SELECT * FROM billing.ledger_line
          WHERE event_id = ${originalEventId} AND delta_available_microcredits > 0
          ORDER BY lot_id`;
        let remaining = -delta;
        for (const line of grantLines) {
          if (remaining === 0n) break;
          const grantedAvail = BigInt(line.deltaAvailableMicrocredits);
          const lotRows = await this.lotByIdForUpdate(
            tx,
            credential.organizationId,
            accountId,
            line.lotId,
          );
          if (lotRows.length === 0) continue;
          const lot = lotRows[0]!;
          const revocable =
            grantedAvail < lot.availableMicrocredits
              ? grantedAvail
              : lot.availableMicrocredits;
          const take = revocable < remaining ? revocable : remaining;
          if (take > 0n) {
            bump(lot.id, { available: -take, revoked: take });
            remaining -= take;
          }
        }
        if (remaining > 0n)
          throw new LedgerError(
            "state_conflict",
            "the original event's lots do not carry enough revocable available credits; nothing was written",
          );
      }

      // Apply the moves and collect the affected lots in stable order.
      const affectedIds = [...deltas.keys()].sort();
      const eventLines: Record<string, unknown>[] = [];
      for (const lotId of affectedIds) {
        const d = deltas.get(lotId)!;
        // The fresh compensation lot was INSERTed with its final components
        // (its granted amount is immutable from birth, per the lot trigger),
        // so it contributes a ledger line but no second UPDATE.
        if (
          compensationLotId !== null &&
          lotId === compensationLotId &&
          compensationLotRow
        ) {
          eventLines.push({
            lot_id: lotId,
            delta_granted_microcredits: S(d.granted ?? 0n),
            delta_available_microcredits: S(d.available ?? 0n),
            delta_reserved_microcredits: S(d.reserved ?? 0n),
            delta_refund_frozen_microcredits: S(d.refundFrozen ?? 0n),
            delta_consumed_microcredits: S(d.consumed ?? 0n),
            delta_expired_microcredits: S(d.expired ?? 0n),
            delta_revoked_microcredits: S(d.revoked ?? 0n),
            balances_after: this.balancesObject(
              this.lotComponents(compensationLotRow),
            ),
          });
          continue;
        }
        const lotRows = await this.lotByIdForUpdate(
          tx,
          credential.organizationId,
          accountId,
          lotId,
        );
        const lot = lotRows[0]!;
        const next = {
          granted: lot.grantedMicrocredits + (d.granted ?? 0n),
          available: lot.availableMicrocredits + (d.available ?? 0n),
          reserved: lot.reservedMicrocredits + (d.reserved ?? 0n),
          refundFrozen: lot.refundFrozenMicrocredits + (d.refundFrozen ?? 0n),
          consumed: lot.consumedMicrocredits + (d.consumed ?? 0n),
          expired: lot.expiredMicrocredits + (d.expired ?? 0n),
          revoked: lot.revokedMicrocredits + (d.revoked ?? 0n),
        };
        const updated = await tx<LotRow[]>`
          UPDATE billing.credit_lot SET
            granted_microcredits = ${next.granted},
            available_microcredits = ${next.available},
            reserved_microcredits = ${next.reserved},
            refund_frozen_microcredits = ${next.refundFrozen},
            consumed_microcredits = ${next.consumed},
            expired_microcredits = ${next.expired},
            revoked_microcredits = ${next.revoked},
            status = ${this.lotStatusAfter(next, lot)},
            revision = revision + 1,
            updated_at_us = ${nowUs}
          WHERE id = ${lotId} AND organization_id = ${credential.organizationId}
          RETURNING *`;
        const after = updated[0]!;
        eventLines.push({
          lot_id: lotId,
          delta_granted_microcredits: S(d.granted ?? 0n),
          delta_available_microcredits: S(d.available ?? 0n),
          delta_reserved_microcredits: S(d.reserved ?? 0n),
          delta_refund_frozen_microcredits: S(d.refundFrozen ?? 0n),
          delta_consumed_microcredits: S(d.consumed ?? 0n),
          delta_expired_microcredits: S(d.expired ?? 0n),
          delta_revoked_microcredits: S(d.revoked ?? 0n),
          balances_after: this.balancesObject(this.lotComponents(after)),
        });
      }
      if (eventLines.length === 0) {
        // Zero-delta attribution: append the event with the current balances.
        const firstGrantLine = await tx<{ lotId: string }[]>`
          SELECT lot_id FROM billing.ledger_line WHERE event_id = ${originalEventId} ORDER BY lot_id LIMIT 1`;
        if (firstGrantLine.length === 0)
          throw new LedgerError(
            "resource_not_found",
            "original event carries no lot lines",
          );
        const lotRows = await this.lotByIdForUpdate(
          tx,
          credential.organizationId,
          accountId,
          String(firstGrantLine[0]!.lotId),
        );
        const lot = lotRows[0]!;
        eventLines.push({
          lot_id: lot.id,
          delta_granted_microcredits: "0",
          delta_available_microcredits: "0",
          delta_reserved_microcredits: "0",
          delta_refund_frozen_microcredits: "0",
          delta_consumed_microcredits: "0",
          delta_expired_microcredits: "0",
          delta_revoked_microcredits: "0",
          balances_after: this.balancesObject(this.lotComponents(lot)),
        });
      }

      await tx<AdjustmentRow[]>`
        INSERT INTO billing.adjustment
          (id, organization_id, account_id, original_event_id, adjustment_type, source_namespace,
           source_event_id, signed_delta_microcredits, reason, actor_subject_id, original_period_id,
           effective_at_us, compensation_lot_id, created_at_us)
        VALUES (${adjId}, ${credential.organizationId}, ${accountId}, ${originalEventId}, ${adjustmentType},
           ${credential.namespace}, ${sourceEventId}, ${delta}, ${reason}, ${actor}, ${periodId},
           ${effectiveAt}, ${compensationLotId}, ${nowUs})
        RETURNING *`;
      const seq = await this.nextAccountSeq(tx, accountId);
      await tx`
        INSERT INTO billing.ledger_event
          (id, organization_id, account_id, event_type, account_seq, adjustment_id, actor_subject_id,
           reason, original_period_id, occurred_at_us, committed_at_us)
        VALUES (${eventId}, ${credential.organizationId}, ${accountId}, 'credit.adjusted', ${seq},
           ${adjId}, ${actor}, ${reason}, ${periodId}, ${effectiveAt}, ${nowUs})`;
      for (const line of eventLines) {
        const l = line as Record<string, string>;
        await tx`
          INSERT INTO billing.ledger_line
            (organization_id, account_id, event_id, lot_id, delta_granted_microcredits,
             delta_available_microcredits, delta_reserved_microcredits, delta_refund_frozen_microcredits,
             delta_consumed_microcredits, delta_expired_microcredits, delta_revoked_microcredits,
             balances_after, created_at_us)
          VALUES (${credential.organizationId}, ${accountId}, ${eventId}, ${l.lot_id},
             ${BigInt(l.delta_granted_microcredits)}, ${BigInt(l.delta_available_microcredits)},
             ${BigInt(l.delta_reserved_microcredits)}, ${BigInt(l.delta_refund_frozen_microcredits)},
             ${BigInt(l.delta_consumed_microcredits)}, ${BigInt(l.delta_expired_microcredits)},
             ${BigInt(l.delta_revoked_microcredits)}, ${l.balances_after}, ${nowUs})`;
      }
      // The shared quota ledger — recorded only AFTER this adjustment's own
      // ledger event exists (the recovery rows reference it): from commit on,
      // every later grant/adjustment, replay or race sees the quota spent.
      if (delta > 0n) {
        await this.recordRecoveryAllocations(
          tx,
          credential.organizationId,
          accountId,
          originalEventId,
          eventId,
          "adjustment",
          positivePlan!.allocations,
          nowUs,
        );
      }
      await this.writeOutbox(tx, {
        organizationId: credential.organizationId,
        accountId,
        ledgerEventId: eventId,
        accountSeq: seq,
        eventType: "credit.adjusted",
        payload: {
          schema_version: SCHEMA_VERSION,
          event_type: "credit.adjusted",
          ledger_event_id: eventId,
          account_seq: String(seq),
          adjustment_id: adjId,
          adjustment_type: adjustmentType,
          signed_delta_microcredits: deltaStr,
          original_period_id: periodId,
          lines: eventLines,
        },
        nowUs,
      });
      const storedAdj = (
        await tx<
          AdjustmentRow[]
        >`SELECT * FROM billing.adjustment WHERE id = ${adjId}`
      )[0]!;
      const responseBody = await this.adjustmentResult(
        tx,
        credential.organizationId,
        accountId,
        storedAdj,
        idem.requestId,
        compensationLotRow,
      );
      await this.recordIdempotency(tx, {
        organizationId: credential.organizationId,
        accountId,
        operation: "createAdjustment",
        logicalResourceId: `${originalEventId}+${adjustmentType}`,
        key: idem.key,
        normalized: idemNormalized,
        response: responseBody,
      });
      this.hooks?.beforeCommit && (await this.hooks.beforeCommit());
      return { status: 201 as const, body: responseBody };
    });
    this.hooks?.afterCommit && (await this.hooks.afterCommit());
    return body_response as { status: 201; body: Record<string, unknown> };
  }

  // ---------------------------------------------------------------- queries
  async listCreditLots(
    organizationId: string,
    accountId: string,
    page: {
      limit: number;
      cursor: CursorState | null;
      fromUs: bigint | null;
      toUs: bigint | null;
    },
    cursorSecret: string,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const acc = await this.lockAccount(tx, organizationId, accountId);
      const now = this.clock.nowUs();
      await this.materialiseExpiry(tx, acc, now);
      const cur = page.cursor;
      const rows = await tx<LotRow[]>`
        SELECT * FROM billing.credit_lot
        WHERE account_id = ${accountId}
          AND (${page.fromUs}::bigint IS NULL OR created_at_us >= ${page.fromUs}::bigint)
          AND (${page.toUs}::bigint IS NULL OR created_at_us <= ${page.toUs}::bigint)
          AND (${cur?.last_created_at_us ?? null}::bigint IS NULL OR (created_at_us, id) > (${cur?.last_created_at_us ?? 0n}, ${cur?.last_id ?? null}::uuid))
        ORDER BY created_at_us, id
        LIMIT ${page.limit + 1}`;
      const hasMore = rows.length > page.limit;
      const pageRows = rows.slice(0, page.limit);
      const items = pageRows.map((r) => this.lotJson(r));
      // The cursor anchors on the LAST ROW ACTUALLY RETURNED; the extra
      // (limit+1)-th row only proves a next page exists. Anchoring on the
      // extra row with a strict `>` seek would skip exactly that row.
      const last =
        hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]! : null;
      return {
        items,
        next_cursor:
          last === null
            ? null
            : encodeCursor(
                {
                  organization_id: organizationId,
                  billing_account_id: accountId,
                  last_created_at_us: last.createdAtUs,
                  last_id: last.id,
                },
                cursorSecret,
              ),
      };
    });
  }

  async listAdjustments(
    organizationId: string,
    accountId: string,
    page: {
      limit: number;
      cursor: CursorState | null;
      fromUs: bigint | null;
      toUs: bigint | null;
    },
    cursorSecret: string,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      await this.lockAccount(tx, organizationId, accountId);
      const cur = page.cursor;
      const rows = await tx<AdjustmentRow[]>`
        SELECT * FROM billing.adjustment
        WHERE account_id = ${accountId}
          AND (${page.fromUs}::bigint IS NULL OR created_at_us >= ${page.fromUs}::bigint)
          AND (${page.toUs}::bigint IS NULL OR created_at_us <= ${page.toUs}::bigint)
          AND (${cur?.last_created_at_us ?? null}::bigint IS NULL OR (created_at_us, id) > (${cur?.last_created_at_us ?? 0n}, ${cur?.last_id ?? null}::uuid))
        ORDER BY created_at_us, id
        LIMIT ${page.limit + 1}`;
      const hasMore = rows.length > page.limit;
      const pageRows = rows.slice(0, page.limit);
      const last =
        hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]! : null;
      return {
        items: pageRows.map((r) => this.adjustmentJson(r)),
        next_cursor:
          last === null
            ? null
            : encodeCursor(
                {
                  organization_id: organizationId,
                  billing_account_id: accountId,
                  last_created_at_us: last.createdAtUs,
                  last_id: last.id,
                },
                cursorSecret,
              ),
      };
    });
  }

  async listLedgerEvents(
    organizationId: string,
    accountId: string,
    page: {
      limit: number;
      cursor: CursorState | null;
      fromUs: bigint | null;
      toUs: bigint | null;
    },
    cursorSecret: string,
  ): Promise<Record<string, unknown>> {
    return this.db.begin(async (tx) => {
      const acc = await this.lockAccount(tx, organizationId, accountId);
      const now = this.clock.nowUs();
      await this.materialiseExpiry(tx, acc, now);
      const cur = page.cursor;
      const events = await tx<EventRow[]>`
        SELECT * FROM billing.ledger_event
        WHERE account_id = ${accountId}
          AND (${page.fromUs}::bigint IS NULL OR committed_at_us >= ${page.fromUs}::bigint)
          AND (${page.toUs}::bigint IS NULL OR committed_at_us <= ${page.toUs}::bigint)
          AND (${cur?.last_seq ?? null}::bigint IS NULL OR (account_seq, id) > (${cur?.last_seq ?? 0n}, ${cur?.last_id ?? null}::uuid))
        ORDER BY account_seq, id
        LIMIT ${page.limit + 1}`;
      const hasMore = events.length > page.limit;
      const pageEvents = events.slice(0, page.limit);
      const lines = pageEvents.length
        ? await tx<LedgerLineRow[]>`
            SELECT * FROM billing.ledger_line
            WHERE event_id = ANY(${pageEvents.map((e) => e.id)})
            ORDER BY lot_id`
        : [];
      const items = pageEvents.map((e) =>
        this.eventJson(
          e,
          lines
            .filter((l) => String(l.eventId) === e.id)
            .map((l) => this.lineJson(l)),
        ),
      );
      const last =
        hasMore && pageEvents.length > 0
          ? pageEvents[pageEvents.length - 1]!
          : null;
      return {
        items,
        next_cursor:
          last === null
            ? null
            : encodeCursor(
                {
                  organization_id: organizationId,
                  billing_account_id: accountId,
                  last_seq: last.accountSeq,
                  last_id: last.id,
                },
                cursorSecret,
              ),
      };
    });
  }

  // -------------------------------------------------------------- internals

  /**
   * THE shared recovery quota for one original deduction, consumed by BOTH
   * trusted entries — direct compensation grants AND positive adjustments,
   * whatever their type or HTTP key. The plan allocates `demand` across the
   * deduction's own lines: each line's quota is its consumed delta MINUS
   * everything already recorded in billing.recovery_allocation (in prior
   * commits or earlier in this transaction). Still-valid source lots are
   * restored IN PLACE (row-locked here; the caller moves consumed ->
   * available); expired source lots are never revived — their share lands
   * in `expiredShare` for one fresh 30-day compensation lot. ANY remainder
   * that cannot be honored rejects the WHOLE operation with zero writes.
   */
  private async planRecovery(
    tx: SqlFacade,
    organizationId: string,
    accountId: string,
    originalEventId: string,
    demand: bigint,
    nowUs: bigint,
  ): Promise<RecoveryPlan> {
    const lines = await tx<LedgerLineRow[]>`
      SELECT * FROM billing.ledger_line
      WHERE event_id = ${originalEventId} AND delta_consumed_microcredits > 0
      ORDER BY lot_id`;
    if (lines.length === 0)
      throw new LedgerError(
        "state_conflict",
        "the referenced original event is not a deduction; recovery must link an original deduction",
      );
    // The v1 -> v2 upgrade closed deductions whose PRE-upgrade restorations
    // could not be attributed to lines (or already over-restored them). No
    // entry, key or adjustment type may reopen them — the residual quota the
    // arithmetic below would compute from the partial backfill is NOT
    // trustworthy for these, so the closure is checked FIRST.
    const closedRows = await tx<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM billing.recovery_block
      WHERE organization_id = ${organizationId} AND account_id = ${accountId}
        AND original_event_id = ${originalEventId}`;
    if (closedRows[0]!.n !== "0")
      throw new LedgerError(
        "state_conflict",
        "recovery is closed for this deduction: its historical restorations could not be fully attributed",
      );
    const plan: RecoveryPlan = {
      restorations: [],
      expiredShare: 0n,
      allocations: [],
    };
    let unmatched = 0n;
    let remaining = demand;
    for (const line of lines) {
      if (remaining === 0n) break;
      const consumed = BigInt(line.deltaConsumedMicrocredits);
      const priorRows = await tx<{ s: string }[]>`
        SELECT COALESCE(SUM(restored_microcredits), 0)::text AS s
        FROM billing.recovery_allocation
        WHERE original_event_id = ${originalEventId} AND original_lot_id = ${line.lotId}`;
      const quota = consumed - BigInt(priorRows[0]!.s);
      if (quota <= 0n) continue;
      const take = quota < remaining ? quota : remaining;
      remaining -= take;
      const lotRows = await this.lotByIdForUpdate(
        tx,
        organizationId,
        accountId,
        line.lotId,
      );
      if (lotRows.length === 0) {
        unmatched += take;
        continue;
      }
      const lot = lotRows[0]!;
      if (lot.expiresAtUs !== null && lot.expiresAtUs <= nowUs) {
        // Expired source lot: its recoverable share is compensated with a
        // fresh 30-day lot instead of reviving the expired one.
        plan.expiredShare += take;
      } else {
        // In-place restoration, limited by the lot's still-consumed amount.
        const movable =
          lot.consumedMicrocredits < take ? lot.consumedMicrocredits : take;
        plan.restorations.push({ lot, amount: movable });
        unmatched += take - movable;
      }
      plan.allocations.push({ lotId: line.lotId, amount: take });
    }
    // Whatever the event never consumed (or lots that vanished) cannot be
    // restored from history at all: the whole request is refused.
    unmatched += remaining;
    if (unmatched > 0n)
      throw new LedgerError(
        "state_conflict",
        "the original deduction does not carry enough recoverable quota; nothing was written",
      );
    return plan;
  }

  /**
   * Record the recovery rows INSIDE the same transaction that moves the lot
   * components: from commit on, every later grant/adjustment — and the
   * database's own quota guard trigger — sees this quota as spent.
   */
  private async recordRecoveryAllocations(
    tx: SqlFacade,
    organizationId: string,
    accountId: string,
    originalEventId: string,
    restorationEventId: string,
    via: "credit_grant" | "adjustment",
    allocations: { lotId: string; amount: bigint }[],
    nowUs: bigint,
  ): Promise<void> {
    for (const a of allocations) {
      await tx`
        INSERT INTO billing.recovery_allocation
          (organization_id, account_id, original_event_id, original_lot_id,
           restored_microcredits, restored_via, restoration_event_id, created_at_us)
        VALUES (${organizationId}, ${accountId}, ${originalEventId}, ${a.lotId},
           ${a.amount}, ${via}, ${restorationEventId}, ${nowUs})`;
    }
  }

  private async tryLocks(tx: SqlFacade, keys: string[]): Promise<void> {
    for (const key of keys) {
      const rows = await tx<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`;
      if (!rows[0]!.locked)
        throw new LedgerError(
          "idempotency_in_progress",
          "the same idempotency scope is executing elsewhere; retry",
          1,
        );
    }
  }

  private async lockAccount(
    tx: SqlFacade,
    organizationId: string,
    accountId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await tx<Record<string, unknown>[]>`
      SELECT * FROM billing.account
      WHERE id = ${accountId} AND organization_id = ${organizationId}
      FOR UPDATE`;
    if (rows.length === 0)
      // Never reveals whether the account exists elsewhere.
      throw new LedgerError(
        "resource_not_found",
        "billing account not found in this organization scope",
      );
    return rows[0]!;
  }

  private async nextAccountSeq(
    tx: SqlFacade,
    accountId: string,
  ): Promise<bigint> {
    const rows = await tx<{ next: bigint }[]>`
      SELECT COALESCE(MAX(account_seq), 0) + 1 AS next FROM billing.ledger_event
      WHERE account_id = ${accountId}`;
    return rows[0]!.next;
  }

  private async eventById(
    tx: SqlFacade,
    organizationId: string,
    accountId: string,
    eventId: string,
  ): Promise<EventRow[]> {
    if (!UUID_RE.test(eventId)) return [];
    return tx<EventRow[]>`
      SELECT * FROM billing.ledger_event
      WHERE id = ${eventId} AND organization_id = ${organizationId} AND account_id = ${accountId}`;
  }

  private async lotById(
    tx: SqlFacade,
    organizationId: string,
    accountId: string,
    lotId: string,
  ): Promise<LotRow> {
    const rows = await tx<LotRow[]>`
      SELECT * FROM billing.credit_lot WHERE id = ${lotId} AND organization_id = ${organizationId} AND account_id = ${accountId}`;
    return rows[0]!;
  }

  private async lotByIdForUpdate(
    tx: SqlFacade,
    organizationId: string,
    accountId: string,
    lotId: string,
  ): Promise<LotRow[]> {
    return tx<LotRow[]>`
      SELECT * FROM billing.credit_lot
      WHERE id = ${lotId} AND organization_id = ${organizationId} AND account_id = ${accountId}
      FOR UPDATE`;
  }

  private async replayIdempotency(
    tx: SqlFacade,
    scope: {
      organizationId: string;
      accountId: string;
      operation: string;
      logicalResourceId: string;
      key: string;
      normalized: string;
    },
  ): Promise<
    | { status: 201; body: Record<string, unknown> }
    | { status: 200; body: Record<string, unknown> }
    | null
  > {
    const rows = await tx<Record<string, unknown>[]>`
      SELECT * FROM billing.idempotency
      WHERE organization_id = ${scope.organizationId} AND account_id = ${scope.accountId}
        AND operation = ${scope.operation} AND logical_resource_id = ${scope.logicalResourceId}
        AND key = ${scope.key}`;
    if (rows.length === 0) return null;
    const row = rows[0]!;
    if (row.requestHash !== sha256(scope.normalized))
      throw new LedgerError(
        "idempotency_conflict",
        "same idempotency key with a different normalized request",
      );
    return { status: 200, body: row.response as Record<string, unknown> };
  }

  private async recordIdempotency(
    tx: SqlFacade,
    args: {
      organizationId: string;
      accountId: string;
      operation: string;
      logicalResourceId: string;
      key: string;
      normalized: string;
      response: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx`
      INSERT INTO billing.idempotency
        (organization_id, account_id, operation, logical_resource_id, key, request, request_hash, response, schema_version, created_at_us)
      VALUES (${args.organizationId}, ${args.accountId}, ${args.operation}, ${args.logicalResourceId},
         ${args.key}, ${JSON.parse(args.normalized)}, ${sha256(args.normalized)},
         ${args.response}, ${SCHEMA_VERSION}, ${this.clock.nowUs()})`;
  }

  private async writeOutbox(
    tx: SqlFacade,
    args: {
      organizationId: string;
      accountId: string;
      ledgerEventId: string;
      accountSeq: bigint;
      eventType: string;
      payload: Record<string, unknown>;
      nowUs: bigint;
    },
  ): Promise<string> {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO billing.outbox_event
        (organization_id, account_id, ledger_event_id, account_seq, event_type, schema_version, payload, created_at_us)
      VALUES (${args.organizationId}, ${args.accountId}, ${args.ledgerEventId}, ${args.accountSeq},
         ${args.eventType}, ${SCHEMA_VERSION}, ${args.payload}, ${args.nowUs})
      RETURNING id`;
    const id = rows[0]!.id;
    await tx`
      INSERT INTO billing.outbox_delivery (outbox_event_id, status, attempts, updated_at_us)
      VALUES (${id}, 'pending', 0, ${args.nowUs})`;
    return id;
  }

  /**
   * Materialise due expiries under the account lock: ONLY the available
   * component moves to expired; reserved and refund_frozen stay in flight for
   * the later settlement/refund step. Replays never duplicate: after the move
   * the lot has nothing left to expire. One credit.expired event (+ one
   * outbox record) per materialisation batch.
   */
  private async materialiseExpiry(
    tx: SqlFacade,
    account: Record<string, unknown>,
    nowUs: bigint,
  ): Promise<void> {
    const due = await tx<LotRow[]>`
      SELECT * FROM billing.credit_lot
      WHERE account_id = ${account.id} AND expires_at_us IS NOT NULL AND expires_at_us <= ${nowUs}
        AND available_microcredits > 0
      ORDER BY id
      FOR UPDATE`;
    if (due.length === 0) return;
    const eventId = randomUUID();
    const lines: Record<string, unknown>[] = [];
    for (const lot of due) {
      const moved = lot.availableMicrocredits;
      const next = {
        granted: lot.grantedMicrocredits,
        available: 0n,
        reserved: lot.reservedMicrocredits,
        refundFrozen: lot.refundFrozenMicrocredits,
        consumed: lot.consumedMicrocredits,
        expired: lot.expiredMicrocredits + moved,
        revoked: lot.revokedMicrocredits,
      };
      await tx`
        UPDATE billing.credit_lot SET
          available_microcredits = 0,
          expired_microcredits = ${next.expired},
          status = 'expired',
          revision = revision + 1,
          updated_at_us = ${nowUs}
        WHERE id = ${lot.id}`;
      lines.push({
        lot_id: lot.id,
        delta_granted_microcredits: "0",
        delta_available_microcredits: S(-moved),
        delta_reserved_microcredits: "0",
        delta_refund_frozen_microcredits: "0",
        delta_consumed_microcredits: "0",
        delta_expired_microcredits: S(moved),
        delta_revoked_microcredits: "0",
        balances_after: this.balancesObject(next),
      });
    }
    const seq = await this.nextAccountSeq(tx, String(account.id));
    await tx`
      INSERT INTO billing.ledger_event
        (id, organization_id, account_id, event_type, account_seq, actor_subject_id, reason,
         occurred_at_us, committed_at_us)
      VALUES (${eventId}, ${account.organizationId}, ${account.id}, 'credit.expired', ${seq},
         'system:expiry', 'scheduled/active available credits reached their expiry instant',
         ${nowUs}, ${nowUs})`;
    for (const line of lines) {
      const l = line as Record<string, string>;
      await tx`
        INSERT INTO billing.ledger_line
          (organization_id, account_id, event_id, lot_id, delta_granted_microcredits,
           delta_available_microcredits, delta_reserved_microcredits, delta_refund_frozen_microcredits,
           delta_consumed_microcredits, delta_expired_microcredits, delta_revoked_microcredits,
           balances_after, created_at_us)
        VALUES (${account.organizationId}, ${account.id}, ${eventId}, ${l.lot_id},
           ${BigInt(l.delta_granted_microcredits)}, ${BigInt(l.delta_available_microcredits)},
           ${BigInt(l.delta_reserved_microcredits)}, ${BigInt(l.delta_refund_frozen_microcredits)},
           ${BigInt(l.delta_consumed_microcredits)}, ${BigInt(l.delta_expired_microcredits)},
           ${BigInt(l.delta_revoked_microcredits)}, ${l.balances_after}, ${nowUs})`;
    }
    await this.writeOutbox(tx, {
      organizationId: String(account.organizationId),
      accountId: String(account.id),
      ledgerEventId: eventId,
      accountSeq: seq,
      eventType: "credit.expired",
      payload: {
        schema_version: SCHEMA_VERSION,
        event_type: "credit.expired",
        ledger_event_id: eventId,
        account_seq: String(seq),
        lines,
      },
      nowUs,
    });
  }

  private async readSnapshot(
    tx: SqlFacade,
    account: Record<string, unknown>,
    nowUs: bigint,
  ): Promise<AccountSnapshot> {
    // Spendable = available on lots whose validity window COVERS `now`
    // (half-open: arrived, not yet expired); scheduled lots are NOT spendable
    // yet, and an already-expired instant contributes nothing even before the
    // expiry projection has run. Reserved/refund-frozen stay in flight
    // regardless of validity. Summed over numeric so several bigint terms
    // cannot overflow the int64 aggregate.
    const rows = await tx<Record<string, string>[]>`
      SELECT
        COALESCE(SUM(available_microcredits) FILTER (
          WHERE valid_from_us <= ${nowUs} AND (expires_at_us IS NULL OR expires_at_us > ${nowUs})), 0)::text AS avail,
        COALESCE(SUM(reserved_microcredits), 0)::text AS reserved,
        COALESCE(SUM(refund_frozen_microcredits), 0)::text AS frozen
      FROM billing.credit_lot WHERE account_id = ${account.id}`;
    const r = rows[0]!;
    return {
      id: String(account.id),
      schema_version: SCHEMA_VERSION,
      organization_id: String(account.organizationId),
      billing_account_id: String(account.id),
      created_at_us: S(account.createdAtUs),
      updated_at_us: S(account.updatedAtUs),
      revision: S(account.revision),
      owner_subject_id: String(account.ownerSubjectId),
      personal_workspace_id: String(account.personalWorkspaceId),
      currency: "CNY",
      available_microcredits: r.avail!,
      reserved_microcredits: r.reserved!,
      refund_frozen_microcredits: r.frozen!,
      status: String(account.status),
    };
  }

  private lotComponents(lot: LotRow): Components {
    return {
      granted: lot.grantedMicrocredits,
      available: lot.availableMicrocredits,
      reserved: lot.reservedMicrocredits,
      refundFrozen: lot.refundFrozenMicrocredits,
      consumed: lot.consumedMicrocredits,
      expired: lot.expiredMicrocredits,
      revoked: lot.revokedMicrocredits,
    };
  }

  private balancesObject(c: Components): Record<string, string> {
    return {
      granted_microcredits: String(c.granted),
      available_microcredits: String(c.available),
      reserved_microcredits: String(c.reserved),
      refund_frozen_microcredits: String(c.refundFrozen),
      consumed_microcredits: String(c.consumed),
      expired_microcredits: String(c.expired),
      revoked_microcredits: String(c.revoked),
    };
  }

  private lotStatusAfter(next: Components, lot: LotRow): string {
    if (lot.status === "revoked") return "revoked";
    if (lot.expiresAtUs !== null && lot.expiresAtUs <= this.clock.nowUs())
      return "expired";
    const inFlight = next.available + next.reserved + next.refundFrozen;
    if (inFlight === 0n && next.granted > 0n) return "exhausted";
    if (lot.status === "scheduled" && lot.validFromUs > this.clock.nowUs())
      return "scheduled";
    return "active";
  }

  payloadOf(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  lotJson(lot: LotRow): Record<string, unknown> {
    return {
      id: lot.id,
      schema_version: SCHEMA_VERSION,
      organization_id: lot.organizationId,
      billing_account_id: lot.accountId,
      created_at_us: S(lot.createdAtUs),
      updated_at_us: S(lot.updatedAtUs),
      revision: S(lot.revision),
      source_type: lot.sourceType,
      source_event_id: lot.sourceEventId,
      source_period_id: lot.sourcePeriodId,
      granted_microcredits: S(lot.grantedMicrocredits),
      available_microcredits: S(lot.availableMicrocredits),
      reserved_microcredits: S(lot.reservedMicrocredits),
      refund_frozen_microcredits: S(lot.refundFrozenMicrocredits),
      consumed_microcredits: S(lot.consumedMicrocredits),
      expired_microcredits: S(lot.expiredMicrocredits),
      revoked_microcredits: S(lot.revokedMicrocredits),
      valid_from_us: S(lot.validFromUs),
      expires_at_us: lot.expiresAtUs === null ? null : S(lot.expiresAtUs),
      status: lot.status,
    };
  }

  adjustmentJson(a: AdjustmentRow): Record<string, unknown> {
    return {
      id: a.id,
      schema_version: SCHEMA_VERSION,
      organization_id: a.organizationId,
      billing_account_id: a.accountId,
      created_at_us: S(a.createdAtUs),
      updated_at_us: S(a.createdAtUs),
      revision: "1",
      original_event_id: a.originalEventId,
      adjustment_type: a.adjustmentType,
      source_event_id: a.sourceEventId,
      signed_delta_microcredits: S(a.signedDeltaMicrocredits),
      reason: a.reason,
      actor_subject_id: a.actorSubjectId,
      original_period_id: a.originalPeriodId,
      effective_at_us: S(a.effectiveAtUs),
      compensation_lot_id: a.compensationLotId,
      status: "posted",
    };
  }

  lineJson(l: {
    lotId: string;
    deltaGrantedMicrocredits: bigint;
    deltaAvailableMicrocredits: bigint;
    deltaReservedMicrocredits: bigint;
    deltaRefundFrozenMicrocredits: bigint;
    deltaConsumedMicrocredits: bigint;
    deltaExpiredMicrocredits: bigint;
    deltaRevokedMicrocredits: bigint;
    balancesAfter: Record<string, string>;
  }): Record<string, unknown> {
    return {
      lot_id: String(l.lotId),
      delta_granted_microcredits: S(l.deltaGrantedMicrocredits),
      delta_available_microcredits: S(l.deltaAvailableMicrocredits),
      delta_reserved_microcredits: S(l.deltaReservedMicrocredits),
      delta_refund_frozen_microcredits: S(l.deltaRefundFrozenMicrocredits),
      delta_consumed_microcredits: S(l.deltaConsumedMicrocredits),
      delta_expired_microcredits: S(l.deltaExpiredMicrocredits),
      delta_revoked_microcredits: S(l.deltaRevokedMicrocredits),
      balances_after: l.balancesAfter,
    };
  }

  eventJson(
    e: EventRow,
    lines: Record<string, unknown>[],
  ): Record<string, unknown> {
    return {
      id: e.id,
      schema_version: SCHEMA_VERSION,
      organization_id: e.organizationId,
      billing_account_id: e.accountId,
      event_type: e.eventType,
      account_seq: S(e.accountSeq),
      source_namespace: e.sourceNamespace,
      source_event_id: e.sourceEventId,
      original_event_id: e.adjustmentId,
      adjustment_id: e.adjustmentId,
      actor_subject_id: e.actorSubjectId,
      reason: e.reason,
      original_period_id: e.originalPeriodId,
      occurred_at_us: S(e.occurredAtUs),
      committed_at_us: S(e.committedAtUs),
      lines,
    };
  }

  private async adjustmentResult(
    tx: SqlFacade,
    organizationId: string,
    accountId: string,
    a: AdjustmentRow,
    requestId: string,
    compensationLotRow?: LotRow | null,
  ): Promise<Record<string, unknown>> {
    let compLot: Record<string, unknown> | null = null;
    if (compensationLotRow) {
      compLot = this.lotJson(compensationLotRow);
    } else if (a.compensationLotId) {
      compLot = this.lotJson(
        await this.lotById(tx, organizationId, accountId, a.compensationLotId),
      );
    }
    return {
      adjustment: this.adjustmentJson(a),
      compensation_lot: compLot,
      request_id: requestId,
    };
  }
}

// ------------------------------------------------------------------ cursors
export interface CursorState {
  organization_id: string;
  billing_account_id: string;
  last_created_at_us?: bigint;
  last_id?: string;
  last_seq?: bigint;
}

export function encodeCursor(state: CursorState, secret: string): string {
  const body = canonicalJson({
    organization_id: state.organization_id,
    billing_account_id: state.billing_account_id,
    last_created_at_us:
      state.last_created_at_us === undefined
        ? undefined
        : String(state.last_created_at_us),
    last_seq: state.last_seq === undefined ? undefined : String(state.last_seq),
    last_id: state.last_id,
  });
  const payload = Buffer.from(body).toString("base64url");
  const sig = createHash("sha256")
    .update(`${payload}.${secret}`)
    .digest("base64url")
    .slice(0, 32);
  return `${payload}.${sig}`;
}

export function decodeCursor(raw: string, secret: string): CursorState | null {
  const [payload, sig] = raw.split(".");
  if (!payload || !sig)
    throw new LedgerError(
      "invalid_cursor",
      "cursor is not a signed opaque token",
    );
  const expect = createHash("sha256")
    .update(`${payload}.${secret}`)
    .digest("base64url")
    .slice(0, 32);
  if (sig !== expect)
    throw new LedgerError("invalid_cursor", "cursor signature does not verify");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
  } catch {
    throw new LedgerError("invalid_cursor", "cursor payload is not decodable");
  }
  return {
    organization_id: String(body.organization_id),
    billing_account_id: String(body.billing_account_id),
    last_created_at_us:
      body.last_created_at_us === undefined
        ? undefined
        : BigInt(String(body.last_created_at_us)),
    last_seq:
      body.last_seq === undefined ? undefined : BigInt(String(body.last_seq)),
    last_id: body.last_id === undefined ? undefined : String(body.last_id),
  };
}

// Keep the schema import referenced: table/constraint names in this module's
// documentation mirror schema.ts, and future query migrations will import it.
void schema;
