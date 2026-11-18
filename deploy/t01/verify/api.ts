import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const base = "http://localhost:13001";
function cookie(file: string) {
  assert(
    existsSync(file),
    "BLOCKED: real-browser storage state is required; no synthetic sessions",
  );
  const state = JSON.parse(readFileSync(file, "utf8"));
  return state.cookies
    .filter((c: { domain: string }) => c.domain === "localhost")
    .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
    .join("; ");
}
async function identity(
  file: string | undefined,
  expected: number,
  email?: string,
) {
  const r = await fetch(`${base}/api/me`, {
    headers: file ? { cookie: cookie(file) } : {},
  });
  assert.equal(r.status, expected);
  const j = await r.json();
  if (email) assert.equal(j.user?.email, email);
  console.log(
    JSON.stringify({
      api: "/api/me",
      status: r.status,
      ...(email ? { email } : {}),
    }),
  );
  return j.user;
}
await identity(undefined, 401);
const stage = process.argv[2];
if (stage === "login") {
  await identity(
    "deploy/t01/.runtime/browser-a-current.json",
    200,
    "a@t01.test",
  );
  await identity("deploy/t01/.runtime/browser-b.json", 200, "b@t01.test");
} else if (stage === "revoked") {
  await identity("deploy/t01/.runtime/browser-a.json", 401);
  await identity("deploy/t01/.runtime/browser-b.json", 200, "b@t01.test");
} else
  throw new Error(
    "Choose login or revoked; this script checks API/session behavior, not all acceptance criteria",
  );
console.log(
  "Selected live API/session checks passed; not a claim that AC-01 through AC-11 all pass",
);
