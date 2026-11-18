/**
 * #64 credit-ledger migration entrypoint — the ONLY supported way to bring
 * the `billing` schema up.
 *
 * Deliberately separate from the application's `scripts/migrate.ts` and its
 * `../.env` / `DATABASE_URL` conventions: the isolated ledger environment
 * passes its OWN one-time URLs through BILLING_LEDGER_OWNER_URL (migration
 * owner) and BILLING_LEDGER_APP_URL / BILLING_LEDGER_APP_PASSWORD (restricted
 * runtime role). Nothing here reads the application's `.env`.
 *
 * Phases, all idempotent:
 *   1. apply `server/billing-drizzle` through `applyMigrations` with the
 *      ledger's own journal (`billing.__drizzle_migrations`) — transactional,
 *      advisory-locked, and refusing an out-of-reach journal like the app's;
 *   2. install the immutability triggers (BEFORE UPDATE/DELETE guards on the
 *      append-only objects; lot source/granted protection on credit_lot);
 *   3. ensure the restricted runtime role `billing_ledger_app` and its grants:
 *      SELECT/INSERT everywhere it needs, UPDATE only on the projections
 *      (account, credit_lot components, outbox_delivery), NO DELETE/TRUNCATE
 *      anywhere, and no UPDATE on ledger_event / ledger_line / adjustment /
 *      business_event / idempotency / outbox_event even by permission slip.
 *
 * Re-running against a migrated database performs no visible changes (AC1
 * "repeatable"), and running against an out-of-reach journal refuses WITHOUT
 * touching anything, exactly like the application migrator.
 */
import { join } from "node:path";
import postgres from "postgres";
import { applyMigrations, MIGRATION_LOCK, MigrationsJournal } from "../src/db/apply-migrations";

export const BILLING_MIGRATIONS_JOURNAL: MigrationsJournal = {
  migrationsSchema: "billing",
  migrationsTable: "__drizzle_migrations",
};

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "billing-drizzle");

/**
 * Immutability triggers + runtime role, written as idempotent DDL so that
 * every run converges to the same state.
 *
 * Triggers, not only grants: a grant can be re-granted by an operator, and
 * `superuser` bypasses grants anyway. RAISE EXCEPTION in a BEFORE trigger
 * blocks UPDATE/DELETE for every role on the append-only history, while the
 * projections the ledger legitimately maintains (account status/revision,
 * credit_lot components/status/revision, outbox_delivery) stay writable.
 *
 * Every trigger is ensured by a SINGLE atomic `DO` statement that creates it
 * only when absent — there is deliberately NO `DROP TRIGGER` here. A
 * drop-then-recreate split across statements would leave, if the process died
 * between the two, a database whose journal says "migrated" while its history
 * sits unprotected. Create-if-absent inside one statement can only leave the
 * trigger present or untouched, never half-installed.
 */
function ensureTrigger(table: string, name: string, fn: string, ops: string): string {
  return `DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = '${name}' AND tgrelid = 'billing.${table}'::regclass AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ${name} ${ops} ON billing.${table}
    FOR EACH ROW EXECUTE FUNCTION billing.${fn}();
  END IF;
END $do$`;
}

const HARDENING_STATEMENTS: string[] = [
  // append-only history: no UPDATE, no DELETE for ANY role
  `CREATE OR REPLACE FUNCTION billing.refuse_rewrite() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'billing ledger history is append-only: % on %.% by % is refused',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION billing.refuse_lot_source_rewrite() RETURNS trigger AS $$
BEGIN
  IF OLD.granted_microcredits      <> NEW.granted_microcredits
  OR OLD.source_type               <> NEW.source_type
  OR OLD.source_event_id           <> NEW.source_event_id
  OR OLD.source_period_id          IS DISTINCT FROM NEW.source_period_id
  OR OLD.valid_from_us             <> NEW.valid_from_us
  OR OLD.expires_at_us             IS DISTINCT FROM NEW.expires_at_us
  OR OLD.account_id                <> NEW.account_id
  OR OLD.organization_id           <> NEW.organization_id
  OR OLD.compensation_for_event_id IS DISTINCT FROM NEW.compensation_for_event_id
  OR OLD.created_at_us             <> NEW.created_at_us
  THEN
    RAISE EXCEPTION 'credit lot source identity and original grant are immutable (lot %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql`,
  ...[
    ["ledger_event", "billing_ledger_event_immutable", "refuse_rewrite", "BEFORE UPDATE OR DELETE"],
    ["ledger_line", "billing_ledger_line_immutable", "refuse_rewrite", "BEFORE UPDATE OR DELETE"],
    ["adjustment", "billing_adjustment_immutable", "refuse_rewrite", "BEFORE UPDATE OR DELETE"],
    ["business_event", "billing_business_event_immutable", "refuse_rewrite", "BEFORE UPDATE OR DELETE"],
    ["idempotency", "billing_idempotency_immutable", "refuse_rewrite", "BEFORE UPDATE OR DELETE"],
    ["outbox_event", "billing_outbox_event_immutable", "refuse_rewrite", "BEFORE UPDATE OR DELETE"],
    ["recovery_allocation", "billing_recovery_allocation_immutable", "refuse_rewrite", "BEFORE UPDATE OR DELETE"],
  ].map(([table, name, fn, ops]) => ensureTrigger(table, name, fn, ops)),
  // credit_lot: components/status/revision updatable, source identity not; no delete
  ensureTrigger(
    "credit_lot",
    "billing_credit_lot_source_protected",
    "refuse_lot_source_rewrite",
    "BEFORE UPDATE",
  ),
  ensureTrigger("credit_lot", "billing_credit_lot_immutable", "refuse_rewrite", "BEFORE DELETE"),
  // THE recovery quota backstop: the cumulative restoration recorded against
  // one original deduction line can never exceed what that line consumed —
  // across ALL entries (grants, adjustments), concurrent or replayed. The
  // service enforces the same rule inside the account lock; this trigger is
  // what the DATABASE promises even if future code forgets it.
  `CREATE OR REPLACE FUNCTION billing.refuse_over_recovery() RETURNS trigger AS $$
BEGIN
  IF (SELECT delta_consumed_microcredits FROM billing.ledger_line
      WHERE event_id = NEW.original_event_id AND lot_id = NEW.original_lot_id)
     IS NULL THEN
    RAISE EXCEPTION 'recovery allocation % references a non-deduction line (event %, lot %)',
      NEW.id, NEW.original_event_id, NEW.original_lot_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.restored_microcredits + COALESCE((
       SELECT SUM(restored_microcredits) FROM billing.recovery_allocation
       WHERE original_event_id = NEW.original_event_id
         AND original_lot_id = NEW.original_lot_id
         AND (TG_OP = 'INSERT' OR id <> NEW.id)), 0) >
     (SELECT delta_consumed_microcredits FROM billing.ledger_line
      WHERE event_id = NEW.original_event_id AND lot_id = NEW.original_lot_id)
  THEN
    RAISE EXCEPTION 'recovery allocation exceeds the original deduction line quota (event %, lot %)',
      NEW.original_event_id, NEW.original_lot_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql`,
  ensureTrigger(
    "recovery_allocation",
    "billing_recovery_line_quota_guard",
    "refuse_over_recovery",
    "BEFORE INSERT",
  ),
];

export async function ensureRuntimeRole(
  ownerClient: Pick<postgres.Sql, "unsafe">,
  password: string,
): Promise<void> {
  // A fixed role name; the password is one-time per isolated run and never
  // logged. ALTER ... with a literal is fine here: the value never lands in
  // any file or report, and parameterization of role options is not supported.
  await ownerClient.unsafe(
    `DO $do$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billing_ledger_app') THEN
         CREATE ROLE billing_ledger_app LOGIN;
       END IF;
     END $do$`,
  );
  await ownerClient.unsafe(
    `ALTER ROLE billing_ledger_app WITH LOGIN PASSWORD ${literal(password)}`,
  );
  await ownerClient.unsafe(
    `GRANT USAGE ON SCHEMA billing TO billing_ledger_app;
     GRANT SELECT ON ALL TABLES IN SCHEMA billing TO billing_ledger_app;
     GRANT INSERT ON ALL TABLES IN SCHEMA billing TO billing_ledger_app;
     GRANT UPDATE ON billing.account, billing.credit_lot, billing.outbox_delivery TO billing_ledger_app;
     GRANT USAGE ON ALL SEQUENCES IN SCHEMA billing TO billing_ledger_app;`,
  );
  // History is not deletable and not rewritable by the runtime role, whatever
  // a future grant file says.
  await ownerClient.unsafe(
    `REVOKE UPDATE, DELETE, TRUNCATE ON billing.ledger_event, billing.ledger_line,
       billing.adjustment, billing.business_event, billing.idempotency,
       billing.outbox_event FROM billing_ledger_app;
     REVOKE DELETE, TRUNCATE ON billing.account, billing.credit_lot,
       billing.outbox_delivery FROM billing_ledger_app;
     REVOKE CREATE ON SCHEMA billing FROM billing_ledger_app;`,
  );
}

function literal(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

export async function runBillingMigrations(
  ownerUrl: string,
  opts: { appPassword?: string } = {},
): Promise<void> {
  // Notices (IF NOT EXISTS skips) are expected and noisy; keep the run legible.
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await applyMigrations(owner, MIGRATIONS_FOLDER, BILLING_MIGRATIONS_JOURNAL);
    // Hardening and authorization converge inside ONE transaction that holds
    // the SAME advisory lock the versioned migration uses: a concurrent or
    // crashed run can never leave triggers dropped while the journal claims
    // migrated, and the whole protection surface (functions, triggers, role
    // grants/revokes) commits or rolls back together.
    await owner.begin(async (tx) => {
      await tx.unsafe(
        `select pg_advisory_xact_lock(hashtextextended('${MIGRATION_LOCK}', 0))`,
      );
      for (const stmt of HARDENING_STATEMENTS) {
        await tx.unsafe(stmt);
      }
      if (opts.appPassword) {
        await ensureRuntimeRole(tx, opts.appPassword);
      }
    });
    console.info(
      JSON.stringify({ type: "billing-migrations-applied", status: "ok" }),
    );
  } finally {
    await owner.end({ timeout: 5 }).catch(() => {});
  }
}

if (import.meta.main) {
  const ownerUrl = process.env.BILLING_LEDGER_OWNER_URL;
  if (!ownerUrl) {
    console.error(
      "BILLING_LEDGER_OWNER_URL must be set (isolated environment; the application .env is never read here)",
    );
    process.exit(1);
  }
  const appPassword = process.env.BILLING_LEDGER_APP_PASSWORD;
  await runBillingMigrations(ownerUrl, {
    appPassword: appPassword === "" ? undefined : appPassword,
  }).catch((e: unknown) => {
    console.error(
      `billing migration failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  });
}
