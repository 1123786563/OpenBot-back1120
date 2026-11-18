import assert from "node:assert/strict";
import { chmodSync, rmSync } from "node:fs";
import { resolveObserver } from "./control-target";
const root = "deploy/t01/.runtime/";
const base = "http://localhost:13001";
rmSync(root + "control-replay-ready", { force: true });
rmSync(root + "control-replay-restarted", { force: true });
const state = await Bun.file(root + "browser-a-current.json").json();
const cookie = state.cookies
  .filter((c: { domain: string }) => c.domain === "localhost")
  .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
  .join("; ");
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}
const me = await api("/api/me");
assert.equal(me.status, 200);
assert.equal(me.body.user.email, "a@t01.test");
const container = `openbot-t01-computer-person-${me.body.user.id}`;
const observer = await resolveObserver();
assert.notEqual(observer.userId, me.body.user.id, "A and B must be distinct");
const other = observer.container;
async function docker(...args: string[]) {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await new Response(p.stderr).text();
  assert.equal(await p.exited, 0, "docker observation failed");
  return out.trim();
}
async function running(name: string) {
  return JSON.parse(
    await docker("inspect", "--format", "{{json .State}}", name),
  );
}
const marker = `t01-control-${Date.now()}`;
const file = `/workspace/computers/general-assistant/${marker}`;
const help = await api(
  "/api/computers/general-assistant/control/request",
  "POST",
  { source: "manual", reason: "T01 old control replay verification" },
);
assert.equal(help.status, 200, JSON.stringify(help));
assert.ok(help.body.request?.id);
assert.equal(
  (
    await api("/api/computers/general-assistant/control/take", "POST", {
      requestId: help.body.request.id,
    })
  ).status,
  200,
);
let ready = false;
let closedAt: number | null = null;
const socket = new WebSocket(
  "ws://localhost:13001/api/computers/general-assistant/terminal",
  { headers: { cookie, origin: base } },
);
socket.onmessage = (event) => {
  if (typeof event.data === "string" && event.data.includes('"type":"ready"'))
    ready = true;
};
socket.onclose = () => {
  closedAt = Date.now();
};
socket.onerror = () => {};
for (let n = 0; n < 100 && !ready; n++) await Bun.sleep(200);
assert.ok(ready, "real terminal must be ready");
socket.send(
  JSON.stringify({ type: "input", data: `printf before > ${file}\r` }),
);
await Bun.sleep(1500);
assert.equal(
  await docker("exec", container, "cat", file),
  "before",
  "original socket must actually control the computer",
);
const stopAt = Date.now();
const stopped = await api("/api/computers/fleet", "POST", {
  action: "stop",
  computer: `person:${me.body.user.id}`,
});
assert.equal(stopped.status, 200);
assert.equal(stopped.body.wasRunning, true);
for (let n = 0; n < 100 && closedAt === null; n++) await Bun.sleep(100);
assert.ok(closedAt !== null, "stop must close the existing control socket");
const replays: Array<{ stage: string; state: number; threw: boolean }> = [];
function replay(stage: string) {
  let threw = false;
  try {
    socket.send(
      JSON.stringify({ type: "input", data: `printf replay >> ${file}\r` }),
    );
  } catch {
    threw = true;
  }
  replays.push({ stage, state: socket.readyState, threw });
  assert.equal(socket.readyState, WebSocket.CLOSED);
}
replay("after-stop");
// Reconnect with the exact old credential after withdrawing its authorization.
const revoked = await api(
  `/api/admin/enterprise/people/${me.body.user.id}/revoke-sessions`,
  "POST",
);
assert.equal(revoked.status, 200);
assert.ok(revoked.body.ended >= 1);
await Bun.write(root + "control-replay-old-state.json", JSON.stringify(state));
chmodSync(root + "control-replay-old-state.json", 0o600);
async function handshake() {
  const r = await fetch(base + "/api/computers/general-assistant/terminal", {
    headers: {
      cookie,
      origin: base,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });
  await r.text();
  assert.equal(
    r.status,
    401,
    "old credential handshake must be rejected before locate/ensure",
  );
  return r.status;
}
const rejectedBefore = await handshake();
const samples: unknown[] = [];
async function observe(seconds: number) {
  const at = Date.now();
  for (let n = 0; n <= seconds / 2; n++) {
    const a = await running(container),
      b = await running(other);
    assert.equal(a.Running, false);
    assert.equal(a.Pid, 0);
    assert.equal(b.Running, true);
    samples.push({
      t: Date.now() - stopAt,
      aRunning: a.Running,
      aPid: a.Pid,
      bRunning: b.Running,
    });
    if (n < seconds / 2) await Bun.sleep(2000);
  }
  assert.ok(Date.now() - at >= seconds * 1000);
}
await observe(60);
rmSync(root + "control-replay-restarted", { force: true });
await Bun.write(root + "control-replay-ready", "ready");
console.log(
  "Stopped socket closed; old send and revoked handshake refused; 60 seconds stable. Ready for dedicated stack restart.",
);
for (
  let n = 0;
  n < 600 && !(await Bun.file(root + "control-replay-restarted").exists());
  n++
)
  await Bun.sleep(1000);
assert.ok(
  await Bun.file(root + "control-replay-restarted").exists(),
  "restart confirmation missing",
);
replay("after-restart");
const rejectedAfter = await handshake();
assert.equal((await api("/api/me")).status, 401);
await observe(60);
// Read persisted file via docker cp without starting the stopped computer.
const dest = root + marker;
await docker("cp", `${container}:${file}`, dest);
assert.equal(
  await Bun.file(dest).text(),
  "before",
  "replayed input must produce no side effect",
);
const result = {
  passed: true,
  container,
  observer,
  stopMs: closedAt! - stopAt,
  replays,
  rejectedBefore,
  rejectedAfter,
  persistedContents: "before",
  samples,
};
await Bun.write(
  root + "control-replay-result.json",
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    passed: true,
    stopMs: result.stopMs,
    replays,
    rejectedBefore,
    rejectedAfter,
    sampleCount: samples.length,
  }),
);
