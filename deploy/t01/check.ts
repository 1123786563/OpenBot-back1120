import assert from "node:assert/strict";
import { loadConfig } from "../../server/src/config";
import { serverEnvironment } from "./environment";

// A real configured server is required; no stand-in keys or relaxed authentication.
const required = [
  "OKTA_OAUTH_CLIENT_ID",
  "OKTA_OAUTH_CLIENT_SECRET",
  "INTELLIGENCE_API_URL",
  "INTELLIGENCE_GATEWAY_WS_URL",
  "CPK_INTELLIGENCE_API_KEY",
];
for (const key of required)
  assert(
    process.env[key]?.trim(),
    `BLOCKED: dedicated test ${key} is required`,
  );
assert.equal(process.env.OPENBOT_SINGLE_USER, "false");
assert.equal(process.env.DEPLOYMENT_ID, "openbot-t01");
assert.equal(process.env.BETTER_AUTH_URL, "http://localhost:13001");
assert.equal(process.env.OKTA_OAUTH_ISSUER, "http://localhost:18000");
assert.equal(process.env.TRUSTED_ORIGINS, "http://localhost:13001");
for (const key of ["DATABASE_URL", "TEST_DATABASE_URL"]) {
  const value = process.env[key];
  assert.ok(value, `${key} is required`);
  const u = new URL(value);
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "55432");
  assert.equal(
    u.pathname,
    key === "DATABASE_URL" ? "/openbot_t01" : "/openbot_t01_unit",
  );
}
loadConfig(serverEnvironment(process.env));
console.log("Configuration validated (no values disclosed)");
