import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

assert.equal(process.env.DEPLOYMENT_ID, "openbot-t02");
assert.equal(process.env.CASDOOR_OAUTH_ISSUER, "http://localhost:19000");
const compose = [
  "compose",
  "-p",
  "openbot-t02",
  "--env-file",
  "deploy/t02/.env.t02",
  "-f",
  "deploy/t02/docker-compose.t02.yml",
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
      "casdoor_t02",
      "-d",
      "casdoor_t02",
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
  const r = await fetch(`http://localhost:19000/api/${path}`, {
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
if (!(await api("get-organization?id=admin/openbot-t02")))
  await api("add-organization", {
    owner: "admin",
    name: "openbot-t02",
    displayName: "OpenBot T02",
    passwordType: "bcrypt",
    passwordOptions: ["AtLeast6"],
    languages: ["en"],
    countryCodes: ["US"],
  });
let app = await api("get-application?id=admin/app-t02");
if (!app) {
  const base = await api("get-application?id=admin/app-built-in");
  app = {
    ...base,
    name: "app-t02",
    displayName: "OpenBot T02",
    organization: "openbot-t02",
    clientId: "t02-openbot",
    clientSecret: randomBytes(32).toString("hex"),
    redirectUris: ["http://localhost:14001/api/auth/callback/casdoor"],
    grantTypes: ["authorization_code"],
    tokenFormat: "JWT",
    tokenSigningMethod: "RS256",
    enableCustomScript: false,
    enableSignUp: true,
  };
  await api("add-application", app);
}
assert.equal(app.clientId, "t02-openbot");
assert.deepEqual(app.redirectUris, [
  "http://localhost:14001/api/auth/callback/casdoor",
]);
const smtp = {
  owner: "admin",
  name: "mail-t02",
  displayName: "Local Mailpit",
  category: "Email",
  type: "SMTP",
  host: "mailpit",
  port: 1025,
  disableSsl: true,
  sslMode: "None",
  clientId: "noreply@openbot.test",
  title: "OpenBot verification",
  content: "Your verification code is %s",
};
if (!(await api("get-provider?id=admin/mail-t02")))
  await api("add-provider", smtp);
app.homepageUrl = "http://localhost:14001";
app.signinUrl = "http://localhost:19000/login/app-t02";
app.providers = [
  { name: "mail-t02", canSignUp: true, canSignIn: true, canUnlink: false },
];
app.signupItems = app.signupItems
  .filter((item: { name: string }) =>
    [
      "ID",
      "Username",
      "Display name",
      "Password",
      "Confirm password",
      "Email",
    ].includes(item.name),
  )
  .map((item: { name: string; rule: string }) => ({
    ...item,
    ...(item.name === "Email" ? { rule: "No verification" } : {}),
  }));
await api("update-application?id=admin/app-t02", app);
const envPath = "deploy/t02/.env.t02";
let env = readFileSync(envPath, "utf8");
for (const [key, value] of [
  ["CASDOOR_OAUTH_CLIENT_ID", app.clientId],
  ["CASDOOR_OAUTH_CLIENT_SECRET", app.clientSecret],
])
  env = env.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
writeFileSync(envPath, env, { mode: 0o600 });
console.log(
  "Dedicated public Casdoor application ready; no test identities provisioned",
);
