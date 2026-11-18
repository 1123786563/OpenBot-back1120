import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

if (!existsSync("server/src/index.ts")) throw new Error("Run from OpenBot/");
const dir = "deploy/t01";
const file = `${dir}/.env.t01`;
if (existsSync(file))
  throw new Error(
    "Existing .env.t01 left untouched; reuse it or explicitly remove it for a new deployment.",
  );
mkdirSync(`${dir}/.runtime`, { recursive: true, mode: 0o700 });
const secret = () => randomBytes(32).toString("hex");
const db = secret(),
  casdoorDb = secret();
let env = await Bun.file(`${dir}/.env.t01.example`).text();
const generated: Record<string, string> = {
  T01_DB_PASSWORD: db,
  T01_CASDOOR_DB_PASSWORD: casdoorDb,
  DATABASE_URL: `postgres://openbot_t01:${db}@127.0.0.1:55432/openbot_t01`,
  TEST_DATABASE_URL: `postgres://openbot_t01:${db}@127.0.0.1:55432/openbot_t01_unit`,
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
dataSourceName = user=casdoor_t01 password=${casdoorDb} host=casdoor-db port=5432 sslmode=disable dbname=casdoor_t01
dbName = casdoor_t01
showSql = false
origin = http://localhost:18000
originFrontend = http://localhost:18000
defaultLanguage = en
isDemoMode = false
logPostOnly = true
`,
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Created private T01 configuration; fill only the dedicated test IdP/Intelligence/model settings.",
);
