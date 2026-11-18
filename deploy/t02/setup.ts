import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

if (!existsSync("server/src/index.ts")) throw new Error("Run from OpenBot/");
const dir = "deploy/t02";
const file = `${dir}/.env.t02`;
if (existsSync(file))
  throw new Error(
    "Existing .env.t02 left untouched; reuse it or explicitly remove it for a new deployment.",
  );
mkdirSync(`${dir}/.runtime`, { recursive: true, mode: 0o700 });
chmodSync(`${dir}/.runtime`, 0o700);
mkdirSync(`${dir}/evidence`, { recursive: true, mode: 0o700 });
const secret = () => randomBytes(32).toString("hex");
const db = secret(),
  casdoorDb = secret();
let env = await Bun.file(`${dir}/.env.t02.example`).text();
const generated: Record<string, string> = {
  T02_DB_PASSWORD: db,
  T02_CASDOOR_DB_PASSWORD: casdoorDb,
  DATABASE_URL: `postgres://openbot_t02:${db}@127.0.0.1:56432/openbot_t02`,
  TEST_DATABASE_URL: `postgres://openbot_t02:${db}@127.0.0.1:56432/openbot_t02_unit`,
  BETTER_AUTH_SECRET: secret(),
  KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  COMPUTER_TOKEN: secret(),
  SUPERVISOR_TOKEN: secret(),
  WORKER_SHARED_SECRET: secret(),
  AGENT_TOOL_TOKEN: secret(),
};
for (const [k, v] of Object.entries(generated))
  env = env.replace(new RegExp(`^${k}=$`, "m"), `${k}=${v}`);
writeFileSync(file, env, { mode: 0o600, flag: "wx" });
writeFileSync(
  `${dir}/.runtime/app.conf`,
  `appname = casdoor
httpport = 8000
runmode = prod
copyrequestbody = true
driverName = postgres
dataSourceName = user=casdoor_t02 password=${casdoorDb} host=casdoor-db port=5432 sslmode=disable dbname=casdoor_t02
dbName = casdoor_t02
showSql = false
origin = http://localhost:19000
originFrontend = http://localhost:19000
defaultLanguage = en
isDemoMode = false
logPostOnly = true
ssrfAllowPrivateIPs = true
`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Created private T02 configuration; fill only the dedicated test IdP/Intelligence/model settings.",
);
