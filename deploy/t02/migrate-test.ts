import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { serverEnvironment } from "./environment";

assert.equal(Bun.version, "1.4.3");
const env = serverEnvironment(process.env);
const result = spawnSync(
  "docker",
  [
    "compose",
    "-p",
    "openbot-t02",
    "--env-file",
    "deploy/t02/.env.t02",
    "-f",
    "deploy/t02/docker-compose.t02.yml",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "openbot_t02",
    "-d",
    "openbot_t02",
    "-c",
    "CREATE DATABASE openbot_t02_unit",
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
