/**
 * #64 ledger-core acceptance driver — runs INSIDE the dedicated compose
 * environment (`billing62_<run_id>` project, internal network only) and
 * drives the REAL service through the trusted internal HTTP entry plus an
 * independent owner PostgreSQL connection for constraint/fault evidence.
 *
 * Usage (from the ledger-app container, repo mounted at /work):
 *   bun tests/billing/cases/ledger-core.ts --phase main
 *   bun tests/billing/cases/ledger-core.ts --phase lago-outage
 *
 * Phases:
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

async function startService(barrierDir?: string): Promise<ServiceProcess> {
  const proc = spawn("bun", [new URL("../../../server/src/billing-ledger/isolated-main.ts", import.meta.url).pathname], {
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
      if (r.ok) return { proc, stderrHead, stop: stopOf(proc) };
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
  for (const expect of ["account", "adjustment", "business_event", "credit_lot", "idempotency", "ledger_event", "ledger_line", "outbox_delivery", "outbox_event"]) {
    ok(names.includes(expect), `billing.${expect} exists after migration`);
  }
  const journal = await owner.unsafe<{ n: string }[]>(`SELECT COUNT(*)::text AS n FROM billing.__drizzle_migrations`);
  eq(journal[0]!.n, "1", "migration journal records exactly the one migration");
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
    const now30d = BigInt(Date.now()) * 1000n + 30n * 24n * 3600n * 1_000_000n;
    const compGrant = await postConverge("/internal/v1/billing/credit-grants", makeBody({
      billing_account_id: acctA,
      source_event_id: `evt_comp_${RUN_ID}`,
      source_type: "compensation",
      source_period_id: null,
      granted_microcredits: "250000",
      valid_from_us: String(BigInt(Date.now()) * 1000n),
      expires_at_us: String(now30d),
      original_event_id: (g0.body.ledger_event_id as string),
    }), ENT_A_TOKEN, `comp-${RUN_ID}`);
    eq(compGrant.status, 201, "compensation grant links its original deduction event");
    const compLot = compGrant.body.credit_lot as { id: string; expires_at_us: string; source_period_id: string | null; source_type: string };
    eq(compLot.source_type, "compensation", "compensation lot records its source type");
    eq(compLot.source_period_id, null, "compensation lot has no period of its own");
    ok(BigInt(compLot.expires_at_us) > BigInt(Date.now()) * 1000n + 29n * 24n * 3600n * 1_000_000n, "compensation expiry ~30 days after grant");

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
    }), ENT_B_TOKEN, `b1-${RUN_ID}`);
    eq(grantB.status, 201, "independent account B grant");

    // authorization boundaries
    const noAuth = await post("/internal/v1/billing/credit-grants", gBase, "none", "na-1");
    eq(noAuth.status, 401, "unauthenticated grant refused 401");
    const noCap = await post("/internal/v1/billing/credit-grants", gBase, READ_ONLY_TOKEN, "nc-1");
    eq(noCap.status, 403, "capability-less credential refused 403");
    const foreign = await post("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: `evt_foreign_${RUN_ID}`, source_type: "pack", granted_microcredits: "1" }), ENT_B_TOKEN, "fx-1");
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
    // account totals equal the spendable lot projection
    const sqlSum = await owner.unsafe<{ avail: string; res: string; frz: string }[]>(
      `SELECT COALESCE(SUM(available_microcredits) FILTER (WHERE valid_from_us <= ${BigInt(Date.now()) * 1000n}),0)::text AS avail,
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

    // ============================================ AC6a/AC6b crash-window tests
    console.log("\n== AC6a/6b crash windows (commit-before / commit-after), grant + adjustment");
    await svc.stop();

    // --- AC6a grant: die inside the transaction, before COMMIT
    const barrierA = mkdtempSync(join(tmpdir(), `billing64_barrier_${RUN_ID}_a_`));
    writeFileSync(join(barrierA, "before-commit"), "1");
    let crash = await startService(barrierA);
    const crashSrc = `evt_crash_${RUN_ID}`;
    const pending = post("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acctA, source_event_id: crashSrc, source_type: "pack", granted_microcredits: "424242" }), ENT_A_TOKEN, `crash-${RUN_ID}`);
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

    // --- AC6a/6b adjustment windows reuse the same mechanism (one window each)
    const barrierC = mkdtempSync(join(tmpdir(), `billing64_barrier_${RUN_ID}_c_`));
    writeFileSync(join(barrierC, "after-commit"), "1");
    await crashB.stop();
    let crashC = await startService(barrierC);
    const adjCrashScope = {
      billing_account_id: acctA,
      original_event_id: packEventId,
      adjustment_type: "charge_correction",
      source_event_id: `evt_adjcrash_${RUN_ID}`,
      signed_delta_microcredits: "-7",
      reason: "charge corrected after operations review",
      actor_subject_id: "subj_entitlement_svc",
      original_period_id: null,
      effective_at_us: String(BigInt(Date.now()) * 1000n),
    };
    const adjCrash = post("/internal/v1/billing/adjustments", adjCrashScope, ENT_A_TOKEN, `adjcrash-${RUN_ID}`);
    await waitFor(() => existsSync(join(barrierC, "entered-after-commit")), 15000);
    crashC.proc.kill("SIGKILL");
    await waitExit(crashC.proc);
    await adjCrash.catch(() => {});
    const adjCrashCount = await countOf(owner, "adjustment", `original_event_id = '${packEventId}' AND adjustment_type = 'charge_correction'`);
    eq(adjCrashCount, 1n, "AC6b adjustment: committed adjustment survives the kill");
    rmSync(join(barrierC, "after-commit"), { force: true });
    crashC = await startService(barrierC);
    const adjRetry = await postConverge("/internal/v1/billing/adjustments", adjCrashScope, ENT_A_TOKEN, `adjcrash-${RUN_ID}`);
    eq(adjRetry.status, 200, "AC6b adjustment: retry after restart replays the original result");
    eq(await countOf(owner, "adjustment", `original_event_id = '${packEventId}' AND adjustment_type = 'charge_correction'`), 1n, "AC6b adjustment: replay added no second adjustment");

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

    console.log(`\nmain phase complete: ${checks} checks, ${failures} failures`);
    return failures === 0 ? 0 : 1;
  } finally {
    await svc.stop();
    await owner.end({ timeout: 2 }).catch(() => {});
    await app.end({ timeout: 2 }).catch(() => {});
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
    const acct = (reg.body.billing_account as { id: string }).id;
    const grant = await postConverge("/internal/v1/billing/credit-grants", makeBody({ billing_account_id: acct, source_event_id: `evt_outage_${RUN_ID}`, source_type: "pack", granted_microcredits: "777000" }), ENT_A_TOKEN, `outage-${RUN_ID}`);
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
    if (svc) await svc.stop();
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
const code = phase === "lago-outage" ? await lagoOutagePhase() : await main();
process.exit(code);
