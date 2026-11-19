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
function observation(pid: number) {
  try {
    return {
      command: execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      }).trim(),
      started: execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
      }).trim(),
    };
  } catch (error) {
    // Locked-down hosts can refuse to exec ps. Fall back to lsof, which exposes
    // the executable (txt), the working directory (cwd) and — crucially — the
    // fd 1/2 targets, i.e. the per-launch instance file. Executable and cwd are
    // shared by server, worker and unrelated scripts, so only that file can
    // identify the instance; ownsProcess refuses to signal without it.
    if ((error as NodeJS.ErrnoException)?.code !== "EPERM") throw error;
    const out = execFileSync("lsof", ["-w", "-p", String(pid)], {
      encoding: "utf8",
    });
    let cwd: string | undefined;
    let txt: string | undefined;
    const stdio: string[] = [];
    for (const line of out.split("\n")) {
      const columns = line.trim().split(/\s+/);
      const name = columns.at(-1);
      if (!name?.startsWith("/")) continue;
      if (columns[3] === "cwd") cwd = name;
      if (columns[3] === "txt" && !txt) txt = name;
      if (/^[12][rwu]$/.test(columns[3] ?? "")) stdio.push(name);
    }
    if (!cwd || !txt)
      throw new Error(
        `Process ${pid} identity unavailable: neither ps nor lsof could observe it`,
      );
    return { command: `${txt} ${cwd}`, started: "", stdio };
  }
}
if (!existsSync("server/src/production-entry.ts"))
  throw new Error("Run from OpenBot/");
if (action === "stop") {
  if (!existsSync(state)) process.exit(0);
  const saved: ProcessRecord[] = JSON.parse(readFileSync(state, "utf8"));
  for (const record of saved) {
    let current: ReturnType<typeof observation>;
    try {
      current = observation(record.pid);
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
  console.log("Tracked processes stopped");
} else if (action === "up") {
  if (existsSync(state) && JSON.parse(readFileSync(state, "utf8")).length)
    throw new Error("Stop tracked processes before starting again");
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
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
    // Unique per launch: the open fd 1/2 on this file is the instance identity
    // used by the lsof fallback when ps is unavailable.
    const instance = resolve(
      `deploy/t01/.runtime/${name}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.log`,
    );
    const fd = openSync(instance, "a", 0o600);
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
    const current = observation(child.pid);
    const record: ProcessRecord = {
      pid: child.pid,
      entry: file,
      executable: process.execPath,
      started: current.started,
      instance,
    };
    if (!ownsProcess(record, current, root))
      throw new Error(
        "Spawned process identity unverifiable; refusing to track it",
      );
    saved.push(record);
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
    "Server did not become healthy; inspect the private per-instance logs in .runtime and stop tracked processes",
  );
} else throw new Error("Expected up or stop");
