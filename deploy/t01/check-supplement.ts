import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { assertSupplement } from "./environment";

const file = process.argv[2];
assert(file, "Private supplement path required");
assert.equal(
  statSync(file).mode & 0o077,
  0,
  "Private supplement must not be readable by group or others",
);
assertSupplement(readFileSync(file, "utf8"));
console.log(
  "Private supplement field allowlist and permissions validated (no values output)",
);
