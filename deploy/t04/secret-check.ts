import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const env = parseEnv(readFileSync("deploy/t04/.env.t04", "utf8"));
const values = Object.entries(env)
  .filter(
    ([key, value]) =>
      /PASSWORD|SECRET|TOKEN|KEY$/.test(key) && value.length >= 12,
  )
  .map(([, value]) => value);
assert(values.length > 5, "Expected private configuration to check");
const source = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? files(`${directory}/${item.name}`)
      : [`${directory}/${item.name}`],
  );
}
const targets = [...source, ...files("app/dist"), "../../implementation.md"];
for (const file of targets) {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  assert(
    !values.some((value) => contents.includes(value)),
    `Runtime secret appeared in ${file}`,
  );
}
console.log(
  "No private T04 configuration values found in source, Web build or implementation report",
);
