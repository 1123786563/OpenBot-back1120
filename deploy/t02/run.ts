import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { serverEnvironment } from "./environment";

assert.equal(Bun.version, "1.4.3", "Bun 1.4.3 required");
const env = serverEnvironment(process.env);
const task = process.argv[2];
const commands: Record<string, string[]> = {
  migrate: ["server/scripts/migrate.ts"],
  provision: ["deploy/t02/provision-casdoor.ts"],
  start: ["deploy/t02/launch.ts", "up"],
  stop: ["deploy/t02/launch.ts", "stop"],
  persistence: ["deploy/t02/verify-persistence.ts"],
};
if (!(task in commands))
  throw new Error("Expected migrate, provision, start, stop or persistence");
const result = spawnSync(process.execPath, commands[task], {
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
