import assert from "node:assert/strict";
const dir = "deploy/t01/.runtime/";
const proof = await Bun.file(`${dir}sideeffect-cancel-result.json`).json();
assert.equal(proof.passed, true);
const s = await Bun.file(`${dir}browser-b.json`).json();
const cookie = s.cookies
  .filter((c: { domain: string }) => c.domain === "localhost")
  .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
  .join("; ");
async function api(path: string) {
  const r = await fetch(`http://localhost:13001${path}`, {
    headers: { cookie },
  });
  assert.equal(r.status, 200);
  return r.json();
}
const me = await api("/api/me");
const container = `openbot-t01-computer-person-${me.user.id}`;
const started = Date.now();
const samples = [];
for (let i = 0; i < 31; i++) {
  const p = Bun.spawn(
    [
      "docker",
      "exec",
      container,
      "sh",
      "-c",
      `wc -l < ${proof.marker}; p=$(cat ${proof.marker}.pid); if kill -0 "$p" 2>/dev/null; then echo alive; else echo gone; fi`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(p.stdout).text()).trim().split("\n");
  await new Response(p.stderr).text();
  assert.equal(await p.exited, 0);
  assert.equal(Number(out[0]), proof.containerObserved.finalLines);
  assert.equal(out[1], "gone");
  const routine = (await api("/api/routines")).routines.find(
    (r: { id: string }) => r.id === proof.routineId,
  );
  const runs = (await api(`/api/routines/${proof.routineId}/runs`)).runs;
  assert.equal(routine.enabled, false);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "cancelled");
  samples.push({
    t: Date.now() - started,
    lines: Number(out[0]),
    process: "gone",
    enabled: false,
    runs: runs.length,
    status: runs[0].status,
  });
  if (i < 30) await Bun.sleep(2000);
}
assert.ok(Date.now() - started >= 60000);
await Bun.write(
  `${dir}cancel-restart-result.json`,
  JSON.stringify(
    { passed: true, routineId: proof.routineId, samples },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    passed: true,
    samples: samples.length,
    durationMs: Date.now() - started,
  }),
);
