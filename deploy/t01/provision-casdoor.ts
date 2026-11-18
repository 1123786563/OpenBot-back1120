import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

assert.equal(process.env.DEPLOYMENT_ID, "openbot-t01");
assert.equal(process.env.OKTA_OAUTH_ISSUER, "http://localhost:18000");
const compose = [
  "compose",
  "-p",
  "openbot-t01",
  "--env-file",
  "deploy/t01/.env.t01",
  "-f",
  "deploy/t01/docker-compose.t01.yml",
];
// Bootstrap only this newly created test IdP; do not connect to an operator's existing IdP.
const credentials = JSON.parse(
  execFileSync(
    "docker",
    [
      ...compose,
      "exec",
      "-T",
      "casdoor-db",
      "psql",
      "-U",
      "casdoor_t01",
      "-d",
      "casdoor_t01",
      "-Atc",
      `select json_build_object('clientId',client_id,'clientSecret',client_secret) from application where owner='admin' and name='app-built-in'`,
    ],
    { encoding: "utf8" },
  ).trim(),
);
const headers = {
  Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`,
  "Content-Type": "application/json",
};
async function api(path: string, body?: unknown) {
  const r = await fetch(`http://localhost:18000/api/${path}`, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  assert(
    r.ok && j.status === "ok",
    `Casdoor API failed at ${path.split("?")[0]} (details withheld)`,
  );
  return j.data;
}
if (!(await api("get-organization?id=admin/openbot-t01")))
  await api("add-organization", {
    owner: "admin",
    name: "openbot-t01",
    displayName: "OpenBot T01",
    passwordType: "bcrypt",
    passwordOptions: ["AtLeast6"],
    languages: ["en"],
    countryCodes: ["US"],
  });
let app = await api("get-application?id=admin/app-t01");
if (!app) {
  const base = await api("get-application?id=admin/app-built-in");
  app = {
    ...base,
    name: "app-t01",
    displayName: "OpenBot T01",
    organization: "openbot-t01",
    clientId: "t01-openbot",
    clientSecret: randomBytes(32).toString("hex"),
    redirectUris: ["http://localhost:13001/api/auth/callback/okta"],
    grantTypes: ["authorization_code"],
    tokenFormat: "JWT",
    tokenSigningMethod: "RS256",
    enableCustomScript: false,
    enableSignUp: false,
  };
  await api("add-application", app);
}
assert.equal(app.clientId, "t01-openbot");
assert.deepEqual(app.redirectUris, [
  "http://localhost:13001/api/auth/callback/okta",
]);
const file = "deploy/t01/.runtime/casdoor-users";
const passwords: Record<string, string> = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : {};
for (const [name, email] of [
  ["a", "a@t01.test"],
  ["b", "b@t01.test"],
  ["denied", "x@other.test"],
]) {
  const user = await api(`get-user?id=openbot-t01/${name}`);
  if (user) {
    assert.equal(user.email, email);
    assert(
      passwords[name],
      "Existing test user password is not retained; explicit operator reset required",
    );
    continue;
  }
  const password = `T01!${randomBytes(24).toString("hex")}`;
  await api("add-user", {
    owner: "openbot-t01",
    name,
    displayName: name.toUpperCase(),
    email,
    emailVerified: true,
    type: "normal-user",
    password,
    isAdmin: false,
    signupApplication: "app-t01",
  });
  passwords[name] = password;
  writeFileSync(file, JSON.stringify(passwords), { mode: 0o600 });
}
const envPath = "deploy/t01/.env.t01";
let env = readFileSync(envPath, "utf8");
for (const [key, value] of [
  ["OKTA_OAUTH_CLIENT_ID", app.clientId],
  ["OKTA_OAUTH_CLIENT_SECRET", app.clientSecret],
])
  env = env.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
writeFileSync(envPath, env, { mode: 0o600 });
console.log(
  "Dedicated Casdoor application and A/B/denied test identities ready; credentials kept private",
);
