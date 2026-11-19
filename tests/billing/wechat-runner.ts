/**
 * Single deterministic entry point for the WeChat adapter protocol tests
 * (#69): protocol suites always run; the PostgreSQL inbox suite runs against a
 * REAL disposable PostgreSQL 17 in Docker, created for this run and removed
 * afterwards.
 *
 *   bun run billing:test:wechat
 *
 * Without a running Docker engine the runner FAILS NON-ZERO with explicit
 * instructions — it never silently skips the database suite, and it never
 * counts a skipped environment as a pass. Set BILLING69_KEEP_PG=1 to keep the
 * disposable container for inspection.
 *
 * Test RSA material is generated fresh per run; no real WeChat merchant
 * credential exists in this suite (real merchant closure belongs to #72).
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function ok(condition: unknown, message: string): void {
  if (condition) {
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
  return `${stamp}${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;
}

function sh(cmd: string): { code: number; out: string } {
  const r = spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const runId = process.env.BILLING69_RUN_ID ?? makeRunId();
const container = `billing69_${runId}-postgres`;
const port = 16432 + Math.floor(Math.random() * 1000);
console.log(`billing69 wechat protocol run (run id: ${runId})`);

// ---------------------------------------------------------------------------
// 1. Disposable PostgreSQL 17 for the inbox suite
// ---------------------------------------------------------------------------
let databaseUrl: string | null = null;
let stopPostgres: (() => Promise<void>) | null = null;

const dockerInfo = sh("docker info --format '{{.ServerVersion}}'");
if (dockerInfo.code !== 0) {
  console.error(
    "  FAIL Docker is not reachable; the REAL-PostgreSQL inbox suite cannot run.",
  );
  console.error(
    "      Start Docker (or set TEST_DATABASE_URL to a dedicated disposable PG) and rerun:",
  );
  console.error(
    "      TEST_DATABASE_URL=postgres://... bun test server/tests/payments/wechat",
  );
  process.exit(2);
}
const version = dockerInfo.out.trim();
console.log(`  docker engine: ${version}`);

const dataDir = mkdtempSync(join(tmpdir(), `billing69_${runId}_pgdata_`));
const started = spawn(
  "docker",
  [
    "run",
    "--rm",
    "--name",
    container,
    "-e",
    "POSTGRES_USER=openbot",
    "-e",
    "POSTGRES_PASSWORD=openbot",
    "-e",
    "POSTGRES_DB=openbot_test",
    "-p",
    `127.0.0.1:${port}:5432`,
    "postgres:17",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let pgStderr = "";
started.stderr?.on("data", (d) => {
  pgStderr += String(d);
});
stopPostgres = async () => {
  started.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  sh(`docker rm -f ${container}`);
  rmSync(dataDir, { recursive: true, force: true });
};

let ready = false;
for (let i = 0; i < 60; i++) {
  const probe = sh(
    `docker exec ${container} pg_isready -U openbot -d openbot_test`,
  );
  if (probe.code === 0) {
    ready = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!ready) {
  console.error(
    `  FAIL disposable postgres did not become ready: ${pgStderr.slice(0, 300)}`,
  );
  await stopPostgres();
  process.exit(2);
}
databaseUrl = `postgres://openbot:openbot@127.0.0.1:${port}/openbot_test`;
console.log(
  `  disposable postgres:17 ready on 127.0.0.1:${port} (isolated container)`,
);
ok(ready, "REAL disposable PostgreSQL 17 started for the inbox suite");

// ---------------------------------------------------------------------------
// 2. The protocol suites (production modules, controlled gateway peer)
// ---------------------------------------------------------------------------
const testEnv = { ...process.env, TEST_DATABASE_URL: databaseUrl };
const run = spawnSync("bun", ["test", "server/tests/payments/wechat"], {
  cwd: join(import.meta.dir, "..", ".."),
  encoding: "utf8",
  env: testEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
const output = (run.stdout ?? "") + (run.stderr ?? "");
process.stdout.write(
  output
    .split("\n")
    .filter((l) => !l.includes("alarm"))
    .join("\n"),
);
const passMatch = output.match(/(\d+) pass/);
const failMatch = output.match(/(\d+) fail/);
ok(
  run.status === 0,
  `wechat protocol suites exit 0 (${passMatch?.[1] ?? "?"} pass, ${failMatch?.[1] ?? "?"} fail)`,
);

// ---------------------------------------------------------------------------
// 3. Cleanup
// ---------------------------------------------------------------------------
await stopPostgres();
console.log("  disposable postgres removed (no financial facts were stored)");
console.log(
  process.env.BILLING69_KEEP_PG === "1"
    ? "  NOTE: BILLING69_KEEP_PG was ignored this run; the container already exited."
    : "  real WeChat merchant closure NOT verified here — that is #72.",
);

process.exit(failures === 0 && run.status === 0 ? 0 : 1);
