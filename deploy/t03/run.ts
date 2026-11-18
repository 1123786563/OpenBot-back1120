import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { FAULT_FILE, serverEnvironment } from "./environment-helpers";

/*
 * T03 entry point. Same shape as T02's run.ts, with the fault control the T03 scenarios need:
 *
 *   bun deploy/t03/run.ts fault before-user-insert   arm a one-shot failure at a point
 *   bun deploy/t03/run.ts barrier user-create 2      arm a rendezvous for concurrent first sign-ins
 *   bun deploy/t03/run.ts clearfault                 disarm whatever is armed
 *
 * The file lives in the private 0700 .runtime directory, is written 0600, and is consumed by the
 * server after one hit, so no retry ever fires the same fault twice.
 */
const env = serverEnvironment(process.env);
const task = process.argv[2];

if (task === "fault" || task === "barrier") {
  const point = process.argv[3];
  assert(point, "Expected a fault point, e.g. before-user-insert");
  mkdirSync("deploy/t03/.runtime", { recursive: true, mode: 0o700 });
  const spec =
    task === "fault"
      ? {
          mode: "fault",
          point,
          remaining: Number(process.argv[4] ?? 1) || 1,
        }
      : { mode: "barrier", point, parties: Number(process.argv[4] ?? 2) };
  writeFileSync(FAULT_FILE, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ armed: spec }));
} else if (task === "clearfault") {
  if (existsSync(FAULT_FILE)) {
    writeFileSync(FAULT_FILE, "", { mode: 0o600 });
  }
  console.log(JSON.stringify({ armed: null }));
} else {
  const commands: Record<string, string[]> = {
    migrate: ["server/scripts/migrate.ts"],
    provision: ["deploy/t03/provision-casdoor.ts"],
    start: ["deploy/t03/launch.ts", "up"],
    "start-nofaults": ["deploy/t03/launch.ts", "up-nofaults"],
    kill: ["deploy/t03/launch.ts", "kill"],
    stop: ["deploy/t03/launch.ts", "stop"],
    persistence: ["deploy/t03/verify-persistence.ts"],
    listeners: ["deploy/t03/verify-listeners.ts"],
    secrets: ["deploy/t03/secret-check.ts"],
  };
  assert(task in commands, "Unknown run.ts task");
  const result = spawnSync(process.execPath, commands[task], {
    env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
