import assert from "node:assert/strict";
import { z } from "../../../server/node_modules/zod";

// Resolve the observer from a real session on every invocation, including restart.
export async function resolveObserver() {
  const state = z
    .object({
      cookies: z.array(
        z.object({
          domain: z.string(),
          name: z.string(),
          value: z.string(),
        }),
      ),
    })
    .parse(
      await Bun.file(
        process.env.T01_B_STATE ?? "deploy/t01/.runtime/browser-b.json",
      ).json(),
    );
  const response = await fetch("http://localhost:13001/api/me", {
    headers: {
      cookie: state.cookies
        .filter((c) => c.domain === "localhost")
        .map((c) => `${c.name}=${c.value}`)
        .join("; "),
    },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, "B session must be valid");
  const { user } = z
    .object({
      user: z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        email: z.string(),
      }),
    })
    .parse(await response.json());
  assert.equal(
    user.email,
    process.env.T01_B_EMAIL ?? "b@t01.test",
    "Unexpected observer identity",
  );
  const container = `openbot-t01-computer-person-${user.id}`;
  const child = Bun.spawn(
    ["docker", "inspect", "--format", "{{json .}}", container],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(await child.exited, 0, "Current B container must exist");
  const inspected = z
    .object({
      Id: z.string(),
      Config: z.object({
        Labels: z.record(z.string(), z.string()),
      }),
      State: z.object({ Running: z.boolean() }),
    })
    .parse(JSON.parse(out));
  assert.equal(inspected.Config.Labels["openbot.namespace"], "openbot-t01");
  assert.equal(inspected.Config.Labels["openbot.supervisor"], "true");
  assert.equal(inspected.Config.Labels["openbot.computer-kind"], "person");
  assert.equal(inspected.Config.Labels["openbot.person-id"], user.id);
  assert.equal(inspected.State.Running, true, "Current B must be running");
  return {
    userId: user.id,
    email: user.email,
    container,
    dockerId: inspected.Id,
  };
}

if (import.meta.main) console.log((await resolveObserver()).container);
