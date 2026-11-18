// T01 live probe: prove routine cancellation stops REAL tool execution in the owner's computer,
// observed from inside the container (docker exec), independent of the OpenBot database.
// 1. create a routine whose instruction makes the Bot run a long shell loop via computer_run_command
// 2. wait until the side-effect file is genuinely growing in the container
// 3. cancel the run through the public API
// 4. watch the file line count and the loop process from inside the container
import assert from "node:assert/strict";

const state = await Bun.file("deploy/t01/.runtime/browser-b.json").json();
const cookie = state.cookies
  .filter((c: { domain: string }) => c.domain === "localhost")
  .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
  .join("; ");
const base = "http://localhost:13001";
let CONTAINER: string;
const marker = `t01-cancel-${Date.now()}`;
const FILE = `/workspace/computers/general-assistant/${marker}.log`;
const PIDFILE = `${FILE}.pid`;

async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { cookie, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  return { status: r.status, j: await r.json().catch(() => null) };
}

type Shell = { ok: boolean; out: string; err: string };
async function docker(args: string): Promise<Shell> {
  const p = Bun.spawn(["docker", "exec", CONTAINER, "sh", "-c", args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { ok: (await p.exited) === 0, out: out.trim(), err: err.trim() };
}

const lines = async () => {
  const r = await docker(`wc -l < ${FILE} 2>/dev/null || echo 0`);
  return Number(r.out || 0);
};
const loopProcs = async () => {
  const r = await docker(
    `p=$(cat ${PIDFILE}) || exit 1; if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo 1; else echo 0; fi`,
  );
  assert.ok(r.ok && /^[01]$/.test(r.out), "PID observation unavailable");
  return Number(r.out);
};

const me = await api("/api/me");
assert.equal(me.status, 200, "B session must be valid");
assert.equal(me.j.user.email, "b@t01.test");
CONTAINER = `openbot-t01-computer-person-${me.j.user.id}`;
console.log("[1] B authenticated:", me.j?.email ?? me.j?.user?.email);

// Reuse a real channel if available; a fresh environment creates one through the public API.
const existing = ((await api("/api/routines")).j?.routines ?? []).find(
  (r: { channel?: { id: string } }) => r.channel?.id,
);
const channel = existing
  ? null
  : await api("/api/channels", "POST", { agentIds: ["general-assistant"] });
if (channel) assert.equal(channel.status, 201);
const channelId: string = existing?.channel.id ?? channel?.j.channel.id;
assert.ok(channelId);

const instruction =
  `Run this shell command on your computer with the computer_run_command tool, exactly as written, and nothing else first: ` +
  `(echo $BASHPID > ${PIDFILE}; for i in $(seq 1 240); do printf '%s %s\\n' "$i" "$(date +%s)" >> ${FILE}; sleep 1; done) ; ` +
  `After it finishes, reply with the number of lines ${FILE} has.`;

const created = await api("/api/routines", "POST", {
  agentId: "general-assistant",
  title: "T01 cancel side-effect",
  instruction,
  cron: "0 0 1 1 *",
  channelId,
});
assert.equal(
  created.status,
  201,
  `routine create failed: ${JSON.stringify(created)}`,
);
const routineId: string = created.j.routine.id;
console.log("[2] routine created:", routineId);

// Clean slate inside the container.
await docker(`rm -f ${FILE}`);
assert.equal(await lines(), 0, "proof file must start empty");

const start = await api(`/api/routines/${routineId}/run`, "POST");
assert.equal(
  start.status,
  202,
  `run dispatch failed: ${JSON.stringify(start)}`,
);
const runId: string = start.j.runId;
console.log("[3] run dispatched:", runId);

// Phase A: wait until the side effect is genuinely running in the container.
let growth: { at: number; lines: number } | null = null;
const dispatchAt = Date.now();
let last = 0;
for (let i = 0; i < 90 && !growth; i++) {
  await Bun.sleep(2000);
  const n = await lines();
  if (n > last && n >= 2 && last > 0) growth = { at: Date.now(), lines: n };
  last = n;
  if (i % 5 === 0)
    console.log(
      `    t+${Math.round((Date.now() - dispatchAt) / 1000)}s lines=${n}`,
    );
}
assert.ok(growth, `side effect never started in the container (lines=${last})`);
assert.equal(
  await loopProcs(),
  1,
  "recorded execution PID must be alive before cancellation",
);
console.log(
  `[4] real execution observed in container: ${growth.lines} lines, loop processes=${await loopProcs()}`,
);

// Phase B: cancel through the public API.
const cancelAt = Date.now();
const cancel = await api(
  `/api/routines/${routineId}/runs/${runId}/cancel`,
  "POST",
);
assert.equal(cancel.status, 202, `cancel failed: ${JSON.stringify(cancel)}`);
console.log("[5] cancel accepted at", new Date(cancelAt).toISOString());

// Phase C: independent observation — the file must stop growing and the loop must die.
const samples: Array<{ t: number; lines: number; procs: number }> = [];
let settledAt: number | null = null;
let prev = growth.lines;
for (let i = 0; i < 65; i++) {
  await Bun.sleep(1000);
  const [n, procs] = [await lines(), await loopProcs()];
  samples.push({ t: Date.now() - cancelAt, lines: n, procs });
  if (settledAt === null && i >= 3) {
    const recent = samples.slice(-4).map((s) => s.lines);
    if (recent.every((v) => v === recent[0])) settledAt = recent[0];
  }
  if (n !== prev) prev = n;
  if (i % 5 === 0)
    console.log(`    t+${samples.at(-1)!.t / 1000}s lines=${n} procs=${procs}`);
}
const finalLines = (await lines()) ?? 0;
const finalProcs = await loopProcs();
assert.ok(samples.at(-1)!.t >= 60000, "observe at least 60 seconds");
const stopMs =
  settledAt === null
    ? null
    : (samples.find((s) => s.lines === settledAt && s.t > 3000)?.t ?? null);
const lastGrowthMs = samples.reduce(
  (acc, s, i) => (i > 0 && s.lines > samples[i - 1].lines ? s.t : acc),
  0,
);

// Run row + post-cancel observations through the API (secondary evidence).
const runs = (await api(`/api/routines/${routineId}/runs`)).j?.runs ?? [];
const run = runs.find((r: { id: string }) => r.id === runId);

const routine = ((await api("/api/routines")).j?.routines ?? []).find(
  (r: { id: string }) => r.id === routineId,
);
const result = {
  passed:
    run?.status === "cancelled" &&
    finalProcs === 0 &&
    lastGrowthMs <= 6000 &&
    !routine?.enabled &&
    runs.length === 1,
  marker: FILE,
  routineEnabled: routine?.enabled,
  container: CONTAINER,
  routineId,
  runId,
  containerObserved: {
    growthStartedAtLines: growth.lines,
    lastGrowthMsAfterCancel: lastGrowthMs,
    finalLines,
    finalLoopProcesses: finalProcs,
    stoppedGrowingWithinMs: stopMs,
    samples: samples.filter((_, i) => i % 2 === 0),
  },
  apiObserved: {
    runStatus: run?.status ?? null,
    runError: run?.error ?? null,
    totalRuns: runs.length,
  },
};
await Bun.write(
  "deploy/t01/.runtime/sideeffect-cancel-result.json",
  JSON.stringify(result, null, 2),
);
console.log("[6] RESULT", JSON.stringify(result.containerObserved));
console.log("[7] API run row:", JSON.stringify(result.apiObserved));

// Verdicts
assert.equal(result.passed, true, "all observable cancellation requirements");
assert.equal(run?.status, "cancelled", "run must end cancelled");
assert.equal(finalProcs, 0, "the loop process must be gone from the container");
assert.ok(
  lastGrowthMs <= 6000,
  `file kept growing until ${lastGrowthMs}ms after cancel — abort did not reach real execution`,
);
console.log(
  "[OK] cancellation stopped real in-container execution, observed independently of the DB",
);
