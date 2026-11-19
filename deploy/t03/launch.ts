import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  ownsProcess,
  processExecutables,
  serverEnvironment,
  FAULT_FILE,
  type ProcessRecord,
} from "./environment-helpers";

const state = "deploy/t03/.runtime/processes.json";
const action = process.argv[2];

if (!existsSync("server/src/production-entry.ts"))
  throw new Error("Run from OpenBot/");

if (action === "stop") {
  if (!existsSync(state)) process.exit(0);
  const saved: ProcessRecord[] = JSON.parse(readFileSync(state, "utf8"));
  for (const record of saved) {
    if (!ownsProcess(record, record.pid)) continue;
    process.kill(record.pid, "SIGTERM");
  }
  await Bun.sleep(2000);
  for (const { pid } of saved) {
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }
    throw new Error("Process is still stopping; do not restart it yet");
  }
  writeFileSync(state, "[]", { mode: 0o600 });
} else if (action === "kill") {
  // The T03 restart scenario: terminate the tracked server process hard (the worker stays), so
  // the recovery has to come from committed database state alone. Ownership is checked first.
  if (!existsSync(state))
    throw new Error("No tracked processes; start the server first");
  const saved: ProcessRecord[] = JSON.parse(readFileSync(state, "utf8"));
  const server = saved.find((r) => r.entry.endsWith("production-entry.ts"));
  if (!server) throw new Error("No tracked server process");
  if (!ownsProcess(server, server.pid))
    throw new Error("PID ownership mismatch; refusing to signal it");
  const killedAt = new Date().toISOString();
  process.kill(server.pid, "SIGKILL");
  for (let n = 0; n < 30; n++) {
    let listeners = "";
    try {
      listeners = execFileSync(
        "lsof",
        ["-w", "-nP", "-iTCP:14002", "-sTCP:LISTEN", "-Fp"],
        { encoding: "utf8" },
      ).trim();
    } catch {
      listeners = "";
    }
    if (!listeners) break;
    await Bun.sleep(500);
  }
  // Remove only the server from tracking, so `up` can restart it while the worker keeps running.
  writeFileSync(
    state,
    JSON.stringify(saved.filter((r) => r !== server)),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ type: "server-killed", pid: server.pid, killedAt }),
  );
} else if (action === "up" || action === "up-nofaults") {
  if (existsSync(state)) {
    const records: ProcessRecord[] = JSON.parse(readFileSync(state, "utf8"));
    // The restart scenario leaves a killed server behind in the file and keeps the worker it
    // did not touch. Only a record that still verifies as a live process blocks a start.
    const alive = records.filter((r) => ownsProcess(r, r.pid));
    writeFileSync(state, JSON.stringify(alive), { mode: 0o600 });
    // The restart scenario leaves the untouched worker running; only a live server blocks a
    // start, because a second one could not bind.
    if (alive.some((r) => r.entry.endsWith("production-entry.ts")))
      throw new Error("Stop tracked processes before starting again");
  }
  // One process per port. A leftover server that still holds 14002 would leave the freshly
  // spawned one to fail its bind while health checks kept passing against the orphan — exactly
  // the situation the kill-and-restart scenario must never be run in.
  // `lsof` answers 1 when nothing is listening, which is the good case here.
  let listeners = "";
  try {
    listeners = execFileSync(
      "lsof",
      ["-w", "-nP", "-iTCP:14002", "-sTCP:LISTEN", "-Fp"],
      { encoding: "utf8" },
    );
  } catch {
    listeners = "";
  }
  if (/^p\d/m.test(listeners))
    throw new Error(
      "Port 14002 is already listening; stop that process before starting",
    );
  mkdirSync("deploy/t03/.runtime", { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR"])
    if (process.env[k]) env[k] = process.env[k];
  const isolated = serverEnvironment(process.env);
  // The fault-control file exists only when the launcher is asked to arm the T03 verification
  // points. `up-nofaults` starts the same source server with no fault control at all, which is
  // what every post-recovery scenario runs under.
  const withFaults = action === "up";
  if (withFaults && !existsSync(FAULT_FILE))
    writeFileSync(FAULT_FILE, "", { mode: 0o600 });
  const serverVars = withFaults
    ? { ...isolated, OPENBOT_TEST_FAULT_FILE: resolve(FAULT_FILE) }
    : isolated;
  // A fresh checkout has no process state yet; `stop` already tolerates that, and so must `up`,
  // otherwise the very first `up.sh` on a clean tree fails with ENOENT before spawning anything.
  const saved: ProcessRecord[] = existsSync(state)
    ? JSON.parse(readFileSync(state, "utf8"))
    : [];
  for (const [name, entry, vars] of [
    ["server", "server/src/production-entry.ts", serverVars],
    [
      "worker",
      "worker/src/index.ts",
      Object.fromEntries(
        ["DATABASE_URL", "WORKER_SHARED_SECRET"].map((k) => [k, isolated[k]]),
      ),
    ],
  ] as const) {
    // A live record from the restart scenario keeps its process; the launcher must not spawn a twin.
    if (saved.some((r) => r.entry === resolve(entry) && ownsProcess(r, r.pid)))
      continue;
    const fd = openSync(`deploy/t03/.runtime/${name}.log`, "a", 0o600);
    const file = resolve(entry);
    const child = spawn(process.execPath, [file], {
      cwd: resolve("server"),
      env: { ...env, ...vars, SERVER_INTERNAL_URL: "http://localhost:14002" },
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    closeSync(fd);
    if (!child.pid) throw new Error("Spawn failed");
    await Bun.sleep(300);
    saved.push({
      pid: child.pid,
      entry: file,
      executable: process.execPath,
    });
    if (!ownsProcess(saved[saved.length - 1], child.pid))
      throw new Error(`Spawned ${name} does not verify as its own record`);
    writeFileSync(state, JSON.stringify(saved), { mode: 0o600 });
  }
  for (let n = 0; n < 60; n++) {
    const r = await fetch("http://localhost:14002/health").catch(() => null);
    if (r?.ok) {
      console.log(
        `OpenBot source server healthy on 14002; worker launched; fault control ${withFaults ? "armed" : "absent"}`,
      );
      process.exit(0);
    }
    await Bun.sleep(1000);
  }
  throw new Error(
    "Server did not become healthy; inspect private .runtime/server.log and stop tracked processes",
  );
} else throw new Error("Expected up, up-nofaults, kill or stop");
