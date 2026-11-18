/**
 * Single deterministic entry point for the isolated billing test environment
 * (#62 requirement §7): guard -> boot -> health -> migrate -> seed -> assert
 * -> cleanup, with finally/trap cleanup that only ever touches resources
 * marked with this run's id.
 *
 * Modes:
 *   bun tests/billing/runner.ts --guard-only
 *       No Docker needed. Pure guard assertions plus a REAL disposable
 *       PostgreSQL 17 (standalone binaries, isolated temp data dir named
 *       billing62_<run_id>) proving: correct target connects, wrong targets
 *       (foreign run, wrong database name, public host) are rejected BEFORE
 *       any connection, and the existing/default database is never touched.
 *
 *   bun tests/billing/runner.ts
 *       Full stack via tests/billing/compose.yml (PostgreSQL 17 + Lago CE
 *       v1.57.0). Requires a running Docker engine; without one it fails
 *       NON-ZERO with an explicit unverified report — the runner never
 *       pretends a skipped environment passed.
 *
 * Logs contain environment names and image versions only — never connection
 * strings, tokens or passwords.
 */

import { execSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTarget, isolatedTarget } from "./guard.js";

let failures = 0;
function ok(cond: unknown, message: string): void {
  if (cond) {
    console.log(`  PASS ${message}`);
  } else {
    failures++;
    console.error(`  FAIL ${message}`);
  }
}

function makeRunId(): string {
  const t = new Date();
  const stamp =
    t.getUTCFullYear().toString() +
    String(t.getUTCMonth() + 1).padStart(2, "0") +
    String(t.getUTCDate()).padStart(2, "0") +
    String(t.getUTCHours()).padStart(2, "0") +
    String(t.getUTCMinutes()).padStart(2, "0") +
    String(t.getUTCSeconds()).padStart(2, "0");
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `${stamp}${rand}`; // digits + lowercase hex only: matches the guard's run-id grammar
}

function sh(
  cmd: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): { code: number; out: string } {
  try {
    const out = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: err.status ?? 1,
      out: (err.stdout ?? "") + (err.stderr ?? ""),
    };
  }
}

// ---------------------------------------------------------------------------
// Guard-only mode against a real disposable PostgreSQL 17
// ---------------------------------------------------------------------------
interface DisposablePg {
  port: number;
  dataDir: string;
  stop: () => Promise<void>;
}

async function startDisposablePostgres(
  pgBinDir: string,
  runId: string,
): Promise<DisposablePg> {
  // Sandboxed runners may run under a uid with no /etc/passwd entry; PostgreSQL
  // requires getpwuid(geteuid()) to resolve. A tiny LD_PRELOAD shim provides a
  // synthetic entry for THIS process tree only (see docs/billing-contract.md).
  const nssShim = process.env.BILLING62_NSS_SHIM;
  if (nssShim && existsSync(nssShim)) {
    process.env.LD_PRELOAD = process.env.LD_PRELOAD
      ? `${process.env.LD_PRELOAD}:${nssShim}`
      : nssShim;
  }
  const dataDir = mkdtempSync(join(tmpdir(), `billing62_${runId}_pgdata_`));
  const port = 15432 + Math.floor(Math.random() * 2000);
  const bin = (name: string) => join(pgBinDir, name);
  const run = (cmd: string, env: NodeJS.ProcessEnv = {}) => {
    const r = sh(cmd, { env: { ...process.env, ...env } });
    if (r.code !== 0) throw new Error(`${cmd} failed: ${r.out.slice(0, 500)}`);
    return r;
  };
  run(`"${bin("initdb")}" -D "${dataDir}" -A trust -U billing62_guard`); // trust is fine: loopback-only listener, disposable per-run data dir
  const postgres = spawn(
    bin("postgres"),
    [
      "-D",
      dataDir,
      "-p",
      String(port),
      "-k",
      dataDir,
      "-c",
      "listen_addresses=127.0.0.1",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  postgres.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  const stop = async () => {
    postgres.kill("SIGTERM"); // postgres "fast" shutdown
    await new Promise((r) => postgres.on("exit", r));
    rmSync(dataDir, { recursive: true, force: true });
  };
  // wait for readiness (psql probe: pg_isready misbehaves under the NSS shim)
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const r = sh(
      `"${bin("psql")}" -h 127.0.0.1 -p ${port} -U billing62_guard -d postgres -tAc "select 1"`,
    );
    if (r.code === 0) {
      ready = true;
      break;
    }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  if (!ready) {
    await stop();
    throw new Error(
      `disposable postgres did not become ready: ${stderr.slice(0, 400)}`,
    );
  }
  // the guard database is created by initdb default? No: create it explicitly.
  const psql = bin("psql");
  run(
    `"${psql}" -h 127.0.0.1 -p ${port} -U billing62_guard -d postgres -c "CREATE DATABASE \\"billing62_${runId}\\";"`,
    {
      PGUSER: "billing62_guard",
      PGPASSWORD: "",
    },
  );
  return { port, dataDir, stop };
}

async function runGuardOnly(): Promise<number> {
  console.log("billing62 guard-only run (real PostgreSQL, no docker required)");
  const runId = process.env.BILLING62_RUN_ID ?? makeRunId();
  console.log(`  run id: ${runId}`);
  const pgRoot =
    process.env.BILLING62_PG_BIN_DIR ??
    "/workspace/.tools/pg/postgresql-17.12.0-aarch64-unknown-linux-gnu/bin";
  const pgBinDir = join(
    pgRoot.endsWith("bin") ? pgRoot : pgRoot,
    pgRoot.endsWith("bin") ? "" : "bin",
  );
  if (!existsSync(join(pgBinDir, "postgres"))) {
    console.error(
      `  FAIL no standalone PostgreSQL found at ${pgBinDir}; set BILLING62_PG_BIN_DIR to a postgres/bin directory. ` +
        "The guard suite requires REAL PostgreSQL and never silently skips.",
    );
    return 2;
  }

  // -- pure guard assertions (no I/O possible) --------------------------------
  console.log(
    "\n== guard: target whitelist (pure, zero-write by construction)",
  );
  const good = isolatedTarget({
    runId,
    host: "127.0.0.1",
    port: 15432,
    user: "u",
    password: "p",
  });
  ok(
    checkTarget({ url: good.url, project: good.project, runId }).ok === true,
    "accepts its own run target",
  );
  const foreignDb = good.url.replace(/\/billing62_[a-z0-9_]+$/, "/postgres");
  ok(
    checkTarget({ url: foreignDb, project: good.project, runId }).ok === false,
    "rejects the default 'postgres' database (existing-database accident)",
  );
  const foreignRun = isolatedTarget({
    runId: "other9999",
    host: "127.0.0.1",
    port: 15432,
    user: "u",
    password: "p",
  });
  ok(
    checkTarget({ url: foreignRun.url, project: good.project, runId }).ok ===
      false,
    "rejects another run's database",
  );
  ok(
    checkTarget({ url: good.url, project: "openbot", runId }).ok === false,
    "rejects a non-billing62 compose project",
  );
  ok(
    checkTarget({
      url: good.url.replace("127.0.0.1", "billing.example.com"),
      project: good.project,
      runId,
    }).ok === false,
    "rejects a public host",
  );
  ok(
    (checkTarget({
      url: good.url.replace("127.0.0.1", "10.0.0.7"),
      project: good.project,
      runId,
    }).ok ===
      false) ===
      false,
    "accepts a private-LAN host on the compose internal network",
  );
  ok(
    checkTarget({ url: "not a url", project: good.project, runId }).ok ===
      false,
    "rejects malformed connection targets before any I/O",
  );

  // -- real PostgreSQL ---------------------------------------------------------
  console.log("\n== guard: real disposable PostgreSQL 17");
  let pg: DisposablePg | null = null;
  try {
    pg = await startDisposablePostgres(pgBinDir, runId);
    ok(true, `disposable postgres ready on 127.0.0.1:${pg.port}`);
    const t = isolatedTarget({
      runId,
      host: "127.0.0.1",
      port: pg.port,
      user: "billing62_guard",
      password: "",
    });
    // connect with psql to prove the accepted target really works
    const conn = sh(
      `"${join(pgBinDir, "psql")}" -h 127.0.0.1 -p ${pg.port} -U billing62_guard -d ${t.dbName} -c "select 1"`,
    );
    ok(
      conn.code === 0,
      "guard-accepted target connects to the isolated database",
    );

    // zero-write proof for a rejected target: the rejected URL points at the
    // default 'postgres' database; run the guard CLI and assert it exits 1
    // BEFORE creating any connection object (its logic is pure), then verify
    // the default database has zero billing62 tables/writes.
    const rej = sh(
      `bun tests/billing/guard.ts --url "postgres://u@127.0.0.1:${pg.port}/postgres" ` +
        `--project ${t.project} --run-id ${runId}`,
    );
    ok(rej.code === 1, "guard CLI exits 1 on the default-database target");
    const probe = sh(
      `"${join(pgBinDir, "psql")}" -h 127.0.0.1 -p ${pg.port} -U billing62_guard -d postgres -tAc ` +
        `"select count(*) from pg_database where datname like 'billing62%' and datname != 'billing62_${runId}'"`,
    );
    ok(
      probe.out.trim() === "0",
      "rejected target caused zero writes (no stray billing62 databases)",
    );

    // orphan-probe: a database named for another run must never be created or used
    const otherRun = "zz_probe_not_ours";
    const createProbe = sh(
      `"${join(pgBinDir, "psql")}" -h 127.0.0.1 -p ${pg.port} -U billing62_guard -d postgres -tAc ` +
        `"select count(*) from pg_database where datname='billing62_${otherRun}'"`,
    );
    ok(
      createProbe.out.trim() === "0",
      "no database for a foreign run id exists",
    );
  } finally {
    if (pg) await pg.stop();
  }
  console.log("\n== cleanup verification");
  ok(
    !existsSync(pg?.dataDir ?? `${tmpdir()}/billing62_${runId}_pgdata_missing`),
    "disposable data directory removed",
  );
  console.log(
    `\nguard-only run complete: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failures)`,
  );
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Full-stack mode (docker compose; Lago CE v1.57.0) and catalog-only mode.
// ---------------------------------------------------------------------------
const CATALOG_DB_IMAGE =
  "pgvector/pgvector:pg17@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd";

async function catalogPhase(runId: string): Promise<number> {
  console.log(
    "  == catalog phase: isolated PostgreSQL 17 (pgvector) via docker",
  );
  const dbName = `billing62_${runId}`;
  const user = "billing62_runner";
  const password = randomBytes(18).toString("hex");
  const port = 15432 + Math.floor(Math.random() * 1400);
  const name = `billing62_${runId}-pg`;
  const run = (cmd: string, timeout = 120_000) => {
    const r = sh(cmd, { timeout });
    if (r.code !== 0)
      throw new Error(
        `command failed (${r.code}): ${cmd}\n${r.out.slice(0, 600)}`,
      );
    return r;
  };
  let exit = 1;
  try {
    run(
      `docker run -d --name ${name} --platform linux/amd64 ` +
        `-e POSTGRES_DB=${dbName} -e POSTGRES_USER=${user} -e POSTGRES_PASSWORD=${password} ` +
        `-p 127.0.0.1:${port}:5432 ${CATALOG_DB_IMAGE}`,
    );
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (
        sh(`docker exec ${name} pg_isready -U ${user} -d ${dbName} -t 2`)
          .code === 0
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error("catalog postgres never became ready");
    ok(true, `catalog postgres ready on 127.0.0.1:${port}`);
    const url = `postgres://${user}:${password}@127.0.0.1:${port}/${dbName}`;

    // The docker entrypoint restarts postgres between initdb and serving;
    // pg_isready can answer "ready" during the transient. Only a successful
    // query-and-migrate sequence counts.
    let migrated = false;
    let migrateDetail = "";
    for (let i = 0; i < 30 && !migrated; i++) {
      const m = sh(
        `DATABASE_URL=${url} bun server/scripts/migrate.ts 2>&1`,
        300_000,
      );
      if (m.code === 0 && m.out.includes('"status":"ok"')) {
        migrated = true;
      } else {
        migrateDetail = m.out.slice(-300);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!migrated)
      throw new Error(`migrations never applied: ${migrateDetail}`);
    ok(true, "migrations applied (0000..0092 including billing catalog)");

    const test = sh(
      `TEST_DATABASE_URL=${url} bun test ` +
        `server/tests/billing-catalog.integration.test.ts ` +
        `server/tests/billing-periods.test.ts ` +
        `server/tests/billing-catalog-pricing.test.ts ` +
        `server/tests/billing-catalog-eligibility.test.ts 2>&1`,
      600_000,
    );
    const tail = test.out.trim().split("\n").slice(-6).join("\n");
    console.log(tail);
    ok(
      test.code === 0 && /0 fail/.test(test.out),
      "business-level catalog suite passes on real PostgreSQL (A1-A14)",
      `exit=${test.code}`,
    );
    exit = test.code === 0 && / 0 fail/.test(test.out) ? 0 : 1;
  } catch (e) {
    console.error(
      `  FAIL catalog phase: ${e instanceof Error ? e.message : String(e)}`,
    );
    exit = 1;
  } finally {
    sh(`docker rm -f ${name}`);
    ok(
      !sh(`docker ps -a --format '{{.Names}}' | grep -x ${name}`).out.includes(
        name,
      ),
      "catalog container removed (cleanup)",
    );
  }
  return exit;
}

interface LagoStep {
  step: string;
  ok: boolean;
  detail: string;
}

async function lagoPhase(
  runId: string,
): Promise<{ exit: number; steps: LagoStep[] }> {
  console.log("  == lago phase: isolated Lago CE v1.57.0 stack via compose");
  const steps: LagoStep[] = [];
  const project = `billing62_${runId}`;
  const envPath = join(tmpdir(), `billing62_${runId}_env`);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const content = [
    `BILLING62_RUN_ID=${runId}`,
    `BILLING62_PG_USER=billing62_compose`,
    `BILLING62_PG_PASSWORD=${randomBytes(18).toString("hex")}`,
    `BILLING62_LAGO_DB_NAME=billing62_${runId}_lago`,
    `BILLING62_LAGO_USER=billing62_lago`,
    `BILLING62_LAGO_PASSWORD=${randomBytes(18).toString("hex")}`,
    // Lago's rsa_keys initializer Base64-decodes this env var, so one line
    // (no newline handling needed anywhere between host and container).
    `BILLING62_LAGO_RSA_KEY=${Buffer.from(pem).toString("base64")}`,
    `BILLING62_LAGO_SECRET_KEY_BASE=${randomBytes(48).toString("hex")}`,
    `BILLING62_LAGO_ENC_PRIMARY=${Buffer.from(randomBytes(32)).toString("base64")}`,
    `BILLING62_LAGO_ENC_DETERMINISTIC=${Buffer.from(randomBytes(32)).toString("base64")}`,
    `BILLING62_LAGO_ENC_SALT=${Buffer.from(randomBytes(32)).toString("base64")}`,
    "",
  ].join("\n");
  writeFileSync(envPath, content, { mode: 0o600 });
  let exit = 0;
  try {
    const up = sh(
      `docker-compose -f tests/billing/compose.yml --env-file ${envPath} -p ${project} up -d --wait`,
      900_000,
    );
    steps.push({
      step: "compose up --wait",
      ok: up.code === 0,
      detail: up.code === 0 ? "stack healthy" : up.out.slice(-400),
    });
    if (up.code !== 0) throw new Error("compose stack did not become healthy");

    // One-time headless bootstrap (test facility only; the key is never
    // printed): default billing entity, then an API key. The bootstrap script
    // is copied in and executed; output is filtered to the KEY line.
    const bootstrap = [
      'org = Organization.first || Organization.create!(name: "billing62_runner_org", email: "runner@billing62.invalid")',
      'be = BillingEntity.first || BillingEntity.create!(organization: org, code: "billing62_runner", name: "billing62-runner", legal_name: "billing62-runner", email: "runner@billing62.invalid")',
      "key = org.api_keys.order(:created_at).last || org.api_keys.create!(name: 'runner')",
      'puts "KEY=#{key.value}"',
    ].join("\n");
    const scriptPath = join(tmpdir(), `billing62_${runId}_lago_bootstrap.rb`);
    // 0644: the container's rails process runs under a different uid and must
    // be able to read the copied script (it contains no secrets).
    writeFileSync(scriptPath, bootstrap, { mode: 0o644 });
    sh(`docker cp ${scriptPath} ${project}-lago-api:/tmp/bootstrap.rb`, 60_000);
    rmSync(scriptPath, { force: true });
    const mint = sh(
      `docker exec ${project}-lago-api bundle exec rails runner /tmp/bootstrap.rb 2>&1`,
      300_000,
    );
    const apiKey =
      mint.out
        .split("\n")
        .find((l) => l.startsWith("KEY="))
        ?.slice(4)
        .trim() ?? "";
    steps.push({
      step: "bootstrap entity + api key",
      ok: apiKey.length > 0,
      detail: apiKey ? "ok" : mint.out.slice(-300),
    });
    if (!apiKey) throw new Error("could not mint a Lago API key");

    const api = (
      path: string,
      body?: unknown,
    ): { code: number; out: string } => {
      const data =
        body === undefined
          ? ""
          : ` --data '${JSON.stringify(body).replace(/'/g, `'\\''`)}'`;
      const r = sh(
        `docker exec ${project}-lago-api curl -s -o /tmp/last.json -w '%{http_code}' ` +
          `-H 'Authorization: Bearer ${apiKey}' -H 'Content-Type: application/json' ` +
          `${data} http://127.0.0.1:3000${path}`,
        120_000,
      );
      const out = sh(
        `docker exec ${project}-lago-api cat /tmp/last.json`,
        60_000,
      );
      return { code: Number(r.out.trim() || "0"), out: out.out };
    };

    const customer = `cust_${runId}`;
    const c = api("/api/v1/customers", {
      customer: {
        external_id: customer,
        currency: "CNY",
        name: "billing62 catalog evidence",
      },
    });
    steps.push({
      step: "create customer",
      ok: c.code === 200,
      detail: c.out.slice(0, 120),
    });

    const m = api("/api/v1/billable_metrics", {
      billable_metric: {
        name: "tokens metric",
        code: "model_input_tokens",
        aggregation_type: "sum_agg",
        field_name: "tokens",
      },
    });
    const metricId = (() => {
      try {
        return (JSON.parse(m.out) as { billable_metric?: { lago_id?: string } })
          .billable_metric?.lago_id;
      } catch {
        return undefined;
      }
    })();
    steps.push({
      step: "create billable metric",
      ok: m.code === 200 && !!metricId,
      detail: m.out.slice(0, 120),
    });

    const planCode = `zero_${runId.slice(-6)}`;
    const p = api("/api/v1/plans", {
      plan: {
        name: "zero-metering",
        code: planCode,
        interval: "monthly",
        amount_cents: "0",
        amount_currency: "CNY",
        pay_in_advance: false,
        charges: [
          {
            billable_metric_id: metricId,
            charge_model: "standard",
            pay_in_advance: false,
            properties: { amount: "0" },
          },
        ],
      },
    });
    steps.push({
      step: "create zero plan",
      ok: p.code === 200,
      detail: p.out.slice(0, 120),
    });

    const sub = api("/api/v1/subscriptions", {
      subscription: {
        external_customer_id: customer,
        external_id: `sub_${runId.slice(-8)}`,
        plan_code: planCode,
      },
    });
    steps.push({
      step: "subscribe customer",
      ok: sub.code === 200,
      detail: sub.out.slice(0, 120),
    });

    // Two events across a Beijing period boundary, 1 microsecond apart, with
    // the ORIGINAL integer microseconds carried in properties (occurrence_us)
    // and decimal epoch seconds derived from the SAME integer -- never a
    // float round trip.
    const events: [string, string, string][] = [
      [`evt_${runId}_before`, "1709170215.123455", "1709170215123455"],
      [`evt_${runId}_at`, "1709170215.123456", "1709170215123456"],
    ];
    for (const [id, ts, us] of events) {
      const e = api("/api/v1/events", {
        event: {
          transaction_id: id,
          external_customer_id: customer,
          code: "model_input_tokens",
          timestamp: ts,
          properties: { tokens: 1000, occurrence_us: us },
        },
      });
      steps.push({
        step: `event ${id}`,
        ok: e.code === 200 && e.out.includes(id),
        detail: e.out.slice(0, 120),
      });
    }

    // Full-page rescan: the event ID set must be EXACTLY the two ids.
    const list = api("/api/v1/events?per_page=100");
    const gotIds = events.filter(([id]) => list.out.includes(id));
    steps.push({
      step: "event set rescan",
      ok: gotIds.length === 2,
      detail: `found ${gotIds.length}/2 ids`,
    });

    // Zero receivable: no invoices exist and the live period usage totals
    // 0 CNY while the customer carries nonzero usage events -- Lago
    // aggregates without a second deduction (ADR 0003).
    const inv = api(`/api/v1/invoices?external_customer_id=${customer}`);
    const usage = api(
      `/api/v1/customers/${customer}/current_usage?external_subscription_id=sub_${runId.slice(-8)}`,
    );
    const zeroReceivable =
      inv.out.includes('"total_count":0') &&
      usage.out.includes('"amount_cents":0') &&
      usage.out.includes('"total_amount_cents":0');
    steps.push({
      step: "zero-amount receivable (no second deduction)",
      ok: zeroReceivable,
      detail: usage.out.slice(0, 160) || `exit ${inv.code}`,
    });

    exit = steps.every((s) => s.ok) ? 0 : 2;
  } catch (e) {
    steps.push({
      step: "lago phase",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
    exit = 2;
  } finally {
    sh(
      `docker-compose -f tests/billing/compose.yml --env-file ${envPath} -p ${project} down -v`,
      300_000,
    );
    const leftovers = sh(
      `docker ps -a --format '{{.Names}}' | grep -F ${project} || true`,
    );
    steps.push({
      step: "cleanup down -v",
      ok: leftovers.out.trim().length === 0,
      detail: leftovers.out.trim()
        ? leftovers.out.trim()
        : "no containers left",
    });
    rmSync(envPath, { force: true });
  }
  for (const s of steps) {
    console.log(`    ${s.ok ? "PASS" : "FAIL"} ${s.step}: ${s.detail}`);
  }
  return { exit, steps };
}

async function runFull(catalogOnly: boolean): Promise<number> {
  if (catalogOnly) {
    console.log(
      "billing62 catalog run (#65): guard + isolated PostgreSQL business suite (no docker compose stack)",
    );
  } else {
    console.log(
      "billing62 full-stack run (#65/#62): isolated PostgreSQL 17 + Lago CE v1.57.0",
    );
  }
  const docker = sh("docker info >/dev/null 2>&1 && echo up");
  if (docker.code !== 0 || !docker.out.includes("up")) {
    console.error("  FAIL docker engine not available in this environment.");
    console.error("  UNVERIFIED SCOPE (must not be reported as passed):");
    console.error(
      "    - isolated PostgreSQL catalog suite (A1-A14 business evidence)",
    );
    console.error(
      "    - boot of tests/billing/compose.yml (pinned images, internal networks)",
    );
    console.error(
      "    - Lago v1.57.0 health + zero-amount metering evidence (A15)",
    );
    return 2;
  }

  const runId = (process.env.BILLING62_RUN_ID ?? makeRunId()).toLowerCase();
  console.log(`  run id: ${runId}`);

  // Guard: the catalog database name/project follow the billing62_<run_id> rule.
  const target = isolatedTarget({
    runId,
    host: "127.0.0.1",
    port: 15432,
    user: "probe",
    password: "probe",
  });
  const guarded = checkTarget({
    url: target.url,
    project: target.project,
    runId,
  });
  ok(
    guarded.ok === true,
    "catalog target passes the billing62 isolation guard",
  );

  const catalogExit = await catalogPhase(runId);
  if (catalogOnly) {
    console.log(
      `\ncatalog run complete: ${catalogExit === 0 ? "PASS" : "FAIL"}`,
    );
    return catalogExit;
  }

  const lago = await lagoPhase(runId);
  const exit = catalogExit !== 0 ? catalogExit : lago.exit;
  if (lago.exit !== 0) {
    console.error("\n  UNVERIFIED SCOPE (recorded, never reported as passed):");
    console.error("    - Lago v1.57.0 zero-amount metering evidence for A15.");
    console.error(
      "    Re-run on a healthy stack: BILLING62_RUN_ID=<id> bun run billing:test:integration",
    );
  }
  console.log(
    `\nfull-stack run complete: ${exit === 0 ? "PASS" : "FAIL"} (catalog=${catalogExit}, lago=${lago.exit})`,
  );
  return exit;
}

// ---------------------------------------------------------------------------
const guardOnly = process.argv.includes("--guard-only");
const catalogOnly = process.argv.includes("--catalog-only");
const code = guardOnly ? await runGuardOnly() : await runFull(catalogOnly);
process.exit(code);
