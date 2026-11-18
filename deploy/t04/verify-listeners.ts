import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const evidence = [];
for (const port of [14003, 19002, 56434, 18027]) {
  const output = execFileSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
    { encoding: "utf8" },
  );
  const lines = output.trim().split("\n").slice(1);
  assert(lines.length > 0, `No listener on ${port}`);
  assert(
    lines.every((line) => line.includes(`127.0.0.1:${port} (LISTEN)`)),
    `Non-loopback listener on ${port}`,
  );
  evidence.push({ port, address: "127.0.0.1", listeners: lines.length });
}
const health = await fetch("http://127.0.0.1:14003/health");
assert.equal(health.status, 200);
writeFileSync(
  "deploy/t04/evidence/listeners.json",
  JSON.stringify({ sockets: evidence, healthStatus: health.status }, null, 2) +
    "\n",
);
console.log(
  "All four live service sockets bind only 127.0.0.1; API health 200",
);
