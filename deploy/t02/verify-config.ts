import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { serverEnvironment } from "./environment";

const env = serverEnvironment(process.env);
const conflicts = [
  { key: "OPENBOT_SINGLE_USER", values: { OPENBOT_SINGLE_USER: "true" } },
  {
    key: "INITIAL_ADMIN_EMAILS",
    values: { INITIAL_ADMIN_EMAILS: "test@gmail.com" },
  },
  {
    key: "OPENBOT_ORGANIZATION_AUTH_URL",
    values: { OPENBOT_ORGANIZATION_AUTH_URL: "http://localhost:19000" },
  },
  {
    key: "GOOGLE_OAUTH_CLIENT_ID",
    values: {
      GOOGLE_OAUTH_CLIENT_ID: "forbidden",
      GOOGLE_OAUTH_CLIENT_SECRET: "forbidden",
    },
  },
];
const evidence = [];
for (const conflict of conflicts) {
  const child = spawnSync(
    process.execPath,
    ["server/src/production-entry.ts"],
    { env: { ...env, ...conflict.values }, encoding: "utf8", timeout: 10000 },
  );
  assert(
    child.status !== null && child.status !== 0,
    `Expected startup rejection for ${conflict.key}`,
  );
  assert(
    child.stderr.includes("Casdoor") && child.stderr.includes(conflict.key),
    `Expected explicit conflict for ${conflict.key}`,
  );
  assert(!child.stdout.includes("OpenBot server listening"));
  evidence.push({
    key: conflict.key,
    exitCode: child.status,
    rejectedBeforeListen: true,
  });
}
writeFileSync(
  "deploy/t02/evidence/configuration.json",
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
  "All four real startup conflict processes refused before listening",
);
