import { readFileSync, writeFileSync } from "node:fs";
import { assertSupplement } from "./environment";

const path = process.argv[2];
if (!path) throw new Error("Pass the authorized seven-field model env file");
const text = readFileSync(path, "utf8");
assertSupplement(text);
let env = readFileSync("deploy/t02/.env.t02", "utf8");
for (const line of text.split("\n")) {
  const match = /^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)=(.*)$/.exec(line);
  if (match)
    env = env.replace(
      new RegExp(`^${match[1]}=.*$`, "m"),
      () => `${match[1]}=${match[2]}`,
    );
}
writeFileSync("deploy/t02/.env.t02", env, { mode: 0o600 });
console.log("Loaded only authorized model fields into private T02 env");
