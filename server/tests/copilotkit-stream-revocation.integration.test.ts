import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createApp } from "../src/app";
import type { AuthenticatedActor } from "../src/auth/guards";
import { createSessionGate, type SessionGate } from "../src/auth/session-gate";
import type { BusinessAccess } from "../src/auth/business-access";
import { createDatabase } from "../src/db/client";
import { personalOrganizations, sessions, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The CopilotKit response stream answers to its session for as long as it is being written.
 *
 * The route guards prove the session once, at the request. A stream — a model turn above all —
 * was authorized once and then trickles; if only the guard's return value were wrapped, the
 * authenticated body would never see the gate at all (a successful guard returns `undefined`,
 * having already handed its answer to `context.res`), and a person who signed out mid-turn would
 * go on receiving every token after it. The gate reads the `sessions` table sign-out deletes from,
 * so the check is the same on every replica and no announcement delay can leave a window.
 *
 * The route here is the one `createApp` actually mounts for `/api/copilotkit/*` in Casdoor mode —
 * the same `requireUser` guard, the same wrapper, reached through the real application — with a
 * stand-in CopilotKit runtime behind it that streams chunks slowly enough for a sign-out to land
 * mid-stream. The session is a real row in the shared `sessions` table.
 */

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);

const suite = `t04-stream-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];

/** How many times a gate was asked before a chunk was sent: zero means nothing was wrapped. */
function countingGate(): SessionGate & { asks: number } {
  const inner = createSessionGate(database);
  let asks = 0;
  const gate = {
    get asks() {
      return asks;
    },
    revoke: (sessionId: string) => inner.revoke(sessionId),
    maySend: async (sessionId: string | undefined) => {
      asks += 1;
      return inner.maySend(sessionId);
    },
  };
  return gate as SessionGate & { asks: number };
}

async function person(): Promise<string> {
  const id = `${suite}-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, emailVerified: true });
  await database.insert(personalOrganizations).values({
    id: randomUUID(),
    ownerUserId: id,
    name: "space",
  });
  createdUserIds.push(id);
  return id;
}

async function signedIn(userId: string): Promise<string> {
  const id = `sess-${randomUUID()}`;
  await database.insert(sessions).values({
    id,
    userId,
    token: `tok-${id}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    activeOrganizationId: (
      await database
        .select({ id: personalOrganizations.id })
        .from(personalOrganizations)
        .where(eq(personalOrganizations.ownerUserId, userId))
        .limit(1)
    )[0]?.id,
  });
  createdSessionIds.push(id);
  return id;
}

function businessAccessFor(headers: Headers): Promise<BusinessAccess> {
  const sessionId = headers.get("x-test-session");
  if (!sessionId) return Promise.resolve({ kind: "anonymous" });
  return (async () => {
    const [row] = await database
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return { kind: "anonymous" };
    const actor: AuthenticatedActor = {
      id: row.userId,
      email: `${row.userId}@example.test`,
      role: "user",
      workspaceId: row.activeOrganizationId ?? undefined,
      sessionId: row.id,
    };
    return { kind: "ready", actor };
  })();
}

/**
 * The stand-in runtime: POST streams four chunks, one every 40 ms — slowly enough that a sign-out
 * can land between the first and the last. `createApp` mounts the CopilotKit runtime at the ROOT
 * with the handler carrying its own basePath, so this one answers `/api/copilotkit` itself.
 */
function streamingCopilotHandler(): Hono {
  const handler = new Hono<{ Variables: { actor: AuthenticatedActor } }>();
  handler.post("/api/copilotkit", async (context) => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (let index = 0; index < 4; index += 1) {
          controller.enqueue(
            encoder.encode(`chunk-${index};actor=${context.var.actor.id}\n`),
          );
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  return handler;
}

function appWith(gate: SessionGate): { app: Hono } {
  const app = createApp(
    {
      recorder: { extraExtensionIds: [] },
      singleUser: false,
      // The Casdoor mode is what mounts the guarded middleware under test.
      auth: { casdoor: { issuer: "https://casdoor.test" } },
    } as never,
    {
      handler: async () => new Response(null, { status: 204 }),
      api: { getSession: async () => null },
      resolveBusinessAccess: businessAccessFor,
    } as never,
    { rolesForUser: async () => ["user"] },
    // auditReader, credentialService, packageStatusReader — then the CopilotKit endpoint itself.
    ...(Array.from({ length: 3 }) as never[]),
    streamingCopilotHandler(),
    // computerGateway .. profileStore — everything between the runtime and the tail.
    ...(Array.from({ length: 32 }) as never[]),
    // onSessionEnded, Alipay inbox, and billing catalog are unused in this fixture.
    undefined,
    undefined,
    undefined,
    gate,
  );
  return { app };
}

afterAll(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await database.delete(sessions).where(eq(sessions.id, id));
  }
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

describe("the mounted CopilotKit stream answers to its session", () => {
  test("sign-out mid-stream stops the chunks; another live session keeps streaming", async () => {
    const gate = countingGate();
    const { app } = appWith(gate);

    const userId = await person();
    const dyingSession = await signedIn(userId);
    const livingSession = await signedIn(userId);

    // An authenticated streaming request, through the real mounted middleware.
    const dying = await app.fetch(
      new Request("http://openbot.test/api/copilotkit", {
        method: "POST",
        headers: { "x-test-session": dyingSession },
      }),
    );
    expect(dying.status).toBe(200);

    const reader = dying.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("chunk-0");

    // THE SIGN-OUT, on the replica that handles it: the session row is deleted. The gate reads
    // this same table before every chunk, so no other replica needs telling.
    await database.delete(sessions).where(eq(sessions.id, dyingSession));

    // The next chunk is refused and the STREAM ENDS, not pauses: read rejects.
    let outcome = "kept-streaming";
    try {
      for (let index = 0; index < 6; index += 1) {
        const next = await reader.read();
        if (next.done) {
          outcome = "closed";
          break;
        }
        outcome = `received:${decoder.decode(next.value)}`;
      }
    } catch {
      outcome = "refused";
    }
    expect(outcome).toBe("refused");
    // The wrapper ran — the body was gated, not passed through.
    expect(gate.asks).toBeGreaterThan(0);

    // THE POSITIVE CONTROL: another session of the SAME person, live in the same table, streams
    // to the end. The revocation was one session's, not the person's, and not the route's.
    const living = await app.fetch(
      new Request("http://openbot.test/api/copilotkit", {
        method: "POST",
        headers: { "x-test-session": livingSession },
      }),
    );
    expect(living.status).toBe(200);
    const whole = await living.text();
    for (let index = 1; index < 4; index += 1) {
      expect(whole).toContain(`chunk-${index}`);
    }

    // AND THE REVOKED SESSION CANNOT START A NEW STREAM EITHER.
    const again = await app.fetch(
      new Request("http://openbot.test/api/copilotkit", {
        method: "POST",
        headers: { "x-test-session": dyingSession },
      }),
    );
    expect(again.status).toBe(401);
  });

  test("a session revoked on ANOTHER replica's gate is refused here too", async () => {
    // Two gate instances over one table are two replicas: the second instance has no local
    // memory of any revocation, and must still refuse, because the row is gone.
    const gateThere = countingGate();
    const { app } = appWith(createSessionGate(database));

    const userId = await person();
    const sessionId = await signedIn(userId);
    await database.delete(sessions).where(eq(sessions.id, sessionId));

    const answer = await app.fetch(
      new Request("http://openbot.test/api/copilotkit", {
        method: "POST",
        headers: { "x-test-session": sessionId },
      }),
    );
    expect(answer.status).toBe(401);
    // The fresh replica's gate consults the shared table, not a local cache.
    expect(gateThere.asks).toBe(0);
    expect(
      await gateThere.maySend(sessionId),
      "a replica that never saw the sign-out must still read the shared table",
    ).toBe(false);
    expect(gateThere.asks).toBeGreaterThan(0);
  });

  test("an anonymous request is refused before any body exists to gate", async () => {
    const gate = countingGate();
    const { app } = appWith(gate);
    const answer = await app.fetch(
      new Request("http://openbot.test/api/copilotkit", { method: "POST" }),
    );
    expect(answer.status).toBe(401);
    expect(gate.asks).toBe(0);
  });
});
