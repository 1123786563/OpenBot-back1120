/**
 * Billing isolation guard (#62, requirement §7 / design §5).
 *
 * The guard runs BEFORE any connection, migration, seed or cleanup. It is a
 * pure function: on violation it exits non-zero WITHOUT ever opening a
 * socket or writing anything, which is what makes "wrong target rejected
 * with zero writes" provable.
 *
 * Rules:
 *  - Database name MUST match `billing62_<run_id>` (run id: [a-z0-9_]+).
 *  - Compose project MUST match `billing62_<run_id>` exactly.
 *  - Hosts must be loopback, the RFC1918/RFC4193 private ranges used by the
 *    compose internal network, or the compose service names of THIS run's
 *    project (`billing62_<run_id>-postgres`, `billing62_<run_id>-lago-db`).
 *    Anything else (public host, external network alias, production host)
 *    is rejected.
 *  - Connections are per-run: a database named for a DIFFERENT run id is
 *    rejected just like a non-test target.
 */

export const DB_NAME_PREFIX = "billing62_";
export const PROJECT_PREFIX = "billing62_";

export interface GuardTarget {
  url: string;
  project: string;
  runId: string;
}

export interface GuardRejection {
  ok: false;
  reason: string;
}

export interface GuardAcceptance {
  ok: true;
  dbName: string;
  host: string;
}

/** Parse a postgres/libpq URL without contacting anything. */
export function parseConnectionUrl(raw: string): {
  dbName: string;
  host: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `connection target is not a valid URL (rejected before any I/O)`,
    );
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, "")).split(
    "?",
  )[0];
  const host = url.hostname;
  if (!dbName) throw new Error("connection target has no database name");
  return { dbName, host };
}

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function isPrivateLan(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    return false;
  }
  return host.startsWith("fd") || host.startsWith("fc"); // fc00::/7 ULA
}

function isRunServiceHost(host: string, runId: string): boolean {
  return (
    host === `${PROJECT_PREFIX}${runId}-postgres` ||
    host === `${PROJECT_PREFIX}${runId}-lago-db`
  );
}

/**
 * Validate a target. Throws on violation (callers must treat any throw as
 * "abort with zero writes"). Returns the parsed target on success.
 */
export function assertSafeTarget(t: GuardTarget): GuardAcceptance {
  if (!/^[a-z0-9_]{4,64}$/.test(t.runId)) {
    throw new Error(
      `run id ${JSON.stringify(t.runId)} is not a safe [a-z0-9_]{4,64} token`,
    );
  }
  if (t.project !== `${PROJECT_PREFIX}${t.runId}`) {
    throw new Error(
      `compose project ${JSON.stringify(t.project)} is not ${PROJECT_PREFIX}${t.runId}`,
    );
  }
  const { dbName, host } = parseConnectionUrl(t.url);
  if (dbName !== `${DB_NAME_PREFIX}${t.runId}`) {
    throw new Error(
      `database ${JSON.stringify(dbName)} is not this run's isolated database ${DB_NAME_PREFIX}${t.runId}`,
    );
  }
  const hostAllowed =
    isLoopback(host) || isPrivateLan(host) || isRunServiceHost(host, t.runId);
  if (!hostAllowed) {
    throw new Error(
      `host ${JSON.stringify(host)} is outside the loopback/private/compose-service whitelist`,
    );
  }
  return { ok: true, dbName, host };
}

/** Non-throwing variant for report-style checks. */
export function checkTarget(t: GuardTarget): GuardRejection | GuardAcceptance {
  try {
    return assertSafeTarget(t);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The canonical per-run database/URL a runner must use. */
export function isolatedTarget(opts: {
  runId: string;
  host: string;
  port: number;
  user: string;
  password: string;
}): {
  project: string;
  dbName: string;
  url: string;
} {
  const dbName = `${DB_NAME_PREFIX}${opts.runId}`;
  const project = `${PROJECT_PREFIX}${opts.runId}`;
  const url =
    `postgres://${encodeURIComponent(opts.user)}:${encodeURIComponent(opts.password)}` +
    `@${opts.host}:${opts.port}/${dbName}`;
  assertSafeTarget({ url, project, runId: opts.runId }); // never return an unsafe target
  return { project, dbName, url };
}

// ---------------------------------------------------------------------------
// CLI: bun tests/billing/guard.ts --url <url> --project <project> --run-id <id>
// Exits 0 = safe, 1 = rejected (before any I/O).
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = get("--url");
  const project = get("--project");
  const runId = get("--run-id");
  if (!url || !project || !runId) {
    console.error(
      "usage: guard.ts --url <postgres-url> --project <project> --run-id <run id>",
    );
    process.exit(1);
  }
  const result = checkTarget({ url, project, runId });
  if (result.ok) {
    console.log(
      `guard: SAFE db=${result.dbName} host=${result.host} project=${project}`,
    );
    process.exit(0);
  }
  console.error(
    `guard: REJECTED — ${result.reason} (no connection attempted, zero writes)`,
  );
  process.exit(1);
}
