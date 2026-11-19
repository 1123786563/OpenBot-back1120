/**
 * #64 isolated ledger service entrypoint — process launched by the isolated
 * test driver INSIDE the dedicated compose environment.
 *
 * Environment (all one-time per run, never persisted to the repo):
 *   BILLING_LEDGER_DATABASE_URL   restricted-runtime-role PostgreSQL URL
 *   BILLING_LEDGER_CREDENTIALS    JSON array of trusted service credentials
 *   BILLING_LEDGER_CURSOR_SECRET  per-run cursor signing secret
 *   BILLING_LEDGER_PORT           HTTP port (compose network internal)
 *   BILLING_LEDGER_BARRIER_DIR    optional fault-injection barrier directory
 *
 * Fault-injection barriers (AC6a/AC6b): when a file named `before-commit` or
 * `after-commit` EXISTS in the barrier dir, the process, having finished all
 * in-transaction SQL (respectively: having received COMMIT ack), writes
 * `entered-<name>`, then blocks on the marker file's removal — the driver
 * SIGKILLs it there. Nothing HTTP-reachable can create those files; the
 * ledger business logic is the SAME code that runs in production shape.
 */
import { CredentialResolver, parseCredentials } from "./auth.js";
import { BillingLedger, createLedgerSql } from "./service.js";
import { createLedgerRoutes } from "./routes.js";
import { join } from "node:path";

const databaseUrl = process.env.BILLING_LEDGER_DATABASE_URL;
if (!databaseUrl) throw new Error("BILLING_LEDGER_DATABASE_URL is required");
const cursorSecret = process.env.BILLING_LEDGER_CURSOR_SECRET;
if (!cursorSecret) throw new Error("BILLING_LEDGER_CURSOR_SECRET is required");
const port = Number(process.env.BILLING_LEDGER_PORT ?? "4194");
const barrierDir = process.env.BILLING_LEDGER_BARRIER_DIR;

const sql = createLedgerSql(databaseUrl, { max: 16 });
const resolver = new CredentialResolver(parseCredentials(process.env.BILLING_LEDGER_CREDENTIALS));

/** Barrier helper: block while the marker file exists, annnounce entry. */
function makeHook(name: "before-commit" | "after-commit") {
  return async (): Promise<void> => {
    if (!barrierDir) return;
    const marker = join(barrierDir, name);
    const entered = join(barrierDir, `entered-${name}`);
    const fs = await import("node:fs");
    if (!fs.existsSync(marker)) return;
    fs.writeFileSync(entered, String(process.pid));
    console.info(JSON.stringify({ type: `barrier-entered`, name, pid: process.pid }));
    while (fs.existsSync(marker)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    fs.rmSync(entered, { force: true });
  };
}

const ledger = new BillingLedger(sql, {
  hooks: {
    beforeCommit: makeHook("before-commit"),
    afterCommit: makeHook("after-commit"),
  },
});

const app = createLedgerRoutes({ ledger, resolver, cursorSecret });

app.get("/healthz", (c) => c.text("ok"));

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
});

console.info(
  JSON.stringify({
    type: "billing-ledger-listening",
    port: server.port,
    pid: process.pid,
  }),
);

// Schema drift fails LOUDLY at startup rather than at first write.
await sql`SELECT 1 FROM billing.account LIMIT 1`;

const shutdown = (): void => {
  server.stop(true);
  void sql.end({ timeout: 2 }).finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
