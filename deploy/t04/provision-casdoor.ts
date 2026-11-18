import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

assert.equal(process.env.DEPLOYMENT_ID, "openbot-t04");
assert.equal(process.env.CASDOOR_OAUTH_ISSUER, "http://localhost:19002");
const compose = [
  "-p",
  "openbot-t04",
  "--env-file",
  "deploy/t04/.env.t04",
  "-f",
  "deploy/t04/docker-compose.t04.yml",
];
// Bootstrap only this newly created test IdP; do not connect to an operator's existing IdP.
const credentials = JSON.parse(
  execFileSync(
    "docker-compose",
    [
      ...compose,
      "exec",
      "-T",
      "casdoor-db",
      "psql",
      "-U",
      "casdoor_t04",
      "-d",
      "casdoor_t04",
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
  const r = await fetch(`http://localhost:19002/api/${path}`, {
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
if (!(await api("get-organization?id=admin/openbot-t04")))
  await api("add-organization", {
    owner: "admin",
    name: "openbot-t04",
    displayName: "OpenBot T04",
    passwordType: "bcrypt",
    passwordOptions: ["AtLeast6"],
    languages: ["en"],
    countryCodes: ["US"],
  });
let app = await api("get-application?id=admin/app-t04");
if (!app) {
  const base = await api("get-application?id=admin/app-built-in");
  app = {
    ...base,
    name: "app-t04",
    displayName: "OpenBot T04",
    organization: "openbot-t04",
    clientId: "t04-openbot",
    clientSecret: randomBytes(32).toString("hex"),
    redirectUris: ["http://localhost:14003/api/auth/callback/casdoor"],
    grantTypes: ["authorization_code"],
    tokenFormat: "JWT",
    tokenSigningMethod: "RS256",
    enableCustomScript: false,
    enableSignUp: true,
    // Signup must not sign the new person in: a T04 identity has to exist at Casdoor while
    // OpenBot has never seen it, so the first OAuth callback can be raced or broken on purpose.
    enableAutoSignin: false,
  };
  await api("add-application", app);
}
assert.equal(app.clientId, "t04-openbot");
assert.deepEqual(app.redirectUris, [
  "http://localhost:14003/api/auth/callback/casdoor",
]);
const smtp = {
  owner: "admin",
  name: "mail-t04",
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
if (!(await api("get-provider?id=admin/mail-t04")))
  await api("add-provider", smtp);
app.homepageUrl = "http://localhost:14003";
app.signinUrl = "http://localhost:19002/login/app-t04";
app.providers = [
  { name: "mail-t04", canSignUp: true, canSignIn: true, canUnlink: false },
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
await api("update-application?id=admin/app-t04", app);
const envPath = "deploy/t04/.env.t04";
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
