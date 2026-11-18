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
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
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
  console.log("billing62 guard-only run (real PostgreSQL; local binaries or docker)");
  const runId = process.env.BILLING62_RUN_ID ?? makeRunId();
  console.log(`  run id: ${runId}`);
  const pgRoot =
    process.env.BILLING62_PG_BIN_DIR ??
    "/workspace/.tools/pg/postgresql-17.12.0-aarch64-unknown-linux-gnu/bin";
  const pgBinDir = join(
    pgRoot.endsWith("bin") ? pgRoot : pgRoot,
    pgRoot.endsWith("bin") ? "" : "bin",
  );
  const hasLocalBinaries = existsSync(join(pgBinDir, "postgres"));
  const dockerUp = sh("docker --version").code === 0;
  if (!hasLocalBinaries && !dockerUp) {
    console.error(
      `  FAIL no standalone PostgreSQL at ${pgBinDir} and no docker available. ` +
        "The guard suite requires REAL PostgreSQL and never silently skips.",
    );
    return 2;
  }
  if (!hasLocalBinaries) {
    console.log(
      "  no local PostgreSQL binaries; using a disposable postgres:17 container on 127.0.0.1 (per #64 design §8)",
    );
    return runGuardOnlyDocker(runId);
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


/**
 * The guard suite against a REAL disposable postgres:17 in docker when no
 * local binaries exist. Same assertions, same run-id grammar; the container
 * is name-scoped to this run and removed in finally, loopback port only.
 */
async function runGuardOnlyDocker(runId: string): Promise<number> {
  const container = `billing62_guard_${runId}`;
  const port = 15432 + Math.floor(Math.random() * 2000);
  const psql = (db: string, sql: string): { code: number; out: string } =>
    sh(
      `docker exec ${container} psql -U billing62_guard -d ${db} -tAc ${JSON.stringify(sql)}`,
    );
  let started = false;
  try {
    const run = sh(
      `docker run -d --rm --name ${container} -e POSTGRES_USER=billing62_guard -e POSTGRES_PASSWORD=guard -p 127.0.0.1:${port}:5432 postgres:17`,
    );
    if (run.code !== 0) throw new Error(`docker run failed: ${run.out.slice(0, 300)}`);
    started = true;
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = psql("postgres", "select 1").code === 0;
      if (!ready) await new Promise((r) => setTimeout(r, 300));
    }
    if (!ready) throw new Error("disposable postgres container did not become ready");
    psql("postgres", `CREATE DATABASE "billing62_${runId}"`);

    console.log("\n== guard: pure target whitelist (zero-I/O assertions)");
    const good = isolatedTarget({
      runId,
      host: "127.0.0.1",
      port,
      user: "billing62_guard",
      password: "guard",
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
      port,
      user: "u",
      password: "p",
    });
    ok(
      checkTarget({ url: foreignRun.url, project: good.project, runId }).ok === false,
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
      checkTarget({
        url: good.url.replace("127.0.0.1", "10.0.0.7"),
        project: good.project,
        runId,
      }).ok === true,
      "accepts a private-LAN host on the compose internal network",
    );
    ok(
      checkTarget({ url: "not a url", project: good.project, runId }).ok === false,
      "rejects malformed connection targets before any I/O",
    );

    console.log("\n== guard: real disposable PostgreSQL 17 (docker)");
    ok(true, `disposable postgres ready on 127.0.0.1:${port}`);
    const conn = psql(`billing62_${runId}`, "select 1");
    ok(conn.code === 0, "guard-accepted target connects to the isolated database");

    const rej = sh(
      `bun tests/billing/guard.ts --url "postgres://u@127.0.0.1:${port}/postgres" ` +
        `--project ${good.project} --run-id ${runId}`,
    );
    ok(rej.code === 1, "guard CLI exits 1 on the default-database target");
    const probe = psql(
      "postgres",
      `select count(*) from pg_database where datname like 'billing62%' and datname NOT IN ('billing62_${runId}', 'billing62_guard')`,
    );
    ok(
      probe.out.trim() === "0",
      "rejected target caused zero writes (no stray billing62 databases)",
    );
    const otherRun = "zz_probe_not_ours";
    const createProbe = psql(
      "postgres",
      `select count(*) from pg_database where datname='billing62_${otherRun}'`,
    );
    ok(
      createProbe.out.trim() === "0",
      "no database for a foreign run id exists",
    );
    console.log(
      `\nguard-only (docker) run complete: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failures)`,
    );
    return failures === 0 ? 0 : 1;
  } catch (e) {
    console.error(`  FAIL guard-only docker run: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  } finally {
    if (started) sh(`docker rm -f ${container}`);
  }
}

// ---------------------------------------------------------------------------
// Full-stack mode (docker compose; Lago CE v1.57.0)
// ---------------------------------------------------------------------------
const COMPOSE = "docker-compose"; // docker 29.x here has no `compose` subcommand

function composeArgs(
  project: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { code: number; out: string } {
  return sh(`${COMPOSE} -f tests/billing/compose.yml -p ${project} ${args.join(" ")}`, { env: { ...process.env, ...env } });
}

function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

async function runFull(): Promise<number> {
  console.log(
    "billing62 full-stack run (isolated PostgreSQL 17 + Lago CE v1.57.0 + ledger driver)",
  );
  const docker = sh("docker --version");
  const compose = sh("docker-compose version");
  if (docker.code !== 0 || compose.code !== 0) {
    console.error("  FAIL docker engine / compose not available in this environment.");
    console.error("  UNVERIFIED SCOPE (must not be reported as passed):");
    console.error(
      "    - boot of tests/billing/compose.yml (pinned images, internal networks)",
    );
    console.error("    - #64 ledger acceptance phases AC1-AC7 (cases/ledger-core.ts)");
    console.error("    - Lago v1.57.0 health evidence and the Lago-down boundary phase");
    console.error(
      "  Re-run on a Docker-capable host: BILLING62_RUN_ID=<id> bun run billing:test:integration",
    );
    return 2;
  }

  const runId = process.env.BILLING62_RUN_ID ?? makeRunId();
  if (!/^[a-z0-9_]{4,64}$/.test(runId)) {
    console.error(`  FAIL run id ${JSON.stringify(runId)} fails the guard grammar`);
    return 2;
  }
  const project = `billing62_${runId}`;
  // one-time per-run credentials, never written to the repo or the report
  const pgUser = `billing62_${runId.slice(0, 8)}_u`;
  const pgPassword = randomToken(24);
  const lagoDbName = `lago_${runId}`;
  const lagoUser = `lago_${runId.slice(0, 8)}_u`;
  const lagoPassword = randomToken(24);
  const appPassword = randomToken(24);
  const cursorSecret = randomToken(32);
  const lagoRsa = sh(`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null`);
  const lagoEnc = randomToken(24);
  const lagoEncDet = randomToken(24);
  const lagoSalt = randomToken(24);
  if (lagoRsa.code !== 0) {
    console.error("  FAIL openssl unavailable: cannot generate the one-time Lago RSA key");
    return 2;
  }
  const composeEnv: NodeJS.ProcessEnv = {
    BILLING62_RUN_ID: runId,
    BILLING62_PG_USER: pgUser,
    BILLING62_PG_PASSWORD: pgPassword,
    BILLING62_LAGO_DB_NAME: lagoDbName,
    BILLING62_LAGO_USER: lagoUser,
    BILLING62_LAGO_PASSWORD: lagoPassword,
    BILLING_LEDGER_APP_PASSWORD: appPassword,
    BILLING_LEDGER_CURSOR_SECRET: cursorSecret,
    BILLING62_LAGO_RSA_KEY_B64: Buffer.from(lagoRsa.out.trim()).toString("base64"),
    BILLING62_LAGO_SECRET_KEY_BASE: randomToken(48),
    BILLING62_LAGO_ENC_PRIMARY: lagoEnc,
    BILLING62_LAGO_ENC_DETERMINISTIC: lagoEncDet,
    BILLING62_LAGO_ENC_SALT: lagoSalt,
  };

  const appContainer = "ledger-app"; // compose exec addresses the SERVICE name
  const execDriver = (phase: string): { code: number; out: string } =>
    sh(
      `docker-compose -p ${project} exec -T ${appContainer} bun tests/billing/cases/ledger-core.ts --phase ${phase}`,
      { env: composeEnv },
    );

  let upOk = false;
  let failuresFromDriver = 0;
  try {
    console.log(`  run id: ${runId}`);
    // guard FIRST, before any docker command: the target this run will use
    const t = isolatedTarget({
      runId,
      host: `billing62_${runId}-postgres`,
      port: 5432,
      user: pgUser,
      password: pgPassword,
    });
    const guarded = checkTarget({ url: t.url, project, runId });
    if (!guarded.ok) {
      console.error(`  FAIL guard refused this run's own target: ${guarded.reason}`);
      return 2;
    }
    console.log("  PASS guard accepts this run's isolated target");

    console.log("  phase: compose up --wait (PostgreSQL 17 + Lago CE v1.57.0 + ledger driver)");
    const up = composeArgs(project, ["up", "-d", "--wait"], composeEnv);
    upOk = up.code === 0;
    if (!upOk) {
      console.error(`  FAIL compose up failed:\n${up.out.slice(-2000)}`);
      return 2;
    }

    // Lago schema migration runs ONCE and synchronously (compose run): a
    // service_completed_successfully dependency under `up --wait` makes the
    // reconciler re-run the exited migrator and recreate its dependents in a
    // loop — observed live on compose v5.5.0.
    const lagoMigrate = composeArgs(project, ["run", "--rm", "--profile", "migrate", "lago-migrate"], composeEnv);
    console.log(`    lago-migrate exit=${lagoMigrate.code}`);
    if (lagoMigrate.code !== 0) {
      console.error(`  FAIL lago-migrate failed:\n${lagoMigrate.out.slice(-1500)}`);
      return 2;
    }

    console.log("  phase: identity + health verification");
    const pgIdentity = composeArgs(project, [
      "exec", "-T", "postgres",
      "psql", "-U", pgUser, "-d", `billing62_${runId}`, "-tAc",
      "'select version()'",
    ]);
    console.log(`    postgres: ${pgIdentity.out.trim().slice(0, 100)}`);
    if (pgIdentity.code !== 0 || !pgIdentity.out.includes("PostgreSQL 17")) {
      console.error("  FAIL the database is not the pinned PostgreSQL 17 (identity check)");
      return 2;
    }
    // the JS probe is passed single-quoted so the host shell never touches it
    const lagoHealth = composeArgs(project, [
      "exec", "-T", appContainer,
      "bun", "-e",
      `'const r = await fetch("http://lago-api:3000/health", {signal: AbortSignal.timeout(120000)}); console.log("lago health", r.status, (await r.text()).slice(0,120));'`,
    ]);
    if (lagoHealth.code !== 0 || !lagoHealth.out.includes("lago health 2")) {
      console.error(`  FAIL Lago health check did not pass: ${lagoHealth.out.slice(-500)}`);
      return 2;
    }
    console.log(`    ${lagoHealth.out.trim().slice(0, 160)}`);

    console.log("  phase: driver --phase main (AC1-AC6b)");
    const main = execDriver("main");
    console.log(indent(main.out));
    if (main.code !== 0) failuresFromDriver++;

    console.log("  phase: stop Lago (api/clock/worker) for the outage boundary");
    composeArgs(project, ["stop", "lago-api", "lago-clock", "lago-worker"], composeEnv);

    console.log("  phase: driver --phase lago-outage (AC7)");
    const outage = execDriver("lago-outage");
    console.log(indent(outage.out));
    if (outage.code !== 0) failuresFromDriver++;

    console.log("  phase: cleanup (only this run's project)");
    const leftover = composeArgs(project, ["ps", "-a"], composeEnv);
    console.log(`    containers before down: ${leftover.out.trim().split("\n").length}`);

    const ok_ = failuresFromDriver === 0;
    console.log(
      `\nfull-stack run complete: ${ok_ ? "PASS" : "FAIL"} (${failuresFromDriver} failing phase(s))`,
    );
    return ok_ ? 0 : 1;
  } finally {
    if (upOk) {
      // Cleanup touches ONLY the guard-verified project; volumes are removed
      // only AFTER every assertion (including recovery) has been captured.
      composeArgs(project, ["down", "-v", "--remove-orphans"], composeEnv);
      const remains = sh(
        `docker volume ls --format '{{.Name}}' | grep '^billing62_${runId}' | wc -l`,
      );
      console.log(
        remains.out.trim() === "0"
          ? "  PASS cleanup left no billing62 volumes for this run"
          : `  WARN volumes still present after down -v:\n${remains.out}`,
      );
    } else {
      // Nothing was asserted on a failed boot, so the failed attempt's state
      // is torn down as well — a stale volume would poison the next attempt's
      // one-time credentials at the database init step.
      composeArgs(project, ["down", "-v", "--remove-orphans"], composeEnv);
      console.error("  failed boot torn down (nothing had been asserted)");
    }
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
const guardOnly = process.argv.includes("--guard-only");
const code = guardOnly ? await runGuardOnly() : await runFull();
process.exit(code);
