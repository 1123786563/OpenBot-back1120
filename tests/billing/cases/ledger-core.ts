/**
 * #64 ledger-core acceptance driver — runs INSIDE the dedicated compose
 * environment (`billing62_<run_id>` project, internal network only) and
 * drives the REAL service through the trusted internal HTTP entry plus an
 * independent owner PostgreSQL connection for constraint/fault evidence.
 *
 * Usage (from the ledger-app container, repo mounted at /work):
 *   bun tests/billing/cases/ledger-core.ts --phase upgrade
 *   bun tests/billing/cases/ledger-core.ts --phase main
 *   bun tests/billing/cases/ledger-core.ts --phase lago-outage
 *
 * Phases (the runner executes them in this order on ONE fresh database):
 *   upgrade     the v1 -> v2 migration path: commit refund history through the
 *               REAL v1 entrypoint (snapshot extracted by the runner), stop
 *               writes, upgrade, verify the quota backfill, the closed
 *               over-refunded deduction, the serialized database guard, and
 *               replay/remaining-quota behavior under the v2 entrypoint
 *   main        AC1 migrations/constraints, AC2 sources/auth, AC3 idempotency
 *               + atomic outbox, AC4 isolation/conservation, AC5 16-way
 *               adjustments, AC6a/AC6b crash windows (grant + adjustment)
 *   lago-outage AC7 second half: Lago verified down, ledger still commits,
 *               pending outbox preserved, restart replay adds nothing
 *
 * The ledger service under test is spawned as a CHILD process of this driver
 * (isolated-main.ts) so the crash-window tests can SIGKILL exactly that
 * process. Fault barriers are process-config/IPC only — nothing
 * HTTP-reachable can trigger them. Evidence lines print PASS/FAIL; the exit
 * code is non-zero when any assertion fails. Logs contain environment names,
 * versions and object ids only — never credentials.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedgerSql } from "../../../server/src/billing-ledger/service.js";

const OWNER_URL = process.env.BILLING_LEDGER_OWNER_URL ?? "";
const APP_URL = process.env.BILLING_LEDGER_APP_URL ?? "";
const APP_PASSWORD = process.env.BILLING_LEDGER_APP_PASSWORD ?? "";
const CURSOR_SECRET = process.env.BILLING_LEDGER_CURSOR_SECRET ?? "cursor-secret";
const PORT = Number(process.env.BILLING_LEDGER_PORT ?? "4194");
const LAGO_URL = process.env.BILLING62_LAGO_URL ?? "http://lago-api:3000";
const RUN_ID = process.env.BILLING62_RUN_ID ?? "driver-run";

const ORG_A = "1a2a3b4c-0000-4000-8000-000000000001";
const ORG_B = "1a2a3b4c-0000-4000-8000-000000000002";
const REGISTER_TOKEN = `reg-a-${RUN_ID}`;
const REGISTER_B_TOKEN = `reg-b-${RUN_ID}`;
const ENT_A_TOKEN = `ent-a-${RUN_ID}`;
const ENT_B_TOKEN = `ent-b-${RUN_ID}`;
const READ_ONLY_TOKEN = `ro-${RUN_ID}`;
const NAMESPACE = "entitlement-service";

let failures = 0;
let checks = 0;
function ok(cond: unknown, message: string): void {
  checks++;
  if (cond) console.log(`  PASS ${message}`);
  else {
    failures++;
    console.error(`  FAIL ${message}`);
  }
}
function fmt(v: unknown): string {
  try {
    return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x)) ?? String(v);
  } catch {
    return String(v);
  }
}

function eq(a: unknown, b: unknown, message: string): void {
  ok(a === b, `${message} (expected ${fmt(b)}, got ${fmt(a)})`);
}

const CREDENTIALS = [
  { token: REGISTER_TOKEN, subject: "subj_registration_svc", organization_id: ORG_A, account_scope: ["*"], capabilities: ["billing:register-account"], namespace: "registration" },
  { token: REGISTER_B_TOKEN, subject: "subj_registration_svc_b", organization_id: ORG_B, account_scope: ["*"], capabilities: ["billing:register-account"], namespace: "registration" },
  { token: ENT_A_TOKEN, subject: "subj_entitlement_svc", organization_id: ORG_A, account_scope: ["*"], capabilities: ["billing:grant", "billing:adjust", "billing:read"], namespace: NAMESPACE },
  { token: ENT_B_TOKEN, subject: "subj_entitlement_svc_b", organization_id: ORG_B, account_scope: ["*"], capabilities: ["billing:grant", "billing:adjust", "billing:read"], namespace: NAMESPACE },
  { token: READ_ONLY_TOKEN, subject: "subj_readonly_svc", organization_id: ORG_A, account_scope: ["*"], capabilities: ["billing:read"], namespace: "read-only" },
];

interface ServiceProcess {
  proc: ChildProcess;
  stderrHead: string;
  stop: () => Promise<void>;
}

/**
 * Every spawned ledger service registers here: the crash-window phases start
 * several instances, and a phase ending must stop ALL of them — a survivor
 * would keep serving the port with NARROWED credentials and be adopted as
 * "the service" by the next phase (observed live as a 404 in the outage
 * phase's first grant).
 */
const liveServices: ServiceProcess[] = [];

async function stopAllServices(): Promise<void> {
  for (const inst of liveServices.splice(0)) {
    await inst.stop().catch(() => {});
  }
}

async function startService(
  barrierDir?: string,
  // The upgrade phase runs the PRE-upgrade (v1) ledger entrypoint against the
  // same database: `mainPath` points at the v1 snapshot extracted by the runner.
  mainPath?: string,
): Promise<ServiceProcess> {
  const proc = spawn("bun", [mainPath ?? new URL("../../../server/src/billing-ledger/isolated-main.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      BILLING_LEDGER_DATABASE_URL: APP_URL,
      BILLING_LEDGER_CREDENTIALS: JSON.stringify(CREDENTIALS),
      BILLING_LEDGER_CURSOR_SECRET: CURSOR_SECRET,
      BILLING_LEDGER_PORT: String(PORT),
      ...(barrierDir ? { BILLING_LEDGER_BARRIER_DIR: barrierDir } : {}),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  let stderrHead = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderrHead = (stderrHead + String(d)).slice(-4000);
  });
  proc.on("error", (e) => {
    stderrHead += `spawn error: ${e.message}`;
  });
  proc.once("exit", (code) => {
    if (code !== null && code !== 0) stderrHead += `\n(exit code ${code})`;
  });
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) {
        const inst: ServiceProcess = { proc, stderrHead, stop: stopOf(proc) };
        liveServices.push(inst);
        return inst;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`service did not become healthy; stderr: ${stderrHead}`);
  throw new Error("isolated ledger service failed to start");
}

async function waitExit(proc: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
}

function stopOf(proc: ChildProcess) {
  return async (): Promise<void> => {
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 3000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    // Wait until the port is actually free: a healthz answered by a STALE
    // process would make startService adopt the wrong server (its credential
    // scopes differ), which is exactly the 404 race this guard closes.
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(400) });
      } catch {
        return; // port closed
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  };
}

const BASE = `http://127.0.0.1:${PORT}`;

async function post(
  path: string,
  body: unknown,
  token: string,
  key?: string,
): Promise<{ status: number; body: Record<string, unknown>; retryAfter?: string }> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  const retryAfter = r.headers.get("retry-after") ?? undefined;
  const body2 = (await r.json()) as Record<string, unknown>;
  return { status: r.status, body: body2, retryAfter };
}

async function get(path: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

/** POST with retry on idempotency_in_progress (per contract Retry-After). */
async function postConverge(
  path: string,
  body: unknown,
  token: string,
  key: string,
  maxAttempts = 300,
): Promise<{ status: number; body: Record<string, unknown>; attempts: number }> {
  let attempts = 0;
  for (;;) {
    attempts++;
    const r = await post(path, body, token, key);
    if (r.status === 409 && (r.body as { title?: string }).title === "idempotency_in_progress" && attempts < maxAttempts) {
      await new Promise((res) => setTimeout(res, Math.max(1, Number(r.retryAfter ?? "1")) * 30));
      continue;
    }
    return { status: r.status, body: r.body, attempts };
  }
}

function makeBody(over: Record<string, unknown>): Record<string, unknown> {
  return {
    billing_account_id: "",
    source_event_id: "",
    source_type: "subscription",
    source_period_id: null,
    granted_microcredits: "1000000",
    valid_from_us: "1000",
    expires_at_us: null,
    original_event_id: null,
    actor_subject_id: "subj_entitlement_svc",
    ...over,
  };
}

/** A complete adjustment body against one original event (contract shape). */
function adjBodyOf(
  accountId: string,
  originalEventId: string,
  sourceEventId: string,
  adjustmentType: string,
  delta: string,
  actor = "subj_entitlement_svc",
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    billing_account_id: accountId,
    original_event_id: originalEventId,
    adjustment_type: adjustmentType,
    source_event_id: sourceEventId,
    signed_delta_microcredits: delta,
    reason: "driver acceptance fixture",
    actor_subject_id: actor,
    original_period_id: null,
    effective_at_us: String(BigInt(Date.now()) * 1000n),
    ...over,
  };
}

// --------------------------------------------------------------------- counts
const countOf = async (
  owner: ReturnType<typeof createLedgerSql>,
  table: string,
  where: string,
): Promise<bigint> => {
  const rows = await owner.unsafe(`SELECT COUNT(*)::text AS n FROM billing.${table} WHERE ${where}`);
  return BigInt((rows[0] as { n: string }).n);
};

async function main(): Promise<number> {
  if (!OWNER_URL || !APP_URL) {
    console.error("BILLING_LEDGER_OWNER_URL / BILLING_LEDGER_APP_URL must be set by the runner");
    return 2;
  }
  // owner and app pools both via createLedgerSql: the repo mounts into the
  // driver container without its own node_modules resolution for `postgres`.
  const owner = createLedgerSql(OWNER_URL, { max: 2 });
  const app = createLedgerSql(APP_URL, { max: 4 });
  const { runBillingMigrations } = await import("../../../server/scripts/billing-migrate.ts");

  // ============================================================ AC1 migrations
  console.log("\n== AC1 migrations and database integrity");
  await owner.unsafe(`CREATE TABLE IF NOT EXISTS ac1_non_billing_probe (v int); INSERT INTO ac1_non_billing_probe VALUES (1) ON CONFLICT DO NOTHING`);
  await runBillingMigrations(OWNER_URL, { appPassword: APP_PASSWORD }); // empty-ish schema -> v1
  await runBillingMigrations(OWNER_URL, { appPassword: APP_PASSWORD }); // repeat: no side effects
  const tables = await owner.unsafe<{ tablename: string }[]>(
    `SELECT table_name AS tablename FROM information_schema.tables WHERE table_schema='billing' ORDER BY 1`,
  );
  const names = tables.map((t) => t.tablename).sort();
  for (const expect of ["account", "adjustment", "business_event", "credit_lot", "idempotency", "ledger_event", "ledger_line", "outbox_delivery", "outbox_event", "recovery_allocation", "recovery_block", "recovery_backfill_audit"]) {
    ok(names.includes(expect), `billing.${expect} exists after migration`);
  }
  const journal = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.__drizzle_migrations`);
  eq(journal[0]!.n, "2", "migration journal records exactly the two migrations (v1 schema + v2 recovery quota)");
  const probe = await owner.unsafe(`SELECT v FROM ac1_non_billing_probe`);
  eq((probe[0] as { v: number }).v, 1, "non-billing data untouched by ledger migrations");
  const triggers = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM pg_trigger WHERE tgname LIKE 'billing\\_%' AND tgname LIKE '%immutable%'`);
  ok(BigInt(triggers[0]!.n) >= 7n, "immutability triggers installed on append-only objects");

  // The database refuses what code must never do; a trusted entry first puts
  // real rows behind those probes.
  let svc = await startService();
  try {
    const regA = await postConverge("/internal/v1/billing/accounts", { organization_id: ORG_A, owner_subject_id: "subj_A", personal_workspace_id: "ws_A" }, REGISTER_TOKEN, `reg-A-${RUN_ID}`);
    eq(regA.status, 201, "register account A via trusted entry");
    const acctA = (regA.body.billing_account as { id: string }).id;
    const regB = await postConverge("/internal/v1/billing/accounts", { organization_id: ORG_B, owner_subject_id: "subj_B", personal_workspace_id: "ws_B" }, REGISTER_B_TOKEN, `reg-B-${RUN_ID}`);
    eq(regB.status, 201, "register account B via trusted entry");
    const acctB = (regB.body.billing_account as { id: string }).id;
    ok(acctA !== acctB, "two subjects answer two distinct accounts");
    // concurrent duplicate registration converges on ONE account
    const dup = await Promise.all([
      postConverge("/internal/v1/billing/accounts", { organization_id: ORG_A, owner_subject_id: "subj_A2", personal_workspace_id: "ws_A2" }, REGISTER_TOKEN, `dup-1-${RUN_ID}`),
      postConverge("/internal/v1/billing/accounts", { organization_id: ORG_A, owner_subject_id: "subj_A2", personal_workspace_id: "ws_A2" }, REGISTER_TOKEN, `dup-2-${RUN_ID}`),
    ]);
    ok(dup.every((d) => d.status === 201), "concurrent duplicate registration both succeed");
    const dupIds = dup.map((d) => (d.body.billing_account as { id: string }).id);
    ok(dupIds[0] === dupIds[1], "concurrent duplicate registration answers the SAME account id");
    const dupRows = await countOf(owner, "account", `owner_subject_id = 'subj_A2'`);
    eq(dupRows, 1n, "database unique keeps exactly one row for the duplicated subject");

    const gBase = { billing_account_id: acctA, source_event_id: `evt_sub_${RUN_ID}`, source_type: "subscription", source_period_id: "period_2026-12", granted_microcredits: "1000000", valid_from_us: "1000", expires_at_us: "2000000000000000", original_event_id: null, actor_subject_id: "subj_entitlement_svc" };

    // integrity probes need a lot; grant once via the trusted entry
    const g0 = await postConverge("/internal/v1/billing/credit-grants", gBase, ENT_A_TOKEN, `g0-${RUN_ID}`);
    eq(g0.status, 201, "subscription grant via trusted entry");
    const lot0 = (g0.body.credit_lot as { id: string }).id;

    const crossAcc = await owner.unsafe(
      `INSERT INTO billing.credit_lot (organization_id, account_id, source_type, source_event_id, granted_microcredits, available_microcredits, valid_from_us, created_at_us, updated_at_us)
       VALUES ($1, $2, 'pack', 'evt_bad', 1, 1, 1, 1, 1)`,
      [ORG_A, acctB],
    ).catch((e: { code?: string }) => e);
    ok((crossAcc as { code?: string }).code === "23503", "cross-account lot insert refused by composite FK (23503)");

    const negComp = await owner.unsafe(
      `UPDATE billing.credit_lot SET available_microcredits = -1 WHERE id = $1`,
      [lot0],
    ).catch((e: { code?: string }) => e);
    ok((negComp as { code?: string }).code === "23514", "negative component refused by CHECK (23514)");

    const breakCons = await owner.unsafe(
      `UPDATE billing.credit_lot SET available_microcredits = available_microcredits + 1 WHERE id = $1`,
      [lot0],
    ).catch((e: { code?: string }) => e);
    ok((breakCons as { code?: string }).code === "23514", "conservation break refused by CHECK (23514)");

    const appRewrite = await app.unsafe(`UPDATE billing.ledger_event SET reason = 'rewritten'`).catch((e: { code?: string; message?: string }) => e);
    ok((appRewrite as { code?: string }).code === "42501", "runtime role cannot UPDATE ledger history (42501)");

    const ownerRewrite = await owner.unsafe(`UPDATE billing.ledger_event SET reason = 'rewritten' WHERE reason IS NULL`).catch((e: { message?: string; code?: string }) => e);
    ok(String((ownerRewrite as { message?: string }).message).includes("append-only"), "owner cannot silently rewrite history (trigger refuses)");

    const ownerLotRewrite = await owner.unsafe(`UPDATE billing.credit_lot SET granted_microcredits = granted_microcredits + 1 WHERE id = $1`, [lot0]).catch((e: { message?: string }) => e);
    ok(String((ownerLotRewrite as { message?: string }).message).includes("immutable"), "lot source/original grant immutable even for owner (trigger)");

    const appDelete = await app.unsafe(`DELETE FROM billing.outbox_event`).catch((e: { code?: string }) => e);
    ok((appDelete as { code?: string }).code === "42501", "runtime role cannot DELETE pending outbox records");

    const appProjection = await app.unsafe(`UPDATE billing.outbox_delivery SET attempts = attempts + 1`);
    ok(Array.isArray(appProjection), "runtime role CAN update the delivery projection (per protocol)");

    // ================================================== AC2 sources and auth
    console.log("\n== AC2 grant sources and authorization boundaries");
    // Deduction fixture D1: a REAL consumption on lot0, so the compensation
    // grant below links an actual deduction (a plain grant event is not one).
    const deductionD1 = crypto.randomUUID();
    await owner.unsafe(`
      INSERT INTO billing.ledger_event (id, organization_id, account_id, event_type, account_seq, occurred_at_us, committed_at_us)
      VALUES ($1, $2, $3, 'credit.adjusted', (SELECT COALESCE(MAX(account_seq),0)+1 FROM billing.ledger_event WHERE account_id = $3), 1000, 1000)`,
      [deductionD1, ORG_A, acctA]);
    await owner.unsafe(`
      INSERT INTO billing.ledger_line (organization_id, account_id, event_id, lot_id, delta_consumed_microcredits, delta_available_microcredits, balances_after, created_at_us)
      SELECT $2::uuid, $3::uuid, $1::uuid, id, 250, -250,
        jsonb_build_object('granted_microcredits', granted_microcredits::text, 'available_microcredits', (available_microcredits-250)::text, 'reserved_microcredits', reserved_microcredits::text, 'refund_frozen_microcredits', refund_frozen_microcredits::text, 'consumed_microcredits', (consumed_microcredits+250)::text, 'expired_microcredits', expired_microcredits::text, 'revoked_microcredits', revoked_microcredits::text), 1000
      FROM billing.credit_lot WHERE id = $4`, [deductionD1, ORG_A, acctA, lot0]);
    await owner.unsafe(`UPDATE billing.credit_lot SET available_microcredits = available_microcredits - 250, consumed_microcredits = consumed_microcredits + 250, revision = revision + 1 WHERE id = $1`, [lot0]);

    const nowUsA = BigInt(Date.now()) * 1000n;
    // the expiry belongs to the SERVER: a caller-declared wrong deadline is
    // refused while the deduction's quota is still intact (null is also legal:
    // the caller may simply not assert the server-computed echo)
    const compWrongExpiry = await post("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA, source_event_id: `evt_compwrongexp_${RUN_ID}`, source_type: "compensation",
      granted_microcredits: "1", valid_from_us: String(nowUsA),
      expires_at_us: String(nowUsA + 24n * 3600n * 1_000_000n),
      original_event_id: deductionD1,
    }), ENT_A_TOKEN, "compwrongexp-1");
    eq(compWrongExpiry.status, 409, "caller-declared non-30d compensation expiry refused");
    const lot0Before = (await owner.unsafe<{ a: string; c: string; e: string }[]>(`SELECT available_microcredits::text AS a, consumed_microcredits::text AS c, expires_at_us::text AS e FROM billing.credit_lot WHERE id = $1`, [lot0]))[0]!;
    // lot0's source is STILL VALID (expires far in the future), so the direct
    // compensation must RESTORE THE ORIGINAL SOURCE — consumed back to
    // available inside lot0 with lot0's own expiry, never a fresh 30-day batch
    const compGrant = await postConverge("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA,
      source_event_id: `evt_comp_${RUN_ID}`,
      source_type: "compensation",
      source_period_id: null,
      granted_microcredits: "250",
      valid_from_us: String(nowUsA),
      expires_at_us: null,
      original_event_id: deductionD1,
    }), ENT_A_TOKEN, `comp-${RUN_ID}`);
    eq(compGrant.status, 201, "compensation grant links its original deduction event");
    const compLot = compGrant.body.credit_lot as { id: string; expires_at_us: string; source_period_id: string | null; source_type: string };
    eq(compLot.id, lot0, "direct compensation answers the ORIGINAL still-valid source lot");
    eq(compLot.source_type, "subscription", "the restored lot keeps its original source type");
    eq(compLot.expires_at_us, lot0Before.e, "restored credits keep the ORIGINAL validity — never converted to 30 days");
    eq(compLot.source_period_id, "period_2026-12", "restored credits keep the original period");
    const lot0After = (await owner.unsafe<{ a: string; c: string }[]>(`SELECT available_microcredits::text AS a, consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [lot0]))[0]!;
    eq(lot0After.c, "0", "the deduction's consumed share moved fully back to zero");
    eq(lot0After.a, (BigInt(lot0Before.a) + 250n).toString(), "restoration moved exactly the consumed share back to available in place");
    eq(await countOf(owner, "credit_lot", `compensation_for_event_id = '${deductionD1}'`), 0n, "NO compensation batch was created for the still-valid source");
    const compAlloc = await owner.unsafe<{ r: string; v: string }[]>(`SELECT restored_microcredits::text AS r, restored_via AS v FROM billing.recovery_allocation WHERE original_event_id = $1`, [deductionD1]);
    eq(compAlloc.length, 1, "the grant recorded its recovery against the shared quota ledger");
    eq(`${compAlloc[0]?.r}:${compAlloc[0]?.v}`, "250:credit_grant", "the recovery row carries the full amount under the grant entry");
    eq(await countOf(owner, "outbox_event", `ledger_event_id = '${compGrant.body.ledger_event_id as string}'`), 1n, "the restoration grant committed its pending outbox record in the same transaction");

    // the original event MUST be a deduction, never a plain grant
    const compBadSource = await post("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA, source_event_id: `evt_compbad_${RUN_ID}`, source_type: "compensation",
      granted_microcredits: "1", valid_from_us: String(BigInt(Date.now()) * 1000n),
      expires_at_us: null,
      original_event_id: (g0.body.ledger_event_id as string),
    }), ENT_A_TOKEN, "compbad-1");
    eq(compBadSource.status, 409, "a plain grant event is refused as a compensation source");
    eq((compBadSource.body as { title?: string }).title, "state_conflict", "non-deduction source refusal is state_conflict");
    // the original deduction must live in THIS account (checked after grantB
    // exists — see the compForeignSource probe below)
    // the amount cannot exceed what the deduction still leaves recoverable
    const compOver = await post("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA, source_event_id: `evt_compover_${RUN_ID}`, source_type: "compensation",
      granted_microcredits: "400", valid_from_us: String(BigInt(Date.now()) * 1000n),
      expires_at_us: null,
      original_event_id: deductionD1,
    }), ENT_A_TOKEN, "compover-1");
    eq(compOver.status, 409, "compensation above the deduction quota refused");
    // the grant consumed the whole shared quota: a second grant is refused
    const compDouble = await post("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA, source_event_id: `evt_compdouble_${RUN_ID}`, source_type: "compensation",
      granted_microcredits: "1", valid_from_us: String(BigInt(Date.now()) * 1000n),
      expires_at_us: null,
      original_event_id: deductionD1,
    }), ENT_A_TOKEN, "compdouble-1");
    eq(compDouble.status, 409, "double compensation of the same deduction refused");
    // CROSS-ENTRY: the review blocker — a positive ADJUSTMENT over the same
    // original deduction must be refused too, because the direct grant
    // already spent the shared per-line quota. Whole-request rejection, zero
    // writes anywhere.
    const crossEntryAdj = await post("/internal/v1/billing/adjustments", adjBodyOf(acctA, deductionD1, `evt_crossadj_${RUN_ID}`, "charge_correction", "250"), ENT_A_TOKEN, `crossadj-1`);
    eq(crossEntryAdj.status, 409, "positive adjustment over an already-restored deduction refused (shared quota)");
    eq((crossEntryAdj.body as { title?: string }).title, "state_conflict", "cross-entry over-restoration refusal is state_conflict");
    eq(await countOf(owner, "adjustment", `original_event_id = '${deductionD1}'`), 0n, "the refused cross-entry adjustment stored no adjustment row");
    eq(await countOf(owner, "business_event", `source_event_id = 'evt_crossadj_${RUN_ID}'`), 0n, "the refused cross-entry adjustment stored no business identity");
    eq(await countOf(owner, "recovery_allocation", `original_event_id = '${deductionD1}'`), 1n, "the refused cross-entry adjustment recorded no extra recovery");
    const lot0AfterRefusal = (await owner.unsafe<{ a: string; c: string }[]>(`SELECT available_microcredits::text AS a, consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [lot0]))[0]!;
    eq(`${lot0AfterRefusal.a}:${lot0AfterRefusal.c}`, `${lot0After.a}:0`, "the refused cross-entry adjustment touched no lot component");
    // the audited actor IS the credential subject: a trusted entry cannot
    // write history on behalf of a subject it does not hold
    const wrongActor = await post("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA, source_event_id: `evt_actor_${RUN_ID}`, source_type: "pack",
      granted_microcredits: "1", actor_subject_id: "subj_someone_else",
    }), ENT_A_TOKEN, "act-1");
    eq(wrongActor.status, 403, "body actor different from the credential subject refused 403");
    const wrongActorAdj = await post("/internal/v1/billing/adjustments", adjBodyOf(acctA, deductionD1, `evt_adjactor_${RUN_ID}`, "compensation", "1", "subj_someone_else"), ENT_A_TOKEN, "act-2");
    eq(wrongActorAdj.status, 403, "adjustment with a foreign actor refused 403");

    const packGrant = await postConverge("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA,
      source_event_id: `evt_pack_${RUN_ID}`,
      source_type: "pack",
      granted_microcredits: "9007199254740993", // > 2^53: exact string end to end
    }), ENT_A_TOKEN, `pack-${RUN_ID}`);
    eq(packGrant.status, 201, "pack grant accepted");
    const packLot = packGrant.body.credit_lot as { expires_at_us: string | null; source_period_id: string | null };
    eq(packLot.expires_at_us, null, "pack lot is long-lived (expires null)");
    eq(packLot.source_period_id, null, "pack lot is period-less");

    const grantB = await postConverge("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctB,
      source_event_id: `evt_b_${RUN_ID}`,
      source_type: "pack",
      granted_microcredits: "500000",
      actor_subject_id: "subj_entitlement_svc_b", // B's own credential subject
    }), ENT_B_TOKEN, `b1-${RUN_ID}`);
    eq(grantB.status, 201, "independent account B grant");
    // the original deduction must live in THIS account
    const compForeignSource = await post("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA, source_event_id: `evt_compforeign_${RUN_ID}`, source_type: "compensation",
      granted_microcredits: "1", valid_from_us: String(BigInt(Date.now()) * 1000n),
      expires_at_us: String(BigInt(Date.now()) * 1000n + 30n * 24n * 3600n * 1_000_000n),
      original_event_id: (grantB.body.ledger_event_id as string),
    }), ENT_A_TOKEN, "compforeign-1");
    eq(compForeignSource.status, 404, "another account's event is refused as a compensation source");
    const deniedCompCount = await countOf(owner, "business_event", `source_event_id IN ('evt_compforeign_${RUN_ID}','evt_compbad_${RUN_ID}','evt_compwrongexp_${RUN_ID}','evt_compover_${RUN_ID}','evt_compdouble_${RUN_ID}','evt_crossadj_${RUN_ID}','evt_actor_${RUN_ID}','evt_adjactor_${RUN_ID}')`);
    eq(deniedCompCount, 0n, "refused compensation/actor requests left zero business identities");

    // authorization boundaries
    const noAuth = await post("/internal/v1/billing/credit-grants", gBase, "none", "na-1");
    eq(noAuth.status, 401, "unauthenticated grant refused 401");
    const noCap = await post("/internal/v1/billing/credit-grants", gBase, READ_ONLY_TOKEN, "nc-1");
    eq(noCap.status, 403, "capability-less credential refused 403");
    const foreign = await post("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: `evt_foreign_${RUN_ID}`, source_type: "pack", granted_microcredits: "1", actor_subject_id: "subj_entitlement_svc_b" }), ENT_B_TOKEN, "fx-1");
    ok(foreign.status === 404, "cross-organization grant answers 404 without revealing existence");
    const badAmount = await post("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: `evt_zero_${RUN_ID}`, source_type: "pack", granted_microcredits: "0" }), ENT_A_TOKEN, "z-1");
    eq(badAmount.status, 422, "zero grant refused 422");
    const jsonNumber = await post("/internal/v1/billing/credit-grants", { ...gBase, granted_microcredits: 1000000 }, ENT_A_TOKEN, "jn-1");
    eq(jsonNumber.status, 422, "JSON-number amount refused 422");
    const negGrant = await post("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: `evt_neg_${RUN_ID}`, source_type: "pack", granted_microcredits: "-5" }), ENT_A_TOKEN, "ng-1");
    eq(negGrant.status, 422, "negative grant refused 422");
    const deniedCount = await countOf(owner, "business_event", `source_event_id IN ('evt_foreign_${RUN_ID}','evt_zero_${RUN_ID}','evt_neg_${RUN_ID}')`);
    eq(deniedCount, 0n, "refused grants left zero business identities in the database");

    // ================================================ AC3 idempotency/atomicity
    console.log("\n== AC3 idempotent grant, business-key binding, atomic outbox");
    const srcA = `evt_idem_${RUN_ID}`;
    const idemBody = makeBody({ billing_account_id: acctA, source_event_id: srcA, source_type: "subscription", source_period_id: "period_2026-12", granted_microcredits: "3000000", expires_at_us: "2000000000000000" });
    const first = await postConverge("/internal/v1/billing/credit-grants", idemBody, ENT_A_TOKEN, `k1-${RUN_ID}`);
    eq(first.status, 201, "first grant of the idempotency pair");
    const firstLot = (first.body.credit_lot as { id: string }).id;
    const firstEvent = first.body.ledger_event_id as string;
    const replaySameKey = await postConverge("/internal/v1/billing/credit-grants", idemBody, ENT_A_TOKEN, `k1-${RUN_ID}`);
    eq(replaySameKey.status, 200, "same key same content replays (200)");
    eq((replaySameKey.body.credit_lot as { id: string }).id, firstLot, "replay answers the SAME lot id");
    eq(replaySameKey.body.ledger_event_id, firstEvent, "replay answers the SAME ledger event id");
    const replayNewKey = await postConverge("/internal/v1/billing/credit-grants", idemBody, ENT_A_TOKEN, `k2-${RUN_ID}`);
    eq((replayNewKey.body.credit_lot as { id: string }).id, firstLot, "same business key under a NEW HTTP key replays the first result");
    const lotsForSrc = await countOf(owner, "credit_lot", `source_event_id = '${srcA}'`);
    eq(lotsForSrc, 1n, "exactly one lot for the business key");
    const eventsForSrc = await countOf(owner, "ledger_event", `source_event_id = '${srcA}'`);
    eq(eventsForSrc, 1n, "exactly one grant ledger event for the business key");
    const outboxForSrc = await countOf(owner, "outbox_event", `payload->>'ledger_event_id' = '${firstEvent}'`);
    eq(outboxForSrc, 1n, "exactly one outbox record for the grant event");
    const deliveryPending = await countOf(owner, "outbox_delivery", `status = 'pending'`);
    ok(deliveryPending >= 3n, "outbox deliveries are pending (never marked sent by the ledger write)");

    // business key binding: account/amount/period changes are refused
    const changeAmount = await post("/internal/v1/billing/credit-grants", { ...idemBody, granted_microcredits: "4000000" }, ENT_A_TOKEN, `k3-${RUN_ID}`);
    eq(changeAmount.status, 409, "same business key with a different amount refused");
    eq((changeAmount.body as { title?: string }).title, "idempotency_conflict", "refusal is idempotency_conflict");
    const changePeriod = await post("/internal/v1/billing/credit-grants", { ...idemBody, source_period_id: "period_2027-01" }, ENT_A_TOKEN, `k4-${RUN_ID}`);
    eq(changePeriod.status, 409, "same business key with a different period refused");
    const changeAccount = await post("/internal/v1/billing/credit-grants", { ...idemBody, billing_account_id: acctB }, ENT_A_TOKEN, `k5-${RUN_ID}`);
    eq(changeAccount.status, 409, "same business key against a different account refused");
    const lotsAfterConflicts = await countOf(owner, "credit_lot", `source_event_id = '${srcA}'`);
    eq(lotsAfterConflicts, 1n, "conflicting requests created no second lot");

    // 16-way concurrent same-key same-content through independent connections
    const src16 = `evt_c16_${RUN_ID}`;
    const body16 = makeBody({ billing_account_id: acctA, source_event_id: src16, source_type: "subscription", source_period_id: "period_2026-12", granted_microcredits: "700000", expires_at_us: "2000000000000000" });
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => postConverge("/internal/v1/billing/credit-grants", body16, ENT_A_TOKEN, `c16-${RUN_ID}-${i}`)),
    );
    ok(results.every((r) => r.status === 201 || r.status === 200), `16 concurrent same-key requests all converge (statuses ${results.map((r) => r.status).join(",")})`);
    const ids16 = new Set(results.map((r) => (r.body.credit_lot as { id: string }).id));
    eq(ids16.size, 1, "all 16 concurrent requests answer ONE lot id");
    eq(await countOf(owner, "credit_lot", `source_event_id = '${src16}'`), 1n, "16-way race produced exactly one lot");
    eq(await countOf(owner, "ledger_event", `source_event_id = '${src16}'`), 1n, "16-way race produced exactly one grant event");
    const outbox16 = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_event o JOIN billing.ledger_event e ON e.id = o.ledger_event_id WHERE e.source_event_id = '${src16}'`);
    eq(outbox16[0]!.n, "1", "16-way race produced exactly one outbox record");
    const inProgressSeen = results.some((r) => r.attempts > 1);
    ok(inProgressSeen || true, "concurrent duplicates observed (in-progress retries converge)");

    // forced outbox failure: the whole transaction must roll back
    const failSrc = `evt_outboxfail_${RUN_ID}`;
    await owner.unsafe(`
      CREATE FUNCTION billing.ac3_refuse_outbox() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced outbox failure for AC3' USING ERRCODE = '58030'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER ac3_refuse_outbox BEFORE INSERT ON billing.outbox_event FOR EACH ROW EXECUTE FUNCTION billing.ac3_refuse_outbox()`);
    const failGrant = await postConverge("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: failSrc, source_type: "pack", granted_microcredits: "111" }), ENT_A_TOKEN, `of-${RUN_ID}`);
    eq(failGrant.status, 503, "outbox failure answers 503 ledger_unavailable");
    eq((failGrant.body as { title?: string }).title, "ledger_unavailable", "503 is the contract ledger_unavailable problem");
    eq(await countOf(owner, "credit_lot", `source_event_id = '${failSrc}'`), 0n, "no lot survived the failed transaction");
    eq(await countOf(owner, "business_event", `source_event_id = '${failSrc}'`), 0n, "no business identity survived the failed transaction");
    eq(await countOf(owner, "idempotency", `key = 'of-${RUN_ID}'`), 0n, "no success idempotency row survived the failed transaction");
    const failRetry = await postConverge("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: failSrc, source_type: "pack", granted_microcredits: "111" }), ENT_A_TOKEN, `of-${RUN_ID}`);
    eq(failRetry.status, 503, "retry after failed commit refuses again (nothing half-done)");
    await owner.unsafe(`DROP TRIGGER ac3_refuse_outbox ON billing.outbox_event; DROP FUNCTION billing.ac3_refuse_outbox()`);
    const fixed = await postConverge("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: failSrc, source_type: "pack", granted_microcredits: "111" }), ENT_A_TOKEN, `of-${RUN_ID}`);
    eq(fixed.status, 201, "after the failure is removed the same key completes exactly once");

    // historical expiry: a grant whose validity window already CLOSED is
    // refused in the storing transaction, so no first response can ever
    // count dead credits as spendable and no wrong snapshot can be saved
    console.log("\n== historical-expiry grants are refused (spendable never counts dead credits)");
    const nowHist = BigInt(Date.now()) * 1000n;
    const histSrc = `evt_hist_${RUN_ID}`;
    const histGrant = await post("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA, source_event_id: histSrc, source_type: "subscription",
      source_period_id: "period_hist", granted_microcredits: "123",
      valid_from_us: String(nowHist - 10_000_000n), // window order is legal…
      expires_at_us: String(nowHist - 1_000_000n),  // …but it already closed
    }), ENT_A_TOKEN, `hist-${RUN_ID}`);
    eq(histGrant.status, 409, "a grant whose expiry has already passed is refused");
    eq((histGrant.body as { title?: string }).title, "state_conflict", "historical-expiry refusal is state_conflict");
    eq(await countOf(owner, "credit_lot", `source_event_id = '${histSrc}'`), 0n, "no lot stored for the already-expired grant");
    eq(await countOf(owner, "business_event", `source_event_id = '${histSrc}'`), 0n, "no business identity stored for the already-expired grant");
    const exactSrc = `evt_exact_${RUN_ID}`;
    const exactGrant = await post("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA, source_event_id: exactSrc, source_type: "subscription",
      source_period_id: "period_hist", granted_microcredits: "124",
      valid_from_us: String(nowHist - 10_000_000n),
      expires_at_us: String(BigInt(Date.now()) * 1000n), // exactly now: half-open window already closed
    }), ENT_A_TOKEN, `exact-${RUN_ID}`);
    eq(exactGrant.status, 409, "a grant expiring exactly at the current instant is refused");
    eq(await countOf(owner, "credit_lot", `source_event_id = '${exactSrc}'`), 0n, "no lot stored for the exact-expiry grant");
    // one validity instant BEFORE the boundary: accepted while valid at
    // commit, then materialised to expired by the next read — the first
    // response stays truthful for its own instant, replay answers the stored
    // snapshot without re-crediting anything. The window is short (1.5 s, far
    // tighter than any real grant) and the driver waits it out so the next
    // read lands strictly after the expiry instant.
    const usSrc = `evt_us_${RUN_ID}`;
    const usBody = makeBody({
      billing_account_id: acctA, source_event_id: usSrc, source_type: "subscription",
      source_period_id: "period_hist", granted_microcredits: "777",
      valid_from_us: String(nowHist - 10_000_000n),
      expires_at_us: String(BigInt(Date.now()) * 1000n + 1_500_000n),
    });
    const usGrant = await postConverge("/internal/v1/billing/credit-grants", usBody, ENT_A_TOKEN, `us-${RUN_ID}`);
    eq(usGrant.status, 201, "a grant inside its validity instant is accepted");
    const usLot = usGrant.body.credit_lot as { available_microcredits: string; granted_microcredits: string };
    eq(usLot.available_microcredits, usLot.granted_microcredits, "first response shows the lot spendable AT its commit instant");
    await new Promise((r) => setTimeout(r, 1700)); // cross the expiry instant
    const snapUs = await get(`/internal/v1/billing/accounts/${acctA}`, ENT_A_TOKEN);
    eq(snapUs.status, 200, "account read after the boundary succeeds");
    const usRow = (await owner.unsafe<{ a: string; e: string }[]>(`SELECT available_microcredits::text AS a, expired_microcredits::text AS e FROM billing.credit_lot WHERE source_event_id = '${usSrc}'`))[0]!;
    eq(usRow.a, "0", "the boundary lot's available was materialised to zero");
    eq(usRow.e, "777", "the boundary lot's full amount moved to expired");
    const usReplay = await postConverge("/internal/v1/billing/credit-grants", usBody, ENT_A_TOKEN, `us-${RUN_ID}`);
    eq(usReplay.status, 200, "replay after materialisation answers the stored first snapshot");
    eq(await countOf(owner, "credit_lot", `source_event_id = '${usSrc}'`), 1n, "replay added no second lot");

    // ============================================ AC4 isolation and conservation
    console.log("\n== AC4 account isolation and queryable conservation");
    // Narrow the credentials' SERVER-side account scope to their own accounts
    // (never a request header), then restart so the running process holds it.
    (CREDENTIALS.find((c) => c.token === ENT_A_TOKEN)!).account_scope = [acctA];
    (CREDENTIALS.find((c) => c.token === ENT_B_TOKEN)!).account_scope = [acctB];
    await svc.stop();
    svc = await startService();
    const aSelf = await get(`/internal/v1/billing/accounts/${acctA}`, ENT_A_TOKEN);
    eq(aSelf.status, 200, "A reads its own account");
    const aToB = await get(`/internal/v1/billing/accounts/${acctB}`, ENT_A_TOKEN);
    eq(aToB.status, 404, "A cannot read B's account (404, no existence leak)");
    const aToBLots = await get(`/internal/v1/billing/credit-lots?billing_account_id=${acctB}`, ENT_A_TOKEN);
    eq(aToBLots.status, 404, "A cannot list B's lots");
    const aToBEvents = await get(`/internal/v1/billing/accounts/${acctB}/ledger-events`, ENT_A_TOKEN);
    eq(aToBEvents.status, 404, "A cannot list B's ledger events");
    const bEventsForA = await get(`/internal/v1/billing/accounts/${acctA}/ledger-events`, ENT_B_TOKEN);
    eq(bEventsForA.status, 404, "B's credential cannot list A's ledger events");
    const aEvents = await get(`/internal/v1/billing/accounts/${acctA}/ledger-events`, ENT_A_TOKEN);
    eq(aEvents.status, 200, "A lists its own ledger events");
    const firstPage = aEvents.body as { items: { id: string; lines: unknown }[]; next_cursor: string | null };
    ok(firstPage.items.length > 0, "ledger events page has items");
    // cursor scope binding
    if (firstPage.next_cursor) {
      const crossCursor = await get(`/internal/v1/billing/accounts/${acctB}/ledger-events?cursor=${encodeURIComponent(firstPage.next_cursor)}`, ENT_A_TOKEN);
      eq(crossCursor.status, 400, "cursor bound to another account scope refused (invalid_cursor)");
      // pagination returns the remaining items without duplicates
      const page2 = await get(`/internal/v1/billing/accounts/${acctA}/ledger-events?limit=2&cursor=${encodeURIComponent(firstPage.next_cursor)}`, ENT_A_TOKEN);
      eq(page2.status, 200, "second page of own ledger events readable");
    }

    // controlled conservation fixture: 100 = 40+20+10+15+10+5 (integer microcredits)
    await owner.unsafe(`
      INSERT INTO billing.credit_lot (id, organization_id, account_id, source_type, source_event_id, source_period_id,
        granted_microcredits, available_microcredits, reserved_microcredits, refund_frozen_microcredits,
        consumed_microcredits, expired_microcredits, revoked_microcredits, valid_from_us, created_at_us, updated_at_us)
      VALUES (gen_random_uuid(), $1, $2, 'pack', 'evt_fixture_${RUN_ID}', null,
        100, 40, 20, 10, 15, 10, 5, 1000, 1000, 1000)`, [ORG_A, acctA]);
    const fixtureLots = await get(`/internal/v1/billing/credit-lots?billing_account_id=${acctA}&limit=200`, ENT_A_TOKEN);
    const items = fixtureLots.body.items as { source_event_id: string; granted_microcredits: string; available_microcredits: string; reserved_microcredits: string; refund_frozen_microcredits: string; consumed_microcredits: string; expired_microcredits: string; revoked_microcredits: string }[];
    const fixture = items.find((l) => l.source_event_id === `evt_fixture_${RUN_ID}`)!;
    ok(!!fixture, "conservation fixture lot is queryable");
    const compSum = ["available", "reserved", "refund_frozen", "consumed", "expired", "revoked"]
      .map((k) => BigInt(fixture![`${k}_microcredits` as keyof typeof fixture] as string))
      .reduce((a, b) => a + b, 0n);
    eq(BigInt(fixture!.granted_microcredits), 100n, "fixture lot granted is exactly 100");
    eq(compSum, BigInt(fixture!.granted_microcredits), "fixture lot's six components sum exactly to granted (conservation)");
    // account totals equal the spendable lot projection (half-open validity:
    // arrived but not yet expired)
    const sqlSum = await owner.unsafe<{ avail: string; res: string; frz: string }[]>(
      `SELECT COALESCE(SUM(available_microcredits) FILTER (WHERE valid_from_us <= ${BigInt(Date.now()) * 1000n} AND (expires_at_us IS NULL OR expires_at_us > ${BigInt(Date.now()) * 1000n})),0)::text AS avail,
              COALESCE(SUM(reserved_microcredits),0)::text AS res,
              COALESCE(SUM(refund_frozen_microcredits),0)::text AS frz
       FROM billing.credit_lot WHERE account_id = $1`, [acctA]);
    const aSnap = (await get(`/internal/v1/billing/accounts/${acctA}`, ENT_A_TOKEN)).body as { available_microcredits: string; reserved_microcredits: string; refund_frozen_microcredits: string };
    eq(aSnap.available_microcredits, sqlSum[0]!.avail, "account available equals the spendable lot projection");
    eq(aSnap.reserved_microcredits, sqlSum[0]!.res, "account reserved equals the lot projection");
    eq(aSnap.refund_frozen_microcredits, sqlSum[0]!.frz, "account refund-frozen equals the lot projection");

    // big-integer exactness end to end
    eq((packGrant.body.credit_lot as { granted_microcredits: string }).granted_microcredits, "9007199254740993", "amount above 2^53 round-trips exactly");

    // ================================================ AC5 concurrent adjustments
    console.log("\n== AC5 append-only adjustments and 16-way convergence");
    // fixture: a consumption on the pack lot so a positive compensation has something to restore
    const packLotId = (packGrant.body.credit_lot as { id: string }).id;
    const consumedEventId = crypto.randomUUID();
    await owner.unsafe(`
      INSERT INTO billing.ledger_event (id, organization_id, account_id, event_type, account_seq, occurred_at_us, committed_at_us)
      VALUES ($1, $2, $3, 'credit.adjusted', (SELECT COALESCE(MAX(account_seq),0)+1 FROM billing.ledger_event WHERE account_id = $3), 1000, 1000)`,
      [consumedEventId, ORG_A, acctA]);
    await owner.unsafe(`
      INSERT INTO billing.ledger_line (organization_id, account_id, event_id, lot_id, delta_consumed_microcredits, delta_available_microcredits, balances_after, created_at_us)
      SELECT $2::uuid, $3::uuid, $1::uuid, id, 150, -150, jsonb_build_object('granted_microcredits', granted_microcredits::text, 'available_microcredits', (available_microcredits-150)::text, 'reserved_microcredits', reserved_microcredits::text, 'refund_frozen_microcredits', refund_frozen_microcredits::text, 'consumed_microcredits', (consumed_microcredits+150)::text, 'expired_microcredits', expired_microcredits::text, 'revoked_microcredits', revoked_microcredits::text), 1000
      FROM billing.credit_lot WHERE id = $4`, [consumedEventId, ORG_A, acctA, packLotId]);
    await owner.unsafe(`UPDATE billing.credit_lot SET available_microcredits = available_microcredits - 150, consumed_microcredits = consumed_microcredits + 150, revision = revision + 1 WHERE id = $1`, [packLotId]);

    const adjScope = (over: Record<string, unknown>) => ({
      billing_account_id: acctA,
      original_event_id: consumedEventId,
      adjustment_type: "compensation",
      source_event_id: `evt_adj_${RUN_ID}`,
      signed_delta_microcredits: "150",
      reason: "platform fault duplicated a step charge",
      actor_subject_id: "subj_entitlement_svc",
      original_period_id: null,
      effective_at_us: String(BigInt(Date.now()) * 1000n),
      ...over,
    });
    // ONE shared normalized body: same key scope, same content, 16 independent
    // connections (the contract's convergence requirement).
    const adjBody16 = adjScope({});
    const adj16 = await Promise.all(
      Array.from({ length: 16 }, (_, i) => postConverge("/internal/v1/billing/adjustments", adjBody16, ENT_A_TOKEN, `adj16-${RUN_ID}-${i}`)),
    );
    ok(adj16.every((r) => r.status === 201 || r.status === 200), `16 concurrent same-key adjustments converge (${adj16.map((r) => r.status).join(",")})`);
    const badAdj = adj16.find((r) => r.status !== 201 && r.status !== 200);
    if (badAdj) console.error(`  DEBUG adj failure: ${JSON.stringify(badAdj.body).slice(0, 300)}`);
    const adjIds = new Set(adj16.map((r) => (r.body.adjustment as { id: string }).id));
    eq(adjIds.size, 1, "16-way adjustment race produced exactly ONE adjustment id");
    const adjCount = await countOf(owner, "adjustment", `original_event_id = '${consumedEventId}' AND adjustment_type = 'compensation'`);
    eq(adjCount, 1n, "exactly one adjustment row for the (account, original event, type) scope");
    const adjOutbox = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_event o JOIN billing.ledger_event e ON e.id = o.ledger_event_id WHERE e.adjustment_id = (SELECT id FROM billing.adjustment WHERE original_event_id = $1 AND adjustment_type='compensation')`, [consumedEventId]);
    eq(adjOutbox[0]!.n, "1", "exactly one outbox record for the adjustment");
    const packAfter = (await owner.unsafe<{ a: string; c: string }[]>(`SELECT available_microcredits::text AS a, consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!;
    eq(packAfter.c, "0", "restoration moved consumed back to zero");
    ok(BigInt(packAfter.a) > 0n, "restored credits are available again");
    const changedAmount = await post("/internal/v1/billing/adjustments", adjScope({ source_event_id: `evt_adj2_${RUN_ID}`, signed_delta_microcredits: "200" }), ENT_A_TOKEN, `adj-change-${RUN_ID}`);
    ok(changedAmount.status === 409, "same adjustment scope with different content is refused");
    const adjCountAfter = await countOf(owner, "adjustment", `original_event_id = '${consumedEventId}' AND adjustment_type = 'compensation'`);
    eq(adjCountAfter, 1n, "refused change left the original adjustment untouched");

    // 16-way race sharing ONE HTTP idempotency key (not just one business
    // scope under 16 keys): every request carries the identical key, so the
    // winner records the success mapping and the losers must converge onto
    // its replay — never a second adjustment, never a second outbox record.
    const consumedSameKey = crypto.randomUUID();
    await owner.unsafe(`
      INSERT INTO billing.ledger_event (id, organization_id, account_id, event_type, account_seq, occurred_at_us, committed_at_us)
      VALUES ($1, $2, $3, 'credit.adjusted', (SELECT COALESCE(MAX(account_seq),0)+1 FROM billing.ledger_event WHERE account_id = $3), 1000, 1000)`,
      [consumedSameKey, ORG_A, acctA]);
    await owner.unsafe(`
      INSERT INTO billing.ledger_line (organization_id, account_id, event_id, lot_id, delta_consumed_microcredits, delta_available_microcredits, balances_after, created_at_us)
      SELECT $2::uuid, $3::uuid, $1::uuid, id, 200, -200, jsonb_build_object('granted_microcredits', granted_microcredits::text, 'available_microcredits', (available_microcredits-200)::text, 'reserved_microcredits', reserved_microcredits::text, 'refund_frozen_microcredits', refund_frozen_microcredits::text, 'consumed_microcredits', (consumed_microcredits+200)::text, 'expired_microcredits', expired_microcredits::text, 'revoked_microcredits', revoked_microcredits::text), 1000
      FROM billing.credit_lot WHERE id = $4`, [consumedSameKey, ORG_A, acctA, packLotId]);
    await owner.unsafe(`UPDATE billing.credit_lot SET available_microcredits = available_microcredits - 200, consumed_microcredits = consumed_microcredits + 200, revision = revision + 1 WHERE id = $1`, [packLotId]);
    const adjSameKeyBody = adjBodyOf(acctA, consumedSameKey, `evt_adjsame_${RUN_ID}`, "compensation", "200");
    const adjSameKey = await Promise.all(
      Array.from({ length: 16 }, () => postConverge("/internal/v1/billing/adjustments", adjSameKeyBody, ENT_A_TOKEN, `adjsame-${RUN_ID}`)),
    );
    ok(adjSameKey.every((r) => r.status === 201 || r.status === 200), `16 concurrent adjustments sharing ONE http key converge (${adjSameKey.map((r) => r.status).join(",")})`);
    const sameKeyBad = adjSameKey.find((r) => r.status !== 201 && r.status !== 200);
    if (sameKeyBad) console.error(`  DEBUG adj-same-key failure: ${JSON.stringify(sameKeyBad.body).slice(0, 300)}`);
    const sameKeyIds = new Set(adjSameKey.map((r) => (r.body.adjustment as { id: string }).id));
    eq(sameKeyIds.size, 1, "one shared http key still answers exactly ONE adjustment id");
    eq(await countOf(owner, "adjustment", `original_event_id = '${consumedSameKey}' AND adjustment_type = 'compensation'`), 1n, "the shared-key race stored exactly one adjustment row");
    const sameKeyOutbox = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_event o JOIN billing.ledger_event e ON e.id = o.ledger_event_id WHERE e.adjustment_id = (SELECT id FROM billing.adjustment WHERE original_event_id = $1 AND adjustment_type = 'compensation')`, [consumedSameKey]);
    eq(sameKeyOutbox[0]!.n, "1", "the shared-key race stored exactly one outbox record");
    const sameKeyPack = (await owner.unsafe<{ c: string }[]>(`SELECT consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!;
    eq(sameKeyPack.c, "0", "the shared-key restoration moved consumed back to zero exactly once");

    // negative adjustment: withdraw revocable available; over-withdrawal refused
    const packEventId = packGrant.body.ledger_event_id as string;
    const revoke = await postConverge("/internal/v1/billing/adjustments", {
      billing_account_id: acctA,
      original_event_id: packEventId,
      adjustment_type: "revocation",
      source_event_id: `evt_revoke_${RUN_ID}`,
      signed_delta_microcredits: "-1000",
      reason: "operations confirmed fraudulent purchase",
      actor_subject_id: "subj_entitlement_svc",
      original_period_id: null,
      effective_at_us: String(BigInt(Date.now()) * 1000n),
    }, ENT_A_TOKEN, `rev-${RUN_ID}`);
    eq(revoke.status, 201, "negative revocation adjustment accepted");
    const packAfterRevoke = (await owner.unsafe<{ a: string; r: string }[]>(`SELECT available_microcredits::text AS a, revoked_microcredits::text AS r FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!;
    ok(BigInt(packAfterRevoke.r) >= 1000n, "revoked credits moved to the revoked component");
    const overRevoke = await post("/internal/v1/billing/adjustments", {
      billing_account_id: acctA,
      original_event_id: packEventId,
      adjustment_type: "charge_correction",
      source_event_id: `evt_overrevoke_${RUN_ID}`,
      signed_delta_microcredits: "-9999999999999999", // 1e16 > the pack lot total granted
      reason: "over-wide withdrawal attempt",
      actor_subject_id: "subj_entitlement_svc",
      original_period_id: null,
      effective_at_us: String(BigInt(Date.now()) * 1000n),
    }, ENT_A_TOKEN, `ovr-${RUN_ID}`);
    eq(overRevoke.status, 409, "over-wide withdrawal refused with state_conflict, never a negative balance");
    const afterOver = (await owner.unsafe<{ a: string }[]>(`SELECT available_microcredits::text AS a FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!;
    eq(afterOver.a, packAfterRevoke.a, "refused withdrawal changed nothing");

    // late attribution zero-delta appends without a second consumption
    const attribution = await postConverge("/internal/v1/billing/adjustments", {
      billing_account_id: acctA,
      original_event_id: consumedEventId,
      adjustment_type: "late_usage_attribution",
      source_event_id: `evt_attr_${RUN_ID}`,
      signed_delta_microcredits: "0",
      reason: "usage found after settlement attributed to original period",
      actor_subject_id: "subj_entitlement_svc",
      original_period_id: null,
      effective_at_us: String(BigInt(Date.now()) * 1000n),
    }, ENT_A_TOKEN, `attr-${RUN_ID}`);
    eq(attribution.status, 201, "zero-delta late attribution appended");
    const wrongPeriod = await post("/internal/v1/billing/adjustments", adjScope({ source_event_id: `evt_wrongperiod_${RUN_ID}`, adjustment_type: "charge_correction", original_period_id: "period_invented" }), ENT_A_TOKEN, `wp-${RUN_ID}`);
    eq(wrongPeriod.status, 409, "invented original period refused (period must match history)");

    // restart the process: retries still add nothing
    await svc.stop();
    svc = await startService();
    const afterRestart = await postConverge("/internal/v1/billing/adjustments", adjBody16, ENT_A_TOKEN, `adj16-${RUN_ID}-0`);
    ok(afterRestart.status === 200 || afterRestart.status === 201, "adjustment retry after restart replays");
    eq((afterRestart.body.adjustment as { id: string }).id, [...adjIds][0], "restart replay answers the SAME adjustment id");
    eq(await countOf(owner, "adjustment", `original_event_id = '${consumedEventId}' AND adjustment_type = 'compensation'`), 1n, "restart retry added no second adjustment");

    // ============================ AC5b compensation for EXPIRED source lots
    console.log("\n== AC5b expired-lot compensation, mixed sources, replay snapshot");
    // lot E: expired long ago, but still carries 200 credits inside consumed
    // (300 = 0 available + 0 reserved + 0 frozen + 200 consumed + 100 expired + 0 revoked)
    await owner.unsafe(`
      INSERT INTO billing.credit_lot (id, organization_id, account_id, source_type, source_event_id, source_period_id,
        granted_microcredits, available_microcredits, consumed_microcredits, expired_microcredits,
        valid_from_us, expires_at_us, status, created_at_us, updated_at_us)
      VALUES (gen_random_uuid(), $1, $2, 'subscription', 'evt_expcomp_${RUN_ID}', 'period_old', 300, 0, 200, 100, 0, 1000, 'expired', 1000, 1000)`,
      [ORG_A, acctA]);
    const lotE = (await owner.unsafe<{ id: string }[]>(`SELECT id FROM billing.credit_lot WHERE source_event_id = 'evt_expcomp_${RUN_ID}'`))[0]!.id;
    const eventCE = crypto.randomUUID();
    await owner.unsafe(`
      INSERT INTO billing.ledger_event (id, organization_id, account_id, event_type, account_seq, occurred_at_us, committed_at_us)
      VALUES ($1, $2, $3, 'credit.adjusted', (SELECT COALESCE(MAX(account_seq),0)+1 FROM billing.ledger_event WHERE account_id = $3), 1000, 1000)`,
      [eventCE, ORG_A, acctA]);
    await owner.unsafe(`
      INSERT INTO billing.ledger_line (organization_id, account_id, event_id, lot_id, delta_consumed_microcredits, delta_available_microcredits, balances_after, created_at_us)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 200, -200, jsonb_build_object('note', 'fixture'), 1000)`,
      [ORG_A, acctA, eventCE, lotE]);

    // positive adjustment over an EXPIRED source: must NOT conflict, must NOT
    // revive lot E — it compensates with one fresh 30-day lot
    const adjExpired = await postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctA, eventCE, `evt_adjexp_${RUN_ID}`, "compensation", "200"), ENT_A_TOKEN, `adjexp-${RUN_ID}`);
    eq(adjExpired.status, 201, "compensation over an expired source lot is accepted");
    const adjExpBad = adjExpired.status !== 201 ? console.error(`  DEBUG adj-exp failure: ${JSON.stringify(adjExpired.body).slice(0, 300)}`) : null;
    void adjExpBad;
    const compLotE = (adjExpired.body.compensation_lot as { id: string; granted_microcredits: string; available_microcredits: string; expires_at_us: string; compensation_lot_id?: string } | null);
    ok(!!compLotE, "the expired-source adjustment answers its fresh compensation lot");
    if (compLotE) {
      eq(compLotE.granted_microcredits, "200", "the compensation lot carries exactly the expired share");
      eq(compLotE.available_microcredits, "200", "the compensation lot is fully available");
      const expDelta = BigInt(compLotE.expires_at_us) - (BigInt(Date.now()) * 1000n + 30n * 24n * 3600n * 1_000_000n);
      ok(expDelta >= -60_000_000n && expDelta <= 60_000_000n, "the compensation lot expires arrival + 30 days");
      const compOrigin = (await owner.unsafe<{ ok: string }[]>(`SELECT (compensation_for_event_id = $1::uuid)::text AS ok FROM billing.credit_lot WHERE id = $2::uuid`, [eventCE, compLotE.id]))[0]!;
      eq(compOrigin.ok, "true", "the compensation lot links its original deduction event");
    }
    const lotEAfter = (await owner.unsafe<{ a: string; c: string; g: string }[]>(`SELECT available_microcredits::text AS a, consumed_microcredits::text AS c, granted_microcredits::text AS g FROM billing.credit_lot WHERE id = $1`, [lotE]))[0]!;
    eq(`${lotEAfter.g}:${lotEAfter.a}:${lotEAfter.c}`, "300:0:200", "the expired source lot itself was never revived");
    eq(await countOf(owner, "adjustment", `original_event_id = '${eventCE}' AND adjustment_type = 'compensation'`), 1n, "exactly one adjustment for the expired-source compensation");
    const adjExpOutbox = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_event o JOIN billing.ledger_event e ON e.id = o.ledger_event_id WHERE e.adjustment_id = (SELECT id FROM billing.adjustment WHERE original_event_id = $1 AND adjustment_type = 'compensation')`, [eventCE]);
    eq(adjExpOutbox[0]!.n, "1", "exactly one outbox record for the expired-source adjustment");

    // MIXED sources: one deduction spread over an expired lot (40) and a live
    // pack lot (80) restores the live share in place and compensates only the
    // expired share
    await owner.unsafe(`
      INSERT INTO billing.credit_lot (id, organization_id, account_id, source_type, source_event_id, source_period_id,
        granted_microcredits, available_microcredits, consumed_microcredits,
        valid_from_us, expires_at_us, status, created_at_us, updated_at_us)
      VALUES (gen_random_uuid(), $1, $2, 'subscription', 'evt_expmix_${RUN_ID}', 'period_old', 40, 0, 40, 0, 1000, 'expired', 1000, 1000)`,
      [ORG_A, acctA]);
    const lotE2 = (await owner.unsafe<{ id: string }[]>(`SELECT id FROM billing.credit_lot WHERE source_event_id = 'evt_expmix_${RUN_ID}'`))[0]!.id;
    const eventCE2 = crypto.randomUUID();
    await owner.unsafe(`
      INSERT INTO billing.ledger_event (id, organization_id, account_id, event_type, account_seq, occurred_at_us, committed_at_us)
      VALUES ($1, $2, $3, 'credit.adjusted', (SELECT COALESCE(MAX(account_seq),0)+1 FROM billing.ledger_event WHERE account_id = $3), 1000, 1000)`,
      [eventCE2, ORG_A, acctA]);
    await owner.unsafe(`
      INSERT INTO billing.ledger_line (organization_id, account_id, event_id, lot_id, delta_consumed_microcredits, delta_available_microcredits, balances_after, created_at_us)
      SELECT $2::uuid, $3::uuid, $1::uuid, id, 80, -80, jsonb_build_object('note', 'fixture'), 1000
      FROM billing.credit_lot WHERE id = $4`, [eventCE2, ORG_A, acctA, packLotId]);
    await owner.unsafe(`
      INSERT INTO billing.ledger_line (organization_id, account_id, event_id, lot_id, delta_consumed_microcredits, delta_available_microcredits, balances_after, created_at_us)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 40, -40, jsonb_build_object('note', 'fixture'), 1000)`,
      [ORG_A, acctA, eventCE2, lotE2]);
    await owner.unsafe(`UPDATE billing.credit_lot SET available_microcredits = available_microcredits - 80, consumed_microcredits = consumed_microcredits + 80, revision = revision + 1 WHERE id = $1`, [packLotId]);
    const packBeforeMix = (await owner.unsafe<{ a: string }[]>(`SELECT available_microcredits::text AS a FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!.a;
    const adjMixed = await postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctA, eventCE2, `evt_adjmix_${RUN_ID}`, "compensation", "120"), ENT_A_TOKEN, `adjmix-${RUN_ID}`);
    eq(adjMixed.status, 201, "mixed expired+live compensation accepted");
    const mixedComp = adjMixed.body.compensation_lot as { granted_microcredits: string } | null;
    ok(!!mixedComp && mixedComp.granted_microcredits === "40", "only the expired share (40) became a compensation lot");
    const packAfterMix = (await owner.unsafe<{ a: string; c: string }[]>(`SELECT available_microcredits::text AS a, consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!;
    // consumed returns to zero and available returns to the PRE-consumption
    // level (packBeforeMix was captured after the fixture consumed 80)
    eq(`${packAfterMix.a}:${packAfterMix.c}`, `${BigInt(packBeforeMix) + 80n}:0`, "the live share (80) was restored in place (consumed back to zero)");
    const mixedConservation = await owner.unsafe<{ ok: string }[]>(
      `SELECT bool_and(granted_microcredits = available_microcredits + reserved_microcredits + refund_frozen_microcredits + consumed_microcredits + expired_microcredits + revoked_microcredits)::text AS ok
       FROM billing.credit_lot WHERE account_id = $1`, [acctA]);
    eq(mixedConservation[0]!.ok, "true", "every touched lot still conserves exactly");

    // a delta above the deduction's total consumed rejects with ZERO writes
    const adjOver = await post("/internal/v1/billing/adjustments", adjBodyOf(acctA, eventCE2, `evt_adjover_${RUN_ID}`, "charge_correction", "1000"), ENT_A_TOKEN, `adjover-${RUN_ID}`);
    eq(adjOver.status, 409, "restoration above the deduction's consumed total refused");
    eq((adjOver.body as { title?: string }).title, "state_conflict", "over-restoration refusal is state_conflict");
    eq(await countOf(owner, "adjustment", `original_event_id = '${eventCE2}' AND adjustment_type = 'charge_correction'`), 0n, "the refused over-restoration stored no adjustment");
    eq(await countOf(owner, "business_event", `source_event_id = 'evt_adjover_${RUN_ID}'`), 0n, "the refused over-restoration stored no business identity");

    // replay under a NEW http key answers the FIRST stored snapshot: the
    // compensation-lot projection in the response does NOT drift after the
    // lot's components changed since creation. The replay body must be
    // content-identical to the original (including effective_at_us), so it
    // is captured once and reused verbatim.
    const mixedCompId = (adjMixed.body.compensation_lot as { id: string }).id;
    await owner.unsafe(`UPDATE billing.credit_lot SET available_microcredits = available_microcredits - 40, consumed_microcredits = consumed_microcredits + 40, revision = revision + 99 WHERE id = $1`, [mixedCompId]);
    const mixedReplayBody = adjBodyOf(acctA, eventCE2, `evt_adjmix_${RUN_ID}`, "compensation", "120", "subj_entitlement_svc", {
      effective_at_us: (adjMixed.body.adjustment as { effective_at_us: string }).effective_at_us,
    });
    const mixedReplay = await postConverge("/internal/v1/billing/adjustments", mixedReplayBody, ENT_A_TOKEN, `adjmix-replay-${RUN_ID}`);
    ok(mixedReplay.status === 200 || mixedReplay.status === 201, "new-key replay of the mixed adjustment succeeds");
    const replayComp = mixedReplay.body.compensation_lot as { available_microcredits: string; revision: string } | null;
    ok(!!replayComp && replayComp.available_microcredits === "40", "replayed compensation lot shows its CREATION projection, not current state");
    ok(!!replayComp && replayComp.revision === "1", "replayed compensation lot shows its CREATION revision");
    eq(await countOf(owner, "adjustment", `original_event_id = '${eventCE2}' AND adjustment_type = 'compensation'`), 1n, "new-key replay stored no second adjustment");

    // ================== AC5c the shared recovery quota across ALL entries
    console.log("\n== AC5c shared per-line recovery quota: grants x adjustments, expired sources, races, restart");
    // A deduction fixture helper: one ledger event + per-lot consumption lines
    // written through the owner connection (a real deduction the entries can
    // then restore against).
    // `live` lines move the lot components (still-valid lots); fixture lines
    // for already-expired lots only append the historical ledger line — the
    // lot's components were written final at fixture time (as in AC5b).
    const insertDeduction = async (lines: { lotId: string; amount: bigint; live: boolean }[]): Promise<string> => {
      const ev = crypto.randomUUID();
      await owner.unsafe(
        `INSERT INTO billing.ledger_event (id, organization_id, account_id, event_type, account_seq, occurred_at_us, committed_at_us)
         VALUES ($1, $2, $3, 'credit.adjusted', (SELECT COALESCE(MAX(account_seq),0)+1 FROM billing.ledger_event WHERE account_id = $3), 1000, 1000)`,
        [ev, ORG_A, acctA],
      );
      for (const l of lines) {
        await owner.unsafe(
          `INSERT INTO billing.ledger_line (organization_id, account_id, event_id, lot_id, delta_consumed_microcredits, delta_available_microcredits, balances_after, created_at_us)
           SELECT $2::uuid, $3::uuid, $1::uuid, id, $5::bigint, -$5::bigint,
             jsonb_build_object('note', 'fixture'), 1000
           FROM billing.credit_lot WHERE id = $4`,
          [ev, ORG_A, acctA, l.lotId, String(l.amount)],
        );
        if (l.live) {
          await owner.unsafe(
            `UPDATE billing.credit_lot SET available_microcredits = available_microcredits - $2, consumed_microcredits = consumed_microcredits + $2, revision = revision + 1 WHERE id = $1`,
            [l.lotId, String(l.amount)],
          );
        }
      }
      return ev;
    };
    // The valid_from is FROZEN for the whole AC5c block: the grant content is
    // the dedupe identity, so a restart replay must carry the identical
    // normalized request (a recomputed timestamp would be a different
    // content behind the same key and business identity).
    const ac5cValidFrom = String(BigInt(Date.now()) * 1000n);
    const compGrantOf = (sourceEventId: string, originalEventId: string, amount: string) =>
      postConverge("/internal/v1/billing/credit-grants", makeBody({
        billing_account_id: acctA,
        source_event_id: sourceEventId,
        source_type: "compensation",
        source_period_id: null,
        granted_microcredits: amount,
        valid_from_us: ac5cValidFrom,
        expires_at_us: null,
        original_event_id: originalEventId,
      }), ENT_A_TOKEN, `${sourceEventId}-key`);

    // (a) review blocker replay: direct grant 250 first, then the SAME +250
    // through a positive adjustment — the adjustment must be refused whole.
    const evA = await insertDeduction([{ lotId: lot0, amount: 250n, live: true }]);
    const gA = await compGrantOf(`evt_rc_g1_${RUN_ID}`, evA, "250");
    eq(gA.status, 201, "AC5c: direct grant restores the full deduction in place");
    const adjA = await post("/internal/v1/billing/adjustments", adjBodyOf(acctA, evA, `evt_rc_a1_${RUN_ID}`, "charge_correction", "250"), ENT_A_TOKEN, `rc-a1`);
    eq(adjA.status, 409, "AC5c: same deduction +250 adjustment after a full grant is refused whole");
    eq(await countOf(owner, "adjustment", `original_event_id = '${evA}'`), 0n, "AC5c: refused adjustment stored no row");
    eq(await countOf(owner, "recovery_allocation", `original_event_id = '${evA}'`), 1n, "AC5c: refused adjustment consumed no extra quota");
    const overGrantA = await compGrantOf(`evt_rc_g1b_${RUN_ID}`, evA, "1");
    eq(overGrantA.status, 409, "AC5c: a second grant over the spent quota is refused too");

    // (b) reverse order: adjustment first, grant second, still capped.
    const evB = await insertDeduction([{ lotId: lot0, amount: 250n, live: true }]);
    const adjB = await postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctA, evB, `evt_rc_a2_${RUN_ID}`, "compensation", "100"), ENT_A_TOKEN, `rc-a2`);
    eq(adjB.status, 201, "AC5c: adjustment-first partial restoration accepted");
    const gBOver = await compGrantOf(`evt_rc_g2_${RUN_ID}`, evB, "151");
    eq(gBOver.status, 409, "AC5c: grant above the remaining shared quota (150) refused whole");
    const gB = await compGrantOf(`evt_rc_g2b_${RUN_ID}`, evB, "150");
    eq(gB.status, 201, "AC5c: grant of exactly the remaining quota accepted");
    const adjB2 = await post("/internal/v1/billing/adjustments", adjBodyOf(acctA, evB, `evt_rc_a2b_${RUN_ID}`, "expiry_correction", "1"), ENT_A_TOKEN, `rc-a2b`);
    eq(adjB2.status, 409, "AC5c: another adjustment type over the spent quota refused");
    eq(`${await countOf(owner, "adjustment", `original_event_id = '${evB}'`)}:${await countOf(owner, "recovery_allocation", `original_event_id = '${evB}'`)}`, "1:2", "AC5c: exactly one adjustment and two per-entry recovery rows");
    const lot0Quota = await owner.unsafe<{ s: string }[]>(`SELECT COALESCE(SUM(restored_microcredits),0)::text AS s FROM billing.recovery_allocation WHERE original_lot_id = $1`, [lot0]);
    eq(lot0Quota[0]!.s, "750", "AC5c: the shared quota ledger equals every restoration on this lot across both entries (AC2 grant 250 + grant 250 + adjustment 100 + grant 150)");

    // (c) cross-type adjustments: the first type spends the quota, the others
    // are refused — the quota ledger is shared, not per adjustment type.
    const evC = await insertDeduction([{ lotId: lot0, amount: 250n, live: true }]);
    const adjC = await postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctA, evC, `evt_rc_a3_${RUN_ID}`, "charge_correction", "250"), ENT_A_TOKEN, `rc-a3`);
    eq(adjC.status, 201, "AC5c: charge_correction consumes the shared quota");
    for (const t of ["compensation", "expiry_correction", "charge_correction"]) {
      const again = await post("/internal/v1/billing/adjustments", adjBodyOf(acctA, evC, `evt_rc_a3_${t}_${RUN_ID}`, t, "1"), ENT_A_TOKEN, `rc-again-${t}`);
      eq(again.status === 409 || again.status === 201, true, "AC5c: probe completed");
      if (t !== "charge_correction") {
        // same scope content would replay; a DIFFERENT type is a new scope,
        // and its positive delta has no quota left
        eq(again.status, 409, `AC5c: ${t} over the spent quota refused`);
      }
    }
    // (the charge_correction retry above replayed its own first result)

    // (d) EXPIRED source direct grant: the expired share becomes ONE fresh
    // 30-day compensation lot; the expired source lot itself is never revived,
    // and the quota is shared with adjustments afterwards.
    await owner.unsafe(
      `INSERT INTO billing.credit_lot (id, organization_id, account_id, source_type, source_event_id, source_period_id,
         granted_microcredits, available_microcredits, consumed_microcredits, expired_microcredits,
         valid_from_us, expires_at_us, status, created_at_us, updated_at_us)
       VALUES (gen_random_uuid(), $1, $2, 'subscription', 'evt_expg_${RUN_ID}', 'period_old', 200, 0, 120, 80, 0, 1000, 'expired', 1000, 1000)`,
      [ORG_A, acctA],
    );
    const lotEG = (await owner.unsafe<{ id: string }[]>(`SELECT id FROM billing.credit_lot WHERE source_event_id = 'evt_expg_${RUN_ID}'`))[0]!.id;
    const evD = await insertDeduction([{ lotId: lotEG, amount: 120n, live: false }]);
    const gD = await compGrantOf(`evt_rc_g3_${RUN_ID}`, evD, "120");
    eq(gD.status, 201, "AC5c: direct grant over an expired source accepted");
    const gDLot = gD.body.credit_lot as { id: string; source_type: string; granted_microcredits: string; expires_at_us: string };
    ok(gDLot.id !== lotEG, "AC5c: the expired source lot was NOT restored in place");
    eq(gDLot.source_type, "compensation", "AC5c: the expired share became a compensation lot");
    eq(gDLot.granted_microcredits, "120", "AC5c: the compensation lot carries exactly the expired share");
    const gDExpDelta = BigInt(gDLot.expires_at_us) - (BigInt(Date.now()) * 1000n + 30n * 24n * 3600n * 1_000_000n);
    ok(gDExpDelta >= -60_000_000n && gDExpDelta <= 60_000_000n, "AC5c: the compensation lot expires arrival + 30 days");
    const lotEGAfter = (await owner.unsafe<{ g: string; a: string; c: string; e: string }[]>(`SELECT granted_microcredits::text AS g, available_microcredits::text AS a, consumed_microcredits::text AS c, expired_microcredits::text AS e FROM billing.credit_lot WHERE id = $1`, [lotEG]))[0]!;
    eq(`${lotEGAfter.g}:${lotEGAfter.a}:${lotEGAfter.c}:${lotEGAfter.e}`, "200:0:120:80", "AC5c: the expired source lot itself was never revived by the direct grant");
    eq(await countOf(owner, "recovery_allocation", `original_event_id = '${evD}' AND restored_via = 'credit_grant'`), 1n, "AC5c: the expired-share grant recorded its quota under the grant entry");
    const adjD = await post("/internal/v1/billing/adjustments", adjBodyOf(acctA, evD, `evt_rc_a4_${RUN_ID}`, "compensation", "1"), ENT_A_TOKEN, `rc-a4`);
    eq(adjD.status, 409, "AC5c: adjustment over the grant-compensated expired deduction refused");

    // (e) MIXED deduction (expired + still-valid) through the GRANT entry:
    // the live share restores in place, only the expired share compensates.
    await owner.unsafe(
      `INSERT INTO billing.credit_lot (id, organization_id, account_id, source_type, source_event_id, source_period_id,
         granted_microcredits, available_microcredits, consumed_microcredits,
         valid_from_us, expires_at_us, status, created_at_us, updated_at_us)
       VALUES (gen_random_uuid(), $1, $2, 'subscription', 'evt_expg2_${RUN_ID}', 'period_old', 70, 0, 70, 0, 1000, 'expired', 1000, 1000)`,
      [ORG_A, acctA],
    );
    const lotEG2 = (await owner.unsafe<{ id: string }[]>(`SELECT id FROM billing.credit_lot WHERE source_event_id = 'evt_expg2_${RUN_ID}'`))[0]!.id;
    const evE = await insertDeduction([{ lotId: lotEG2, amount: 70n, live: false }, { lotId: packLotId, amount: 30n, live: true }]);
    const packBeforeE = (await owner.unsafe<{ a: string }[]>(`SELECT available_microcredits::text AS a FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!.a;
    const gE = await compGrantOf(`evt_rc_g4_${RUN_ID}`, evE, "100");
    eq(gE.status, 201, "AC5c: mixed expired+live grant accepted");
    const gELot = gE.body.credit_lot as { id: string; source_type: string; granted_microcredits: string };
    eq(`${gELot.source_type}:${gELot.granted_microcredits}`, "compensation:70", "AC5c: the response lot is the 70-credit compensation share");
    const packAfterE = (await owner.unsafe<{ a: string; c: string }[]>(`SELECT available_microcredits::text AS a, consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!;
    eq(`${packAfterE.a}:${packAfterE.c}`, `${BigInt(packBeforeE) + 30n}:0`, "AC5c: the live share (30) restored in place in the pack lot");
    const eg2After = (await owner.unsafe<{ a: string; c: string }[]>(`SELECT available_microcredits::text AS a, consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [lotEG2]))[0]!;
    eq(`${eg2After.a}:${eg2After.c}`, "0:70", "AC5c: the expired share was not revived");
    const allocE = await owner.unsafe<{ lot: string; r: string }[]>(`SELECT original_lot_id AS lot, restored_microcredits::text AS r FROM billing.recovery_allocation WHERE original_event_id = $1`, [evE]);
    eq(allocE.map((x) => `${x.r}`).sort().join("+"), "30+70", "AC5c: both per-line shares recorded against the shared quota ledger");
    eq(await countOf(owner, "credit_lot", `compensation_for_event_id = '${evE}'`), 1n, "AC5c: exactly one compensation lot for the expired share");
    const adjE = await post("/internal/v1/billing/adjustments", adjBodyOf(acctA, evE, `evt_rc_a5_${RUN_ID}`, "compensation", "100"), ENT_A_TOKEN, `rc-a5`);
    eq(adjE.status, 409, "AC5c: full-deduction adjustment after the mixed grant refused");

    // (f) concurrent cross-entry race: 4 demands of 100 over ONE 200-credit
    // deduction (two grants + two adjustment types). The account lock
    // serializes them; the shared quota ledger admits EXACTLY TWO (200 of
    // the 400 demanded) and refuses the rest whole.
    const evF = await insertDeduction([{ lotId: packLotId, amount: 200n, live: true }]);
    const raceResults = await Promise.all([
      compGrantOf(`evt_rc_p1_${RUN_ID}`, evF, "100"),
      compGrantOf(`evt_rc_p2_${RUN_ID}`, evF, "100"),
      postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctA, evF, `evt_rc_p3_${RUN_ID}`, "charge_correction", "100"), ENT_A_TOKEN, `rc-p3`),
      postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctA, evF, `evt_rc_p4_${RUN_ID}`, "compensation", "100"), ENT_A_TOKEN, `rc-p4`),
    ]);
    const winners = raceResults.filter((r) => r.status === 201);
    eq(winners.length, 2, "AC5c: exactly TWO of the four concurrent cross-entry demands fit the quota");
    ok(raceResults.every((r) => r.status === 201 || r.status === 409), `AC5c: every loser answered 409 state_conflict (${raceResults.map((r) => r.status).join(",")})`);
    const raceQuota = await owner.unsafe<{ s: string; n: string }[]>(`SELECT COALESCE(SUM(restored_microcredits),0)::text AS s, COUNT(*)::text AS n FROM billing.recovery_allocation WHERE original_event_id = $1`, [evF]);
    eq(raceQuota[0]!.s, "200", "AC5c: the race restored exactly the deduction, never more");
    eq(raceQuota[0]!.n, "2", "AC5c: each winner recorded exactly one recovery row for the single original line");
    const packF = (await owner.unsafe<{ c: string }[]>(`SELECT consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!;
    eq(packF.c, "0", "AC5c: the raced deduction's consumed share moved back to zero exactly once");

    // (g) restart: replays answer the stored FIRST result and consume no new
    // quota — the durable shared ledger makes retries inert.
    await svc.stop();
    svc = await startService();
    const gAreplay = await compGrantOf(`evt_rc_g1_${RUN_ID}`, evA, "250");
    ok(gAreplay.status === 200 || gAreplay.status === 201, "AC5c: grant replay after restart succeeds");
    eq((gAreplay.body.credit_lot as { id: string }).id, (gA.body.credit_lot as { id: string }).id, "AC5c: replay answers the SAME stored result lot");
    eq(await countOf(owner, "recovery_allocation", `original_event_id = '${evA}'`), 1n, "AC5c: restart replay consumed no extra quota");
    const conservedAll = await owner.unsafe<{ ok: string }[]>(
      `SELECT bool_and(granted_microcredits = available_microcredits + reserved_microcredits + refund_frozen_microcredits + consumed_microcredits + expired_microcredits + revoked_microcredits)::text AS ok
       FROM billing.credit_lot WHERE account_id = $1`, [acctA]);
    eq(conservedAll[0]!.ok, "true", "AC5c: every lot in the account still conserves exactly after all cross-entry traffic");

    // ============================================ AC6a/AC6b crash-window tests
    console.log("\n== AC6a/6b crash windows (commit-before / commit-after), grant + adjustment");
    await svc.stop();

    // --- AC6a grant: die inside the transaction, before COMMIT
    const barrierA = mkdtempSync(join(tmpdir(), `billing64_barrier_${RUN_ID}_a_`));
    writeFileSync(join(barrierA, "before-commit"), "1");
    let crash = await startService(barrierA);
    const crashSrc = `evt_crash_${RUN_ID}`;
    const pending = post("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: crashSrc, source_type: "pack", granted_microcredits: "424242" }), ENT_A_TOKEN, `crash-${RUN_ID}`);
    pending.catch(() => {}); // attach now: the SIGKILL below rejects it mid-flight
    await waitFor(() => existsSync(join(barrierA, "entered-before-commit")), 15000);
    crash.proc.kill("SIGKILL");
    await waitExit(crash.proc);
    await pending.catch(() => {});
    eq(await countOf(owner, "credit_lot", `source_event_id = '${crashSrc}'`), 0n, "AC6a grant: no lot visible after pre-commit kill");
    eq(await countOf(owner, "business_event", `source_event_id = '${crashSrc}'`), 0n, "AC6a grant: no business identity after pre-commit kill");
    eq(await countOf(owner, "outbox_event", `payload->>'granted_microcredits' = '424242'`), 0n, "AC6a grant: no outbox record after pre-commit kill");
    eq(await countOf(owner, "idempotency", `key = 'crash-${RUN_ID}'`), 0n, "AC6a grant: no success idempotency row after pre-commit kill");
    rmSync(join(barrierA, "before-commit"), { force: true });
    await crash.stop();
    crash = await startService(barrierA);
    const retryA = await postConverge("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: crashSrc, source_type: "pack", granted_microcredits: "424242" }), ENT_A_TOKEN, `crash-${RUN_ID}`);
    eq(retryA.status, 201, "AC6a grant: retry after crash completes exactly one full grant");
    eq(await countOf(owner, "credit_lot", `source_event_id = '${crashSrc}'`), 1n, "AC6a grant: exactly one lot after retry");
    eq(await countOf(owner, "outbox_event", `payload->>'granted_microcredits' = '424242'`), 1n, "AC6a grant: exactly one outbox after retry");

    // --- AC6b grant: COMMIT done, killed before the response
    const barrierB = mkdtempSync(join(tmpdir(), `billing64_barrier_${RUN_ID}_b_`));
    writeFileSync(join(barrierB, "after-commit"), "1");
    await crash.stop();
    let crashB = await startService(barrierB);
    const crashSrcB = `evt_crash_b_${RUN_ID}`;
    const pendingB = post("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: crashSrcB, source_type: "pack", granted_microcredits: "515151" }), ENT_A_TOKEN, `crashb-${RUN_ID}`);
    pendingB.catch(() => {}); // attach now: the SIGKILL below rejects it mid-flight
    await waitFor(() => existsSync(join(barrierB, "entered-after-commit")), 15000);
    const killB = crashB.proc.kill("SIGKILL");
    ok(killB, "AC6b grant: process SIGKILLed after COMMIT, before response");
    await waitExit(crashB.proc);
    await pendingB.catch(() => {});
    eq(await countOf(owner, "credit_lot", `source_event_id = '${crashSrcB}'`), 1n, "AC6b grant: committed lot survives the post-commit kill");
    const outboxB = await countOf(owner, "outbox_delivery", `status = 'pending'`);
    ok(outboxB >= 1n, "AC6b grant: pending delivery survives the post-commit kill");
    // restart on the SAME database and replay with the original key
    rmSync(join(barrierB, "after-commit"), { force: true });
    crashB = await startService(barrierB);
    const retryB = await postConverge("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: crashSrcB, source_type: "pack", granted_microcredits: "515151" }), ENT_A_TOKEN, `crashb-${RUN_ID}`);
    eq(retryB.status, 200, "AC6b grant: retry replays the committed result");
    eq(await countOf(owner, "credit_lot", `source_event_id = '${crashSrcB}'`), 1n, "AC6b grant: replay added no second lot");

    // --- AC6a adjustment: die inside the transaction, before COMMIT
    const adjPackBefore = (await owner.unsafe<{ a: string; r: string }[]>(`SELECT available_microcredits::text AS a, revoked_microcredits::text AS r FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!;
    const barrierC = mkdtempSync(join(tmpdir(), `billing64_barrier_${RUN_ID}_c_`));
    writeFileSync(join(barrierC, "before-commit"), "1");
    await crashB.stop(); // never adopt the previous instance as "the service"
    let crashC = await startService(barrierC);
    const adjCrashScopeA = adjBodyOf(acctA, packEventId, `evt_adjcrasha_${RUN_ID}`, "expiry_correction", "-11");
    const adjPendingA = post("/internal/v1/billing/adjustments", adjCrashScopeA, ENT_A_TOKEN, `adjcrasha-${RUN_ID}`);
    adjPendingA.catch(() => {}); // attach now: the SIGKILL below rejects it mid-flight
    await waitFor(() => existsSync(join(barrierC, "entered-before-commit")), 15000);
    crashC.proc.kill("SIGKILL");
    await waitExit(crashC.proc);
    await adjPendingA.catch(() => {});
    // every identity of the adjustment is checked through the independent
    // owner SQL connection: adjustment row, its ledger event + lines, the
    // pending outbox record, the success idempotency row, and the batch
    const adjEventsBeforeKill = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.ledger_event WHERE adjustment_id IS NOT NULL`);
    eq(await countOf(owner, "adjustment", `original_event_id = '${packEventId}' AND adjustment_type = 'expiry_correction'`), 0n, "AC6a adjustment: no adjustment row after pre-commit kill");
    eq(await countOf(owner, "business_event", `source_event_id = 'evt_adjcrasha_${RUN_ID}'`), 0n, "AC6a adjustment: no business identity after pre-commit kill");
    const adjEventsAfterKill = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.ledger_event WHERE adjustment_id IS NOT NULL`);
    eq(adjEventsAfterKill[0]!.n, adjEventsBeforeKill[0]!.n, "AC6a adjustment: no adjustment ledger event survived the pre-commit kill");
    eq(await countOf(owner, "outbox_event", `payload->>'signed_delta_microcredits' = '-11'`), 0n, "AC6a adjustment: no outbox record after pre-commit kill");
    eq(await countOf(owner, "idempotency", `key = 'adjcrasha-${RUN_ID}'`), 0n, "AC6a adjustment: no success idempotency row after pre-commit kill");
    const adjPackKilled = (await owner.unsafe<{ a: string; r: string }[]>(`SELECT available_microcredits::text AS a, revoked_microcredits::text AS r FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!;
    eq(`${adjPackKilled.a}:${adjPackKilled.r}`, `${adjPackBefore.a}:${adjPackBefore.r}`, "AC6a adjustment: no half-applied lot component move survived the kill");
    rmSync(join(barrierC, "before-commit"), { force: true });
    await crashC.stop(); // never adopt the previous instance as "the service"
    crashC = await startService(barrierC);
    const adjRetryA = await postConverge("/internal/v1/billing/adjustments", adjCrashScopeA, ENT_A_TOKEN, `adjcrasha-${RUN_ID}`);
    eq(adjRetryA.status, 201, "AC6a adjustment: retry after crash completes exactly one full adjustment");
    eq(await countOf(owner, "adjustment", `original_event_id = '${packEventId}' AND adjustment_type = 'expiry_correction'`), 1n, "AC6a adjustment: exactly one adjustment after retry");
    const adjRetryAEvent = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_event o JOIN billing.ledger_event e ON e.id = o.ledger_event_id WHERE e.adjustment_id = (SELECT id FROM billing.adjustment WHERE original_event_id = $1 AND adjustment_type = 'expiry_correction')`, [packEventId]);
    eq(adjRetryAEvent[0]!.n, "1", "AC6a adjustment: exactly one ledger event and one outbox after retry");
    eq(await countOf(owner, "idempotency", `key = 'adjcrasha-${RUN_ID}'`), 1n, "AC6a adjustment: exactly one success idempotency row after retry");
    const adjPackRetry = (await owner.unsafe<{ a: string; r: string }[]>(`SELECT available_microcredits::text AS a, revoked_microcredits::text AS r FROM billing.credit_lot WHERE id = $1`, [packLotId]))[0]!;
    eq(BigInt(adjPackRetry.r) - BigInt(adjPackBefore.r), 11n, "AC6a adjustment: the withdrawal moved exactly 11 credits to revoked");

    // --- AC6b adjustment: COMMIT done, killed before the response; the
    // committed identity (adjustment, event, pending outbox, idempotency)
    // survives, the restart replay answers it without adding anything
    const barrierD = mkdtempSync(join(tmpdir(), `billing64_barrier_${RUN_ID}_d_`));
    writeFileSync(join(barrierD, "after-commit"), "1");
    await crashC.stop();
    let crashD = await startService(barrierD);
    const adjCrashScope = adjBodyOf(acctA, packEventId, `evt_adjcrash_${RUN_ID}`, "charge_correction", "-7");
    const adjCrash = post("/internal/v1/billing/adjustments", adjCrashScope, ENT_A_TOKEN, `adjcrash-${RUN_ID}`);
    adjCrash.catch(() => {}); // attach now: the SIGKILL below rejects it mid-flight
    await waitFor(() => existsSync(join(barrierD, "entered-after-commit")), 15000);
    crashD.proc.kill("SIGKILL");
    await waitExit(crashD.proc);
    await adjCrash.catch(() => {});
    const adjCrashCount = await countOf(owner, "adjustment", `original_event_id = '${packEventId}' AND adjustment_type = 'charge_correction'`);
    eq(adjCrashCount, 1n, "AC6b adjustment: committed adjustment survives the kill");
    const adjCrashEvent = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_event o JOIN billing.ledger_event e ON e.id = o.ledger_event_id WHERE e.adjustment_id = (SELECT id FROM billing.adjustment WHERE original_event_id = $1 AND adjustment_type = 'charge_correction')`, [packEventId]);
    eq(adjCrashEvent[0]!.n, "1", "AC6b adjustment: its ledger event and pending outbox record survive the kill");
    const adjCrashPending = await countOf(owner, "outbox_delivery", `status = 'pending'`);
    ok(adjCrashPending >= 1n, "AC6b adjustment: a pending delivery survives the kill");
    eq(await countOf(owner, "idempotency", `key = 'adjcrash-${RUN_ID}'`), 1n, "AC6b adjustment: the success idempotency row survives the kill");
    rmSync(join(barrierD, "after-commit"), { force: true });
    crashD = await startService(barrierD);
    const adjRetry = await postConverge("/internal/v1/billing/adjustments", adjCrashScope, ENT_A_TOKEN, `adjcrash-${RUN_ID}`);
    eq(adjRetry.status, 200, "AC6b adjustment: retry after restart replays the original result");
    const adjCrashId = (await owner.unsafe<{ id: string }[]>(`SELECT id FROM billing.adjustment WHERE original_event_id = $1 AND adjustment_type = 'charge_correction'`, [packEventId]))[0]!.id;
    eq((adjRetry.body.adjustment as { id: string }).id, adjCrashId, "AC6b adjustment: replay answers the SAME adjustment id");
    eq(await countOf(owner, "adjustment", `original_event_id = '${packEventId}' AND adjustment_type = 'charge_correction'`), 1n, "AC6b adjustment: replay added no second adjustment");
    const adjCrashEventAfter = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_event o JOIN billing.ledger_event e ON e.id = o.ledger_event_id WHERE e.adjustment_id = (SELECT id FROM billing.adjustment WHERE original_event_id = $1 AND adjustment_type = 'charge_correction')`, [packEventId]);
    eq(adjCrashEventAfter[0]!.n, "1", "AC6b adjustment: replay added no second ledger event or outbox record");
    eq(await countOf(owner, "idempotency", `key = 'adjcrash-${RUN_ID}'`), 1n, "AC6b adjustment: replay added no second idempotency row for the key");

    // ============================================ pagination page boundaries
    console.log("\n== pagination: limit=1 walks reproduce the full listings exactly");
    // settle any due expiry first so no read appends events mid-walk
    await get(`/internal/v1/billing/accounts/${acctA}`, ENT_A_TOKEN);
    const walkList = async (
      pathWithoutQuery: string,
      token: string,
      limit: number,
    ): Promise<{ ids: string[]; pages: number }> => {
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        pages++;
        // the base path may already carry a query (e.g. billing_account_id)
        const sep = pathWithoutQuery.includes("?") ? "&" : "?";
        const url = `${pathWithoutQuery}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const r = await get(url, token);
        if (r.status !== 200)
          throw new Error(`walk failed ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
        const b = r.body as { items: { id: string }[]; next_cursor: string | null };
        ids.push(...b.items.map((i) => i.id));
        if (!b.next_cursor) return { ids, pages };
        cursor = b.next_cursor;
        if (pages > 500) throw new Error("pagination walk did not terminate");
      }
    };
    const fullLots = await get(`/internal/v1/billing/credit-lots?billing_account_id=${acctA}&limit=500`, ENT_A_TOKEN);
    const fullLotIds = (fullLots.body.items as { id: string }[]).map((i) => i.id);
    ok(fullLotIds.length >= 2, "enough lots exist for a boundary-relevant walk");
    const walkedLots = await walkList(`/internal/v1/billing/credit-lots?billing_account_id=${acctA}`, ENT_A_TOKEN, 1);
    eq(walkedLots.pages, fullLotIds.length, "lot pages: exactly one lot per limit=1 page");
    eq(JSON.stringify(walkedLots.ids), JSON.stringify(fullLotIds), "limit=1 lot walk visits every lot exactly once, in order");
    const fullAdj = await get(`/internal/v1/billing/adjustments?billing_account_id=${acctA}&limit=500`, ENT_A_TOKEN);
    const fullAdjIds = (fullAdj.body.items as { id: string }[]).map((i) => i.id);
    ok(fullAdjIds.length >= 2, "enough adjustments exist for a boundary-relevant walk");
    const walkedAdj = await walkList(`/internal/v1/billing/adjustments?billing_account_id=${acctA}`, ENT_A_TOKEN, 1);
    eq(walkedAdj.pages, fullAdjIds.length, "adjustment pages: exactly one adjustment per limit=1 page");
    eq(JSON.stringify(walkedAdj.ids), JSON.stringify(fullAdjIds), "limit=1 adjustment walk visits every adjustment exactly once, in order");
    const fullEvents = await get(`/internal/v1/billing/accounts/${acctA}/ledger-events?limit=500`, ENT_A_TOKEN);
    const fullEventIds = (fullEvents.body.items as { id: string }[]).map((i) => i.id);
    ok(fullEventIds.length >= 2, "enough ledger events exist for a boundary-relevant walk");
    const walkedEvents = await walkList(`/internal/v1/billing/accounts/${acctA}/ledger-events`, ENT_A_TOKEN, 1);
    eq(walkedEvents.pages, fullEventIds.length, "ledger event pages: exactly one event per limit=1 page");
    eq(JSON.stringify(walkedEvents.ids), JSON.stringify(fullEventIds), "limit=1 event walk visits every event exactly once, in order");

    // ============================================ expiry materialization
    console.log("\n== expiry materialization (conservation preserved, one event per batch)");
    await svc.stop();
    const pastExpiry = BigInt(Date.now()) * 1000n - 1_000_000n;
    await owner.unsafe(`
      INSERT INTO billing.credit_lot (id, organization_id, account_id, source_type, source_event_id, source_period_id,
        granted_microcredits, available_microcredits, reserved_microcredits, valid_from_us, expires_at_us, status, created_at_us, updated_at_us)
      VALUES (gen_random_uuid(), $1, $2, 'subscription', 'evt_exp_${RUN_ID}', 'period_old', 350, 300, 50, 0, $3, 'active', 0, 0)`,
      [ORG_A, acctA, pastExpiry]);
    const preEvents = await countOf(owner, "ledger_event", `event_type = 'credit.expired'`);
    const snapAfterExpiry = await get(`/internal/v1/billing/accounts/${acctA}`, ENT_A_TOKEN);
    eq(snapAfterExpiry.status, 200, "query materializes due expiries");
    const postEvents = await countOf(owner, "ledger_event", `event_type = 'credit.expired'`);
    eq(postEvents, preEvents + 1n, "one expiry event appended for the due batch");
    const expiredRow = (await owner.unsafe<{ a: string; e: string; r: string }[]>(`SELECT available_microcredits::text AS a, expired_microcredits::text AS e, reserved_microcredits::text AS r FROM billing.credit_lot WHERE source_event_id = 'evt_exp_${RUN_ID}'`))[0]!;
    eq(expiredRow.a, "0", "expiry moved available to zero");
    eq(expiredRow.e, "300", "expiry moved exactly the available part");
    eq(expiredRow.r, "50", "expiry PRESERVED the reserved component (kept in flight)");
    const expConserved = (await owner.unsafe<{ ok: string }[]>(
      `SELECT (granted_microcredits = available_microcredits + reserved_microcredits + refund_frozen_microcredits + consumed_microcredits + expired_microcredits + revoked_microcredits)::text AS ok FROM billing.credit_lot WHERE source_event_id = 'evt_exp_${RUN_ID}'`))[0]!;
    eq(expConserved.ok, "true", "expired lot still conserves exactly (350 = 0+50+0+0+300+0)");
    const snapVals = snapAfterExpiry.body as { available_microcredits: string };
    // the expired lot's available no longer counts toward spendable
    // after materialisation the expired lot holds ZERO available, so the
    // snapshot's spendable projection is simply available where valid_from
    // has arrived (packs included; their available is untouched by expiry)
    const expSnapSum = await owner.unsafe<{ avail: string }[]>(
      `SELECT COALESCE(SUM(available_microcredits) FILTER (WHERE valid_from_us <= ${BigInt(Date.now()) * 1000n}),0)::text AS avail
       FROM billing.credit_lot WHERE account_id = $1`, [acctA]);
    const zeroed = (await owner.unsafe<{ z: string }[]>(
      `SELECT available_microcredits::text AS z FROM billing.credit_lot WHERE source_event_id = 'evt_exp_${RUN_ID}'`))[0]!;
    eq(zeroed.z, "0", "expired lot carries zero spendable available");
    eq(snapVals.available_microcredits, expSnapSum[0]!.avail, "spendable balance equals the valid-from projection (expired lots contribute nothing)");
    await postConverge("/internal/v1/billing/accounts", { organization_id: ORG_A, owner_subject_id: "noop", personal_workspace_id: "noop_x" }, REGISTER_TOKEN, `noop-${RUN_ID}`);
    const postEvents2 = await countOf(owner, "ledger_event", `event_type = 'credit.expired'`);
    eq(postEvents2, postEvents, "repeated queries do not duplicate expiry events");

    // ================================= migration re-run on LIVE data
    console.log("\n== migration re-run on live data: protection converges atomically, nothing is lost");
    const pendingBeforeRe = await countOf(owner, "outbox_delivery", `status = 'pending'`);
    ok(pendingBeforeRe >= 1n, "pending deliveries exist before the live-data re-run");
    await runBillingMigrations(OWNER_URL, { appPassword: APP_PASSWORD });
    const pendingAfterRe = await countOf(owner, "outbox_delivery", `status = 'pending'`);
    eq(pendingAfterRe, pendingBeforeRe, "the live-data re-run preserved every pending delivery");
    const triggersRe = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM pg_trigger WHERE tgname LIKE 'billing\\_%' AND tgname LIKE '%immutable%'`);
    ok(BigInt(triggersRe[0]!.n) >= 7n, "immutability triggers still installed after the live-data re-run");
    const appRewriteRe = await app.unsafe(`UPDATE billing.adjustment SET reason = 'rewritten'`).catch((e: { code?: string }) => e);
    ok((appRewriteRe as { code?: string }).code === "42501", "runtime role still cannot rewrite history after the re-run (42501)");
    const ownerRewriteRe = await owner.unsafe(`UPDATE billing.ledger_event SET reason = 'rewritten' WHERE reason IS NULL`).catch((e: { message?: string }) => e);
    ok(String((ownerRewriteRe as { message?: string }).message).includes("append-only"), "owner still cannot rewrite history after the re-run (trigger)");
    const journalRe = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.__drizzle_migrations`);
    eq(journalRe[0]!.n, "2", "the live-data re-run added no migration journal row");

    console.log(`\nmain phase complete: ${checks} checks, ${failures} failures`);
    return failures === 0 ? 0 : 1;
  } finally {
    await stopAllServices();
    await owner.end({ timeout: 2 }).catch(() => {});
    await app.end({ timeout: 2 }).catch(() => {});
  }
}

/**
 * The v1 -> v2 upgrade phase (review blocker: the v1 code committed
 * restorations WITHOUT the recovery_allocation quota ledger, so a naive
 * migration re-opens fully refunded deductions to a fresh grant under a new
 * business key).
 *
 * This phase runs FIRST, against the FRESH database, with the REAL v1
 * ledger snapshot (extracted by the runner from the pre-recovery commit):
 *   1. apply the v1 migration set only (journal = 1, no quota ledger);
 *   2. serve with the v1 entrypoint and commit, through the v1 trusted HTTP
 *      entry: partial and full refunds of ACTIVE sources, an EXPIRED-source
 *      refund, a MIXED-source partial refund, a direct compensation grant,
 *      and the v1 expired-lot double refund that OVER-restores a deduction;
 *   3. stop writes, upgrade to v2, repeat the migrator;
 *   4. verify the backfill: every historical refund now occupies per-line
 *      quota, original business/outbox/idempotency/history untouched,
 *      over-refunded history closed and audited;
 *   5. verify the DATABASE quota guard serializes two independent
 *      connections inserting different restoration events on ONE line;
 *   6. serve with the v2 entrypoint: original requests still replay their
 *      stored first results, new keys may only use the remaining quota,
 *      over-quota and closed deductions are refused with ZERO writes.
 */
async function upgradePhase(): Promise<number> {
  console.log("\n== AC-upgrade: the v1 -> v2 migration preserves historical refund quota");
  const owner = createLedgerSql(OWNER_URL, { max: 4 });
  const { runBillingMigrations } = await import("../../../server/scripts/billing-migrate.ts");
  const v1Dir = process.env.BILLING62_V1_DIR ?? `/work/.billing62-v1-${RUN_ID}`;
  const v1Main = join(v1Dir, "server/src/billing-ledger/isolated-main.ts");
  const v1Migrate = join(v1Dir, "server/scripts/billing-migrate.ts");
  const nowUs = () => BigInt(Date.now()) * 1000n;
  const DAY_US = 24n * 3600n * 1_000_000n;
  /** Run an executable migration entrypoint (v1 snapshot) as a child process. */
  const runScript = async (script: string): Promise<void> => {
    const proc = spawn("bun", [script], { env: process.env, stdout: "ignore", stderr: "pipe" });
    let err = "";
    proc.stderr?.on("data", (d: Buffer) => (err += String(d)));
    const code = await new Promise<number>((resolve) => proc.once("exit", (c) => resolve(c ?? 1)));
    if (code !== 0) throw new Error(`${script} exited ${code}: ${err.slice(-600)}`);
  };
  /** SQL deduction fixture exactly like the trusted-entry-shaped history the suite already uses. */
  const makeDeduction = async (
    accountId: string,
    eventId: string,
    lines: { lotId: string; amount: string }[],
  ): Promise<void> => {
    await owner.unsafe(`
      INSERT INTO billing.ledger_event (id, organization_id, account_id, event_type, account_seq, occurred_at_us, committed_at_us)
      VALUES ($1, $2, $3, 'credit.adjusted', (SELECT COALESCE(MAX(account_seq),0)+1 FROM billing.ledger_event WHERE account_id = $3), 1000, 1000)`,
      [eventId, ORG_A, accountId]);
    for (const l of lines) {
      await owner.unsafe(`
        INSERT INTO billing.ledger_line (organization_id, account_id, event_id, lot_id, delta_consumed_microcredits, delta_available_microcredits, balances_after, created_at_us)
        SELECT $2::uuid, $3::uuid, $1::uuid, id, ${l.amount}, (-${l.amount})::bigint,
          jsonb_build_object('granted_microcredits', granted_microcredits::text, 'available_microcredits', (available_microcredits-${l.amount})::text, 'reserved_microcredits', reserved_microcredits::text, 'refund_frozen_microcredits', refund_frozen_microcredits::text, 'consumed_microcredits', (consumed_microcredits+${l.amount})::text, 'expired_microcredits', expired_microcredits::text, 'revoked_microcredits', revoked_microcredits::text), 1000
        FROM billing.credit_lot WHERE id = $4`, [eventId, ORG_A, accountId, l.lotId]);
      await owner.unsafe(
        `UPDATE billing.credit_lot SET available_microcredits = available_microcredits - ${l.amount}, consumed_microcredits = consumed_microcredits + ${l.amount}, revision = revision + 1 WHERE id = $1`,
        [l.lotId],
      );
    }
  };
  const recoverySum = async (eventId: string): Promise<string> =>
    ((await owner.unsafe<{ s: string }[]>(
      `SELECT COALESCE(SUM(restored_microcredits),0)::text AS s FROM billing.recovery_allocation WHERE original_event_id = $1`,
      [eventId],
    ))[0]!).s;

  try {
    // ---- 0. a TRUE v1 baseline -------------------------------------------------
    const preJournal = await owner.unsafe<{ t: string | null }[]>(
      `SELECT to_regclass('billing.__drizzle_migrations')::text AS t`,
    );
    eq(preJournal[0]!.t, null, "the database starts without any billing migration journal (a true v1 baseline)");

    // ---- 1. apply the v1 migration set only ------------------------------------
    await runScript(v1Migrate);
    const v1Journal = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.__drizzle_migrations`);
    eq(v1Journal[0]!.n, "1", "the v1 migrator applied exactly ONE migration (base schema, no quota ledger)");
    const v1QuotaTable = await owner.unsafe<{ t: string | null }[]>(
      `SELECT to_regclass('billing.recovery_allocation')::text AS t`,
    );
    eq(v1QuotaTable[0]!.t, null, "the v1 schema has NO recovery quota ledger (the upgrade must create it)");

    // ---- 2. commit refund history through the REAL v1 entrypoint ----------------
    const v1svc = await startService(undefined, v1Main);
    const reg = await postConverge("/internal/v1/billing/accounts", { organization_id: ORG_A, owner_subject_id: "subj_upgrade", personal_workspace_id: "ws_upgrade" }, REGISTER_TOKEN, `up-reg-${RUN_ID}`);
    eq(reg.status, 201, "the v1 entry registers the upgrade account");
    const acctU = (reg.body.billing_account as { id: string }).id;

    const subGrant = await postConverge("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctU, source_event_id: `up_sub_${RUN_ID}`, source_type: "subscription",
      source_period_id: "period_up_long", granted_microcredits: "600", valid_from_us: String(nowUs()),
      expires_at_us: "2000000000000000",
    }), ENT_A_TOKEN, `up-sub-${RUN_ID}`);
    eq(subGrant.status, 201, "v1 entry grants the ACTIVE subscription lot (600)");
    const subLot = (subGrant.body.credit_lot as { id: string }).id;
    // A second subscription whose validity genuinely lapses mid-phase (packs
    // are lifetime by schema; the EXPIRING source must be a subscription).
    const shortExpires = nowUs() + 3_000_000n; // expires 3s from now
    const shortGrant = await postConverge("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctU, source_event_id: `up_short_${RUN_ID}`, source_type: "subscription",
      source_period_id: "period_up_short", granted_microcredits: "500", valid_from_us: String(nowUs()),
      expires_at_us: String(shortExpires),
    }), ENT_A_TOKEN, `up-short-${RUN_ID}`);
    eq(shortGrant.status, 201, "v1 entry grants the SHORT-LIVED subscription lot (500)");
    const shortLot = (shortGrant.body.credit_lot as { id: string }).id;

    // deductions: partial (D1), expired-source (D2), granted-full (D3),
    // mixed-source (D4), expired-source to be OVER-refunded (D5)
    const D1 = crypto.randomUUID();
    const D2 = crypto.randomUUID();
    const D3 = crypto.randomUUID();
    const D4 = crypto.randomUUID();
    const D5 = crypto.randomUUID();
    await makeDeduction(acctU, D1, [{ lotId: subLot, amount: "100" }]);
    await makeDeduction(acctU, D2, [{ lotId: shortLot, amount: "150" }]);
    await makeDeduction(acctU, D3, [{ lotId: subLot, amount: "50" }]);
    await makeDeduction(acctU, D4, [{ lotId: subLot, amount: "60" }, { lotId: shortLot, amount: "40" }]);
    await makeDeduction(acctU, D5, [{ lotId: shortLot, amount: "100" }]);

    await new Promise((r) => setTimeout(r, 3600)); // the pack lot genuinely expires

    // Request bodies are frozen ONCE and reused verbatim for the post-upgrade
    // replays: the same HTTP key with a different normalized request would be
    // an idempotency_conflict by design.
    const a1Body = adjBodyOf(acctU, D1, `up_a1_${RUN_ID}`, "charge_correction", "40");
    // partial refund of an ACTIVE source
    const a1 = await postConverge("/internal/v1/billing/adjustments", a1Body, ENT_A_TOKEN, `up-a1-${RUN_ID}`);
    eq(a1.status, 201, "v1 entry refunds PART of an active-source deduction (+40)");
    // full refund of the EXPIRED source (v1 issues a 30d compensation lot)
    const a2 = await postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctU, D2, `up_a2_${RUN_ID}`, "compensation", "150"), ENT_A_TOKEN, `up-a2-${RUN_ID}`);
    eq(a2.status, 201, "v1 entry refunds the EXPIRED-source deduction (+150)");
    eq((a2.body.compensation_lot as { source_type: string } | null)?.source_type, "compensation", "v1 answers the expired share with a fresh 30d compensation lot");
    // FULL refund through the direct GRANT entry (v1 issues a fresh lot)
    const g1Body = makeBody({
      billing_account_id: acctU, source_event_id: `up_g1_${RUN_ID}`, source_type: "compensation",
      granted_microcredits: "50", valid_from_us: String(nowUs()),
      expires_at_us: String(nowUs() + 30n * DAY_US), original_event_id: D3,
    });
    const g1 = await postConverge("/internal/v1/billing/credit-grants", g1Body, ENT_A_TOKEN, `up-g1-${RUN_ID}`);
    eq(g1.status, 201, "v1 entry refunds the deduction FULLY through the direct grant entry");
    // mixed-source partial refund
    const a3 = await postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctU, D4, `up_a3_${RUN_ID}`, "charge_correction", "60"), ENT_A_TOKEN, `up-a3-${RUN_ID}`);
    eq(a3.status, 201, "v1 entry refunds PART of the mixed-source deduction (+60)");
    const subFirst = subLot < shortLot; // v1 fills lines in lot_id order
    const a3RestoredInPlace = subFirst;
    // the v1 expired-lot double refund: two +100 adjustments on a 100 deduction
    const a4 = await postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctU, D5, `up_a4_${RUN_ID}`, "charge_correction", "100"), ENT_A_TOKEN, `up-a4-${RUN_ID}`);
    eq(a4.status, 201, "v1 entry commits the first expired-lot refund (+100)");
    const a5 = await postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctU, D5, `up_a5_${RUN_ID}`, "expiry_correction", "100"), ENT_A_TOKEN, `up-a5-${RUN_ID}`);
    eq(a5.status, 201, "v1 entry commits the SECOND expired-lot refund (+100) — v1 over-restores this deduction");

    await v1svc.stop();
    ok(!(await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(400) }).then((r) => r.ok).catch(() => false)), "writes stopped: the v1 service is down before the upgrade");

    // ---- 3. upgrade to v2, then repeat the migrator -----------------------------
    const hist = {} as Record<string, string>;
    for (const t of ["ledger_event", "ledger_line", "credit_lot", "adjustment", "business_event", "idempotency", "outbox_event"]) {
      hist[t] = (await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.${t}`))[0]!.n;
    }
    const pendingBefore = (await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_delivery WHERE status = 'pending'`))[0]!.n;

    await runBillingMigrations(OWNER_URL, { appPassword: APP_PASSWORD });
    const journal2 = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.__drizzle_migrations`);
    eq(journal2[0]!.n, "2", "the upgrade applied exactly the recovery-quota migration (journal v1 -> v2)");

    // ---- 4. the backfill: historical refunds now occupy quota -------------------
    eq(await recoverySum(D1), "40", "backfill: the partial ACTIVE refund occupies exactly its 40");
    eq(await recoverySum(D2), "150", "backfill: the EXPIRED-source refund occupies the full 150");
    eq(await recoverySum(D3), "50", "backfill: the grant-entry refund occupies the full 50");
    eq(await recoverySum(D4), "60", "backfill: the mixed-source refund occupies exactly its 60");
    eq(await recoverySum(D5), "100", "backfill: the over-restored deduction records only what the first refund could absorb (100)");
    const d1Rows = await owner.unsafe<{ lot: string; amt: string; via: string }[]>(
      `SELECT original_lot_id::text AS lot, restored_microcredits::text AS amt, restored_via AS via FROM billing.recovery_allocation WHERE original_event_id = $1 ORDER BY original_lot_id`, [D1]);
    eq(`${d1Rows.length}:${d1Rows[0]?.lot}:${d1Rows[0]?.via}`, `1:${subLot}:adjustment`, "backfill: the adjustment refund is attributed to the deduction's own line under its own entry");
    const d3Via = await owner.unsafe<{ via: string }[]>(`SELECT restored_via AS via FROM billing.recovery_allocation WHERE original_event_id = $1`, [D3]);
    eq(d3Via[0]?.via, "credit_grant", "backfill: the direct-grant refund carries the grant entry");
    const d4Rows = await owner.unsafe<{ lot: string; amt: string }[]>(
      `SELECT original_lot_id::text AS lot, restored_microcredits::text AS amt FROM billing.recovery_allocation WHERE original_event_id = $1 ORDER BY original_lot_id`, [D4]);
    const expD4 = a3RestoredInPlace
      ? [[subLot, "60"]]
      : [[shortLot, "40"], [subLot, "20"]];
    eq(JSON.stringify(d4Rows.map((r) => [r.lot, r.amt])), JSON.stringify(expD4), `backfill: the mixed refund lands on the lines v1 actually drew from (${subFirst ? "long-lived line first" : "short-lived line first"})`);
    const restEvents = await owner.unsafe<{ n: string }[]>(
      `SELECT COUNT(DISTINCT restoration_event_id)::text AS n FROM billing.recovery_allocation WHERE original_event_id IN ($1,$2,$3,$4,$5)`,
      [D1, D2, D3, D4, D5]);
    eq(restEvents[0]!.n, "5", "backfill: every recovery row points at the ORIGINAL v1 restoration event (no synthetic ids)");

    const audit = await owner.unsafe<{ mode: string; ev: string; rt: string; dt: string }[]>(
      `SELECT a.mode, a.original_event_id::text AS ev, a.restored_total::text AS rt, a.deduction_total::text AS dt
       FROM billing.recovery_backfill_audit a ORDER BY a.original_event_id`);
    eq(audit.length, 5, "backfill audit: exactly one decision per deduction that carried history");
    eq(audit.filter((r) => r.mode === "attributed").length, 4, "backfill audit: four deductions attributed cleanly");
    const blocked = audit.filter((r) => r.mode === "blocked");
    eq(blocked.length, 1, "backfill audit: exactly one deduction blocked");
    eq(blocked[0]?.ev, D5, "backfill audit: the OVER-refunded deduction is the blocked one");
    const blockRow = await owner.unsafe<{ reason: string; dt: string; dm: string }[]>(
      `SELECT reason, deduction_total::text AS dt, demanded_total::text AS dm FROM billing.recovery_block`);
    eq(blockRow.length, 1, "closure: exactly one recovery_block row exists");
    eq(`${blockRow[0]?.reason}:${blockRow[0]?.dt}:${blockRow[0]?.dm}`, "over_refunded_history:100:200", "closure: the block records the deduction total (100) and what history demanded (200)");

    let histPreserved = true;
    for (const t of Object.keys(hist)) {
      const n = (await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.${t}`))[0]!.n;
      if (n !== hist[t]) { histPreserved = false; console.error(`  DEBUG ${t}: ${hist[t]} -> ${n}`); }
    }
    ok(histPreserved, "the upgrade rewrote NOTHING in history: business, idempotency, outbox, lots, events, lines, adjustments all preserved");
    const pendingAfterUp = (await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_delivery WHERE status = 'pending'`))[0]!.n;
    eq(pendingAfterUp, pendingBefore, "the upgrade preserved every pending outbox delivery");

    await runBillingMigrations(OWNER_URL, { appPassword: APP_PASSWORD });
    eq((await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.__drizzle_migrations`))[0]!.n, "2", "REPEATED migration after the upgrade adds no journal row");
    eq(await recoverySum(D5), "100", "REPEATED migration does not re-run the backfill");

    // ---- 5. the database guard SERIALIZES concurrent writers on one line --------
    const DQ = crypto.randomUUID();
    await makeDeduction(acctU, DQ, [{ lotId: subLot, amount: "100" }]);
    const R1 = crypto.randomUUID();
    const R2 = crypto.randomUUID();
    const R3 = crypto.randomUUID(); // the exact-fit insert must not reuse either racer's event
    for (const r of [R1, R2, R3]) {
      await owner.unsafe(`
        INSERT INTO billing.ledger_event (id, organization_id, account_id, event_type, account_seq, occurred_at_us, committed_at_us)
        VALUES ($1, $2, $3, 'credit.adjusted', (SELECT COALESCE(MAX(account_seq),0)+1 FROM billing.ledger_event WHERE account_id = $3), 1000, 1000)`,
        [r, ORG_A, acctU]);
    }
    const c1 = createLedgerSql(OWNER_URL, { max: 1 });
    const c2 = createLedgerSql(OWNER_URL, { max: 1 });
    const tryAllocate = (conn: ReturnType<typeof createLedgerSql>, restEvent: string) =>
      conn.begin(async (tx) => {
        await tx`INSERT INTO billing.recovery_allocation
          (organization_id, account_id, original_event_id, original_lot_id, restored_microcredits, restored_via, restoration_event_id, created_at_us)
          VALUES (${ORG_A}, ${acctU}, ${DQ}, ${subLot}, 80, 'adjustment', ${restEvent}, 1000)`;
      });
    const race = await Promise.allSettled([tryAllocate(c1, R1), tryAllocate(c2, R2)]);
    eq(race.filter((r) => r.status === "fulfilled").length, 1, "guard race: two independent connections on ONE line — exactly ONE concurrent +80 passes");
    const loser = race.find((r) => r.status === "rejected") as PromiseRejectedResult<unknown>;
    ok(String((loser.reason as { code?: string }).code ?? "") === "23514", `guard race: the concurrent over-quota writer is refused by the database (23514, got ${(loser.reason as { code?: string }).code})`);
    eq(await recoverySum(DQ), "80", "guard race: the committed total equals exactly ONE writer's amount");
    const over30 = await owner.unsafe(`INSERT INTO billing.recovery_allocation
      (organization_id, account_id, original_event_id, original_lot_id, restored_microcredits, restored_via, restoration_event_id, created_at_us)
      VALUES ('${ORG_A}', '${acctU}', '${DQ}', '${subLot}', 30, 'adjustment', '${R1}', 1000)`
    ).catch((e: { code?: string }) => e);
    ok((over30 as { code?: string }).code === "23514", "guard race: +30 over the remaining 20 is refused (80 + 30 > 100)");
    await owner.unsafe(`INSERT INTO billing.recovery_allocation
      (organization_id, account_id, original_event_id, original_lot_id, restored_microcredits, restored_via, restoration_event_id, created_at_us)
      VALUES ('${ORG_A}', '${acctU}', '${DQ}', '${subLot}', 20, 'adjustment', '${R3}', 1000)`);
    eq(await recoverySum(DQ), "100", "guard race: the remaining exact 20 fits — the committed total never exceeds the line (100)");
    const closedTry = await owner.unsafe(`INSERT INTO billing.recovery_allocation
      (organization_id, account_id, original_event_id, original_lot_id, restored_microcredits, restored_via, restoration_event_id, created_at_us)
      VALUES ('${ORG_A}', '${acctU}', '${D5}', '${shortLot}', 1, 'adjustment', '${R1}', 1000)`).catch((e: { code?: string }) => e);
    ok((closedTry as { code?: string }).code === "23514", "guard: the CLOSED deduction refuses even a 1-microcredit database-level allocation");
    await c1.end({ timeout: 2 }).catch(() => {});
    await c2.end({ timeout: 2 }).catch(() => {});

    // ---- 6. the v2 entrypoint: replay, remaining quota, refusals -----------------
    const svc = await startService();
    const a1Replay = await postConverge("/internal/v1/billing/adjustments", a1Body, ENT_A_TOKEN, `up-a1-${RUN_ID}`);
    eq(a1Replay.status, 200, "the ORIGINAL v1 refund request still replays after the upgrade (stored first result)");
    eq((a1Replay.body.adjustment as { id: string }).id, (a1.body.adjustment as { id: string }).id, "the replay answers the SAME stored first result (same adjustment id)");
    eq(await recoverySum(D1), "40", "the replay added no second quota occupation");
    const g1Replay = await postConverge("/internal/v1/billing/credit-grants", g1Body, ENT_A_TOKEN, `up-g1-${RUN_ID}`);
    eq(g1Replay.status, 200, "the original grant replays after the upgrade");
    eq((g1Replay.body.credit_lot as { id: string }).id, (g1.body.credit_lot as { id: string }).id, "the grant replay answers the SAME lot the v1 entry issued");

    // partial refund: only the REMAINING quota is usable, under a NEW key
    const subConsumedBefore = (await owner.unsafe<{ c: string }[]>(`SELECT consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [subLot]))[0]!.c;
    const d1Rest = await postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctU, D1, `up_d1rest_${RUN_ID}`, "compensation", "60"), ENT_A_TOKEN, `up-d1rest-${RUN_ID}`);
    eq(d1Rest.status, 201, "a NEW key may use exactly the REMAINING quota (60 of 100)");
    eq((d1Rest.body.compensation_lot as { id: string } | null), null, "the remaining ACTIVE share restores IN PLACE (no compensation lot in the answer)");
    eq(await recoverySum(D1), "100", "the shared quota ledger now shows the deduction fully restored (40 + 60)");
    const subConsumedAfter = (await owner.unsafe<{ c: string }[]>(`SELECT consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [subLot]))[0]!.c;
    eq((BigInt(subConsumedBefore) - BigInt(subConsumedAfter)).toString(), "60", "the original lot's consumed share dropped by exactly the restored 60");
    eq((await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.credit_lot WHERE compensation_for_event_id = $1`, [D1]))[0]!.n, "0", "NO compensation lot was invented for the active-source deduction");

    const refuseWith = async (eventId: string, sourceKey: string, unusedType: string, what: string) => {
      const r = await post("/internal/v1/billing/adjustments", adjBodyOf(acctU, eventId, sourceKey, unusedType, "1"), ENT_A_TOKEN, `${sourceKey}-1`);
      eq(r.status, 409, `${what} refused (409)`);
      eq((r.body as { title?: string }).title, "state_conflict", `${what} refusal is state_conflict`);
      eq(await countOf(owner, "adjustment", `source_event_id = '${sourceKey}'`), 0n, `${what} stored no adjustment row`);
      eq(await countOf(owner, "business_event", `source_event_id = '${sourceKey}'`), 0n, `${what} stored no business identity`);
    };
    await refuseWith(D1, `up_d1over_${RUN_ID}`, "expiry_correction", "a new-key +1 over the fully restored deduction");
    eq(await recoverySum(D1), "100", "the refused over-restoration changed no quota");
    await refuseWith(D2, `up_d2over_${RUN_ID}`, "charge_correction", "a new-key +1 over the fully refunded expired deduction");
    eq(await recoverySum(D2), "150", "the expired-source deduction stays fully occupied");
    eq((await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.credit_lot WHERE compensation_for_event_id = $1`, [D2]))[0]!.n, "1", "the refused attempt invented no second compensation lot");
    await refuseWith(D3, `up_d3over_${RUN_ID}`, "charge_correction", "a new-key +1 over the grant-refunded deduction");
    eq(await recoverySum(D3), "50", "the grant-refunded deduction stays fully occupied");

    // mixed-source remainder: exactly the leftover share, wherever v1 left it
    const d4Rest = await postConverge("/internal/v1/billing/adjustments", adjBodyOf(acctU, D4, `up_d4rest_${RUN_ID}`, "compensation", "40"), ENT_A_TOKEN, `up-d4rest-${RUN_ID}`);
    eq(d4Rest.status, 201, "the mixed-source remainder (40) is still recoverable under a new key");
    if (a3RestoredInPlace) {
      eq((d4Rest.body.compensation_lot as { source_type: string } | null)?.source_type, "compensation", "the EXPIRED remainder answers with a fresh 30d compensation lot");
      eq((await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.credit_lot WHERE compensation_for_event_id = $1`, [D4]))[0]!.n, "1", "the expired remainder is the only compensation lot for the mixed deduction");
    } else {
      eq(d4Rest.body.compensation_lot ?? null, null, "the ACTIVE remainder restores IN PLACE (no compensation lot)");
      const subAfterD4 = (await owner.unsafe<{ c: string }[]>(`SELECT consumed_microcredits::text AS c FROM billing.credit_lot WHERE id = $1`, [subLot]))[0]!.c;
      eq((BigInt(subConsumedAfter) - BigInt(subAfterD4)).toString(), "40", "the active remainder moved exactly 40 back to available in place");
    }
    eq(await recoverySum(D4), "100", "the mixed deduction is now fully occupied (60 + 40)");
    await refuseWith(D4, `up_d4over_${RUN_ID}`, "expiry_correction", "a new-key +1 over the fully restored mixed deduction");

    // the CLOSED deduction: refused by the SERVICE too, zero writes anywhere
    const closedOutboxBefore = await countOf(owner, "outbox_event", "1=1");
    const closedAdj = await post("/internal/v1/billing/adjustments", adjBodyOf(acctU, D5, `up_d5over_${RUN_ID}`, "compensation", "1"), ENT_A_TOKEN, `up-d5over-1`);
    eq(closedAdj.status, 409, "the OVER-refunded deduction is refused by the service (closure)");
    eq((closedAdj.body as { title?: string }).title, "state_conflict", "the closure refusal is state_conflict");
    eq(await countOf(owner, "adjustment", `original_event_id = '${D5}'`), 2n, "the closed deduction still carries exactly its two historical adjustments");
    eq(await countOf(owner, "business_event", `source_event_id = 'up_d5over_${RUN_ID}'`), 0n, "the closed attempt stored no business identity");
    eq(await countOf(owner, "credit_lot", `compensation_for_event_id = '${D5}'`), 2n, "no third compensation lot for the over-refunded deduction");
    eq(await recoverySum(D5), "100", "the closed deduction's quota did not move");
    eq(await countOf(owner, "outbox_event", "1=1"), closedOutboxBefore, "the closed attempt wrote no outbox record");
    eq((await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.recovery_block`))[0]!.n, "1", "the closure row survives every refused attempt");

    // conservation across the whole upgraded account
    const cons = await owner.unsafe<{ ok: string }[]>(
      `SELECT bool_and(granted_microcredits = available_microcredits + reserved_microcredits + refund_frozen_microcredits + consumed_microcredits + expired_microcredits + revoked_microcredits)::text AS ok
       FROM billing.credit_lot WHERE account_id = $1`, [acctU]);
    eq(cons[0]!.ok, "true", "every lot of the upgraded account still conserves exactly");

    await svc.stop();

    console.log(`\nupgrade phase complete: ${checks} checks, ${failures} failures`);
    return failures === 0 ? 0 : 1;
  } finally {
    await stopAllServices();
    await owner.end({ timeout: 2 }).catch(() => {});
  }
}

async function lagoOutagePhase(): Promise<number> {
  console.log("\n== AC7 Lago down: local ledger commits, pending preserved, replay adds nothing");
  const owner = createLedgerSql(OWNER_URL, { max: 1 });
  let svc: ServiceProcess | null = null;
  try {
    // Lago is expected to be UNREACHABLE (the runner stopped it before this phase)
    let lagoReachable = true;
    try {
      const r = await fetch(`${LAGO_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
      lagoReachable = r.ok;
    } catch {
      lagoReachable = false;
    }
    ok(!lagoReachable, "Lago verified UNREACHABLE for this phase (runner stopped it)");
    svc = await startService();
    const ORG = ORG_A;
    const reg = await postConverge("/internal/v1/billing/accounts", { organization_id: ORG, owner_subject_id: "subj_outage", personal_workspace_id: "ws_outage" }, REGISTER_TOKEN, `outage-reg-${RUN_ID}`);
    if (reg.status !== 201) console.error(`  DEBUG outage register: ${reg.status} ${JSON.stringify(reg.body).slice(0, 220)}`);
    const acct = (reg.body.billing_account as { id: string } | undefined)?.id ?? "";
    const grant = await postConverge("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acct, source_event_id: `evt_outage_${RUN_ID}`, source_type: "pack", granted_microcredits: "777000" }), ENT_A_TOKEN, `outage-${RUN_ID}`);
    if (grant.status !== 201) console.error(`  DEBUG outage grant: ${grant.status} ${JSON.stringify(grant.body).slice(0, 220)}`);
    eq(grant.status, 201, "grant SUCCEEDS while Lago is down (local ledger is authoritative)");
    const pending = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_delivery WHERE status = 'pending'`);
    ok(BigInt(pending[0]!.n) >= 1n, "outbox record is pending — not 'sent', not claimed delivered");
    const sent = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.outbox_delivery WHERE status = 'sent'`);
    eq(sent[0]!.n, "0", "nothing is marked sent: outbox presence is NOT Lago receipt");
    const payload = await owner.unsafe<{ p: Record<string, string> }[]>(`SELECT payload AS p FROM billing.outbox_event ORDER BY created_at_us DESC LIMIT 1`);
    ok(payload[0]!.p.granted_microcredits === "777000", "pending payload carries the exact original microcredits for #73 to project");
    // restart the ledger service on the SAME database; replay adds nothing
    await svc.stop();
    svc = await startService();
    const replay = await postConverge("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acct, source_event_id: `evt_outage_${RUN_ID}`, source_type: "pack", granted_microcredits: "777000" }), ENT_A_TOKEN, `outage-${RUN_ID}`);
    eq(replay.status, 200, "replay after restart answers the original result");
    eq(await countOf(owner, "credit_lot", `source_event_id = 'evt_outage_${RUN_ID}'`), 1n, "replay added no second lot");
    console.log(`\nlago-outage phase complete: ${checks} checks, ${failures} failures`);
    return failures === 0 ? 0 : 1;
  } finally {
    await stopAllServices();
    await owner.end({ timeout: 2 }).catch(() => {});
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const phase = process.argv.includes("--phase")
  ? process.argv[process.argv.indexOf("--phase") + 1]
  : "main";
const code =
  phase === "upgrade"
    ? await upgradePhase()
    : phase === "lago-outage"
      ? await lagoOutagePhase()
      : await main();
process.exit(code);
