import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { serverEnvironment } from "./environment";

assert.ok(/^1\./.test(Bun.version), `Bun 1.x required, got ${Bun.version}`);
const env = serverEnvironment(process.env);
const result = spawnSync(
  "docker-compose",
  [
    "compose",
    "-p",
    "openbot-t03",
    "--env-file",
    "deploy/t03/.env.t03",
    "-f",
    "deploy/t03/docker-compose.t02.yml",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "openbot_t03",
    "-d",
    "openbot_t03",
    "-c",
    "CREATE DATABASE openbot_t03_unit",
  ],
  { encoding: "utf8", env },
);
if (result.status !== 0 && !result.stderr.includes("already exists"))
  throw new Error("Could not create isolated test database");
const migration = spawnSync(process.execPath, ["server/scripts/migrate.ts"], {
  env: { ...env, DATABASE_URL: env.TEST_DATABASE_URL },
  stdio: "inherit",
});
process.exit(migration.status ?? 1);
