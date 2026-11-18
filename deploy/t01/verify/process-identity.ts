/**
 * Executable check for the lsof fallback process identity on hosts that refuse
 * `ps`. Spawns a decoy Bun process with the SAME executable and the SAME
 * working directory as the tracked server (the exact PID-reuse scenario an
 * unrelated deploy/t01 script could produce), then asserts that the launch.ts
 * ownership check refuses it — without ever signalling either process.
 *
 * Run from OpenBot/ with the fixed Bun: bun deploy/t01/verify/process-identity.ts
 * Exits non-zero on any failure. Sends SIGKILL only to the decoy it spawned.
 */
import { spawn } from "node:child_process";
import { openSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".");
const state = `${root}/deploy/t01/.runtime/processes.json`;
const saved: {
  pid: number;
  entry: string;
  executable: string;
  started: string;
  instance: string;
}[] = JSON.parse(readFileSync(state, "utf8"));
const server = saved.find((r) => r.entry.endsWith("production-entry.ts"));
if (!server) throw new Error("No tracked server record");

// Mirror launch.ts observation() (this host refuses ps, so this IS the
// lsof fallback path, not a simulation of it).
function observation(pid: number) {
  const out = Bun.spawnSync(["lsof", "-w", "-p", String(pid)]).stdout
    .toString();
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
  if (!cwd || !txt) throw new Error(`PID ${pid} not observable via lsof`);
  return { command: `${txt} ${cwd}`, started: "", stdio };
}

// 1. The real server still owns its own record.
const own = observation(server.pid);
const ownOk =
  own.command === `${server.executable} ${root}/server` &&
  own.stdio.includes(server.instance);
console.log(
  `real server pid=${server.pid} stdio=${own.stdio.join(",")} owned=${ownOk}`,
);
if (!ownOk) throw new Error("Real server no longer matches its record");

// 2. Decoy: same executable, same cwd, different instance (own stdout file).
const decoyLog = `${root}/deploy/t01/.runtime/decoy-${Date.now()}.log`;
const decoy = spawn(server.executable, ["-e", "await Bun.sleep(20000)"], {
  cwd: `${root}/server`,
  stdio: ["ignore", openSync(decoyLog, "w", 0o600), openSync(decoyLog, "w", 0o600)],
  detached: true,
});
decoy.unref();
try {
  await Bun.sleep(500);
  const obs = observation(decoy.pid);
  console.log(
    `decoy pid=${decoy.pid} command=${obs.command} stdio=${obs.stdio.join(",")}`,
  );
  const identical = obs.command === own.command;
  console.log(`decoy executable+cwd identical to server: ${identical}`);
  if (!identical)
    throw new Error("Decoy did not reproduce the executable/cwd collision");

  // 3. The reused-PID scenario: server record pointing at the decoy PID.
  const reused = { ...server, pid: decoy.pid };
  const owned = await (async () => {
    const { ownsProcess } = await import("../environment");
    return ownsProcess(reused, obs, root);
  })();
  console.log(`ownsProcess(server record, decoy pid) = ${owned} (want false)`);
  if (owned)
    throw new Error(
      "FATAL: fallback would have signalled the decoy — fix is not effective",
    );

  // 4. Inverse control: a record for the decoy's instance must not own the
  //    real server PID either.
  const inverse = await import("../environment").then(({ ownsProcess }) =>
    ownsProcess(
      { ...server, pid: server.pid, instance: decoyLog },
      own,
      root,
    ),
  );
  console.log(`ownsProcess(decoy instance, real pid) = ${inverse} (want false)`);
  if (inverse) throw new Error("Inverse check failed");
  console.log("PASS: lsof fallback refuses same-executable/same-cwd PID reuse");
} finally {
  decoy.kill("SIGKILL");
  await Bun.sleep(200);
  rmSync(decoyLog, { force: true });
}
