import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  ownsProcess,
  type ProcessRecord,
  serverEnvironment,
} from "./environment";

const state = "deploy/t01/.runtime/processes.json";
const action = process.argv[2];
const root = resolve(".");
function identity(pid: number) {
  return {
    command: execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim(),
    started: execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim(),
  };
}
if (!existsSync("server/src/production-entry.ts"))
  throw new Error("Run from OpenBot/");
if (action === "stop") {
  if (!existsSync(state)) process.exit(0);
  const saved: ProcessRecord[] = JSON.parse(readFileSync(state, "utf8"));
  for (const record of saved) {
    let current;
    try {
      current = identity(record.pid);
    } catch {
      continue;
    }
    if (!ownsProcess(record, current, root))
      throw new Error("PID ownership mismatch; refusing to signal it");
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
} else if (action === "up") {
  if (existsSync(state) && JSON.parse(readFileSync(state, "utf8")).length)
    throw new Error("Stop tracked processes before starting again");
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR"])
    if (process.env[k]) env[k] = process.env[k]!;
  const saved = [];
  for (const [name, entry, vars] of [
    [
      "server",
      "server/src/production-entry.ts",
      serverEnvironment(process.env),
    ],
    [
      "worker",
      "worker/src/index.ts",
      Object.fromEntries(
        ["DATABASE_URL", "WORKER_SHARED_SECRET"].map((k) => [
          k,
          process.env[k],
        ]),
      ),
    ],
  ] as const) {
    const fd = openSync(`deploy/t01/.runtime/${name}.log`, "a", 0o600);
    const file = resolve(entry);
    const child = spawn(process.execPath, [file], {
      cwd: resolve("server"),
      env: { ...env, ...vars, SERVER_INTERNAL_URL: "http://localhost:13001" },
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    closeSync(fd);
    if (!child.pid) throw new Error("Spawn failed");
    await Bun.sleep(100);
    const started = identity(child.pid).started;
    saved.push({
      pid: child.pid,
      entry: file,
      executable: process.execPath,
      started,
    });
    writeFileSync(state, JSON.stringify(saved), { mode: 0o600 });
  }
  for (let n = 0; n < 60; n++) {
    const r = await fetch("http://localhost:13001/health").catch(() => null);
    if (r?.ok) {
      console.log("OpenBot source server healthy on 13001; worker launched");
      process.exit(0);
    }
    await Bun.sleep(1000);
  }
  throw new Error(
    "Server did not become healthy; inspect private .runtime/server.log and stop tracked processes",
  );
} else throw new Error("Expected up or stop");
