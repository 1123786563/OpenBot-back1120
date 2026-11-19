import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AuthenticatedActor } from "../src/auth/guards";
import { createSessionGate } from "../src/auth/session-gate";
import { startHttpServer } from "../src/http-server";
import {
  createGatewaySocketRegistry,
  type GatewaySocketRegistry,
} from "../src/intelligence-gateway-proxy";
import { createChannelEventHub } from "../src/channels/events";
import { createDatabase } from "../src/db/client";
import { personalOrganizations, sessions, users } from "../src/db/schema";
import type { DeploymentConfig } from "../src/config";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A proxied Intelligence gateway socket answers to its session for as long as it stands.
 *
 * The upgrade authenticated the person once, and the conversation then flows as frames for as long
 * as both sides keep the socket open. A person who signs out mid-conversation — here, mid-stream —
 * ends their session row, and a socket that never asks again would go on receiving every turn the
 * gateway sends after it. So each proxied socket carries the session it was upgraded under, and:
 *
 * - every frame it would carry, either direction, is asked of the session gate first — the same
 *   shared `sessions` table sign-out deletes from, so the answer is the same on every replica and
 *   no announcement delay can leave a window;
 * - a refused frame ends the socket from both sides rather than muting it;
 * - the sign-out itself closes the session's sockets through the registry, on this replica and —
 *   through the announcement the hub delivers — on every other one.
 *
 * The route is the one `startHttpServer` actually upgrades in proxy mode, against a stand-in
 * gateway that streams slowly enough for a sign-out to land mid-stream. The session is a real row.
 */

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);

const suite = `t04-gateway-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];

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

/** Sign-out, as the real tail performs it: end the row, then end the session's everything. */
async function signOut(
  userId: string,
  sessionId: string,
  gate: ReturnType<typeof createSessionGate>,
  registry: GatewaySocketRegistry,
): Promise<void> {
  gate.revoke(sessionId);
  registry.revokeSession(userId, sessionId);
  await database.delete(sessions).where(eq(sessions.id, sessionId));
}

/** A stand-in gateway: joins, then streams a tick every 25 ms and echoes what it is sent. */
function stubGateway(): { stop(): Promise<void>; port: number } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, serverHandle) {
      if (new URL(request.url).pathname !== "/client/websocket")
        return new Response("Not found", { status: 404 });
      if (serverHandle.upgrade(request)) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send("joined");
        let tick = 0;
        const handle = setInterval(() => {
          tick += 1;
          try {
            ws.send(`tick-${tick}`);
          } catch {
            clearInterval(handle);
          }
        }, 25);
      },
      message(ws, message) {
        ws.send(`echo:${String(message)}`);
      },
    },
  });
  return { stop: () => server.stop(true), port: server.port };
}

/** The proxied side, with the real upgrade path and a session resolver over the real table. */
function proxiedServer(gatewayPort: number, gate: ReturnType<typeof createSessionGate>, registry: GatewaySocketRegistry) {
  const config = {
    listenHostname: "127.0.0.1",
    singleUser: false,
    runtime: {
      intelligence: {
        gatewayWsUrl: `ws://127.0.0.1:${gatewayPort}`,
        gatewayProxy: true as const,
      },
    },
  } as unknown as DeploymentConfig;
  return startHttpServer({
    port: 0,
    config,
    resolveRequestActor: async (request) => {
      const sessionId = request.headers.get("x-test-session");
      if (!sessionId) return null;
      const [row] = await database
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!row) return null;
      const actor: AuthenticatedActor = {
        id: row.userId,
        email: `${row.userId}@example.test`,
        role: "user",
        workspaceId: row.activeOrganizationId ?? undefined,
        sessionId: row.id,
      };
      return actor;
    },
    agentProfileStore: undefined as never,
    computerGateway: undefined,
    sessionGate: gate,
    gatewaySockets: registry,
    app: { fetch: async () => new Response(null, { status: 404 }) },
  });
}

type Client = { frames: string[]; closed: Promise<number> };

/** Open a browser's side of the proxied socket, as that session's browser would. */
function clientSocket(
  port: number,
  sessionId: string,
): Client {
  const frames: string[] = [];
  let closeCode: number | undefined;
  const closed = new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/intelligence/client/websocket`, {
      headers: { "x-test-session": sessionId },
    });
    ws.onmessage = (event) => frames.push(String(event.data));
    ws.onclose = (event) => {
      closeCode = event.code;
      resolve(event.code);
    };
    ws.onerror = () => {
      resolve(closeCode ?? -1);
    };
  });
  return { frames, closed };
}

const until = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

afterAll(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await database.delete(sessions).where(eq(sessions.id, id)).catch(() => {});
  }
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

describe("a proxied Intelligence gateway socket answers to its session", () => {
  test("sign-out mid-stream closes the socket and no further frame arrives; another session of the same person keeps streaming", async () => {
    const gate = createSessionGate(database);
    const registry = createGatewaySocketRegistry();
    const gateway = stubGateway();
    const server = proxiedServer(gateway.port, gate, registry);
    try {
      const userId = await person();
      const dyingSession = await signedIn(userId);
      const livingSession = await signedIn(userId);

      const dying = clientSocket(server.port, dyingSession);
      const living = clientSocket(server.port, livingSession);
      await until(150);
      expect(dying.frames.length).toBeGreaterThan(0);
      expect(living.frames.length).toBeGreaterThan(0);

      await signOut(userId, dyingSession, gate, registry);
      const closeCode = await Promise.race([
        dying.closed,
        until(2_000).then(() => -2),
      ]);
      expect(closeCode).toBe(1008);
      const framesAtClose = dying.frames.length;
      await until(150);
      // Closed means closed: not a muted socket, nothing flows after it.
      expect(dying.frames.length).toBe(framesAtClose);

      // The person's OTHER session was not the one that signed out, and carries on.
      const livingBefore = living.frames.length;
      await until(150);
      expect(living.frames.length).toBeGreaterThan(livingBefore);
    } finally {
      await server.stop(true).catch(() => {});
      await gateway.stop().catch(() => {});
    }
  });

  test("the announcement any replica delivers closes the socket here too", async () => {
    const gate = createSessionGate(database);
    const registry = createGatewaySocketRegistry();
    // The hub the way index.ts builds it: a revocation announcement ends the session's sockets.
    const hub = createChannelEventHub(gate, {
      onSessionRevoked: (userId, sessionId) =>
        registry.revokeSession(userId, sessionId),
    });
    const gateway = stubGateway();
    const server = proxiedServer(gateway.port, gate, registry);
    try {
      const userId = await person();
      const sessionId = await signedIn(userId);
      const socket = clientSocket(server.port, sessionId);
      await until(150);
      expect(socket.frames.length).toBeGreaterThan(0);

      // The other replica handled the sign-out; this one only hears the announcement.
      await hub.deliver({
        channelId: "",
        lastMessage: null,
        lastMessageAt: null,
        lastMessageAgentId: null,
        memberIds: [userId],
        sessionRevoked: true,
        revokedSessions: [{ userId, sessionId }],
      });
      const closeCode = await Promise.race([
        socket.closed,
        until(2_000).then(() => -2),
      ]);
      expect(closeCode).toBe(1008);
    } finally {
      await server.stop(true).catch(() => {});
      await gateway.stop().catch(() => {});
    }
  });

  test("a revoked session can no longer speak into the conversation either", async () => {
    const gate = createSessionGate(database);
    const registry = createGatewaySocketRegistry();
    const gateway = stubGateway();
    const server = proxiedServer(gateway.port, gate, registry);
    try {
      const userId = await person();
      const sessionId = await signedIn(userId);
      const socket = clientSocket(server.port, sessionId);
      await until(150);
      expect(socket.frames.length).toBeGreaterThan(0);

      // Sign-out through the gate alone — the authority path, no registry close — so what this
      // test observes is the per-frame read refusing, not the prompt close arriving first.
      gate.revoke(sessionId);
      const closeCode = await Promise.race([
        socket.closed,
        until(2_000).then(() => -2),
      ]);
      expect(closeCode).toBe(1008);
      const framesAtClose = socket.frames.length;
      await until(150);
      expect(socket.frames.length).toBe(framesAtClose);
    } finally {
      await server.stop(true).catch(() => {});
      await gateway.stop().catch(() => {});
    }
  });
});
