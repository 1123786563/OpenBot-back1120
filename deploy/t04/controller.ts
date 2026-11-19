import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * The T04 test controller: a private, loopback-only helper that lets the browser verification
 * script arm one-shot faults, drop the rendezvous barrier, and kill or restart the source server
 * mid-verification — the external test controller the T04 design calls for.
 *
 * It is not part of OpenBot and never runs in a deployment: it writes the private fault file and
 * drives `deploy/t04/run.ts` exactly as an operator at the terminal would. It binds 127.0.0.1 on a
 * port nothing else uses, accepts no identity material, and returns only what the scenario needs
 * (an acknowledgement and a timestamp).
 */
const PORT = 14099;
const BASE = "http://localhost:14003";

function run(task: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["deploy/t04/run.ts", task, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim(),
    stderr: result.stderr?.trim(),
  };
}

const MODE_FILE = "deploy/t04/.runtime/fault-mode.json";

/** Whether the tracked server was started with fault control armed. */
function faultMode(): "on" | "off" | "unknown" {
  try {
    const raw = JSON.parse(readFileSync(MODE_FILE, "utf8"));
    return raw.mode === "on" || raw.mode === "off" ? raw.mode : "unknown";
  } catch {
    return "unknown";
  }
}

function setFaultMode(mode: "on" | "off") {
  writeFileSync(MODE_FILE, `${JSON.stringify({ mode })}\n`, { mode: 0o600 });
}

/**
 * A kill-and-restart scenario deliberately leaves the server running without fault control; the
 * next scenario that needs a fault must not arm it into a server that is not listening for it.
 * When the tracked mode is off, restart under fault control before arming anything.
 */
async function ensureFaultControl(): Promise<{ restarted: boolean }> {
  if (faultMode() === "on") return { restarted: false };
  run("stop");
  const up = run("start");
  if (!up.ok) throw new Error(`restart under fault control failed: ${up.stderr ?? ""}`);
  setFaultMode("on");
  return { restarted: true };
}

async function healthy() {
  for (let n = 0; n < 90; n++) {
    const r = await fetch(`${BASE}/health`).catch(() => null);
    if (r?.ok) return true;
    await Bun.sleep(1000);
  }
  return false;
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // Empty body is fine for the action-only endpoints.
    }
    const at = new Date().toISOString();
    switch (url.pathname) {
      case "/arm": {
        const point = String(body.point ?? "");
        const ensured = await ensureFaultControl();
        const result =
          body.mode === "barrier"
            ? run("barrier", point, String(body.parties ?? 2))
            : run("fault", point, String(body.remaining ?? 1));
        return json({ action: "arm", point, ensured, at, ...result });
      }
      case "/clear": {
        return json({ action: "clear", at, ...run("clearfault") });
      }
      case "/kill-server": {
        const result = run("kill");
        return json({ action: "kill-server", at, ...result });
      }
      case "/start-server": {
        const mode = body.faults ? "start" : "start-nofaults";
        const result = run(mode);
        const up = await healthy();
        setFaultMode(body.faults ? "on" : "off");
        return json({ action: "start-server", mode, up, at, ...result });
      }
      case "/stop-server": {
        const result = run("stop");
        setFaultMode("off");
        return json({ action: "stop-server", at, ...result });
      }
      case "/verify-user": {
        // Test-IdP fixture: mark one just-registered identity's address as verified in the
        // Casdoor database, so a password login carries a verified claim. This is the identity
        // provider's own data — OpenBot's database is never touched by hand. The public
        // mail-code login path stays the demonstrated real verification (S0).
        const name = String(body.name ?? "");
        if (!/^[A-Za-z0-9_]+$/.test(name))
          return json({ error: "bad name" }, 400);
        const result = spawnSync(
          "docker-compose",
          [
            "-p", "openbot-t04",
            "--env-file", "deploy/t04/.env.t04",
            "-f", "deploy/t04/docker-compose.t04.yml",
            "exec", "-T", "casdoor-db",
            "psql", "-U", "casdoor_t04", "-d", "casdoor_t04",
            "-Atc",
            `update "user" set email_verified=true where owner='openbot-t04' and name='${name}'`,
          ],
          { encoding: "utf8", timeout: 60_000 },
        );
        const okVerified = result.stdout?.trim() === "UPDATE 1";
        return json({ action: "verify-user", name, verified: okVerified, at });
      }
      case "/ping": {
        const up = await fetch(`${BASE}/health`)
          .then((r) => r.ok)
          .catch(() => false);
        return json({ up, at });
      }
      default:
        return json({ error: "unknown action" }, 404);
    }
  },
});
console.log(`T04 test controller listening on 127.0.0.1:${PORT}`);
