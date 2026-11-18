import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAgentRoutes } from "../src/agents/routes";
import type { AgentActor } from "../src/agents/profile-types";
import {
  type ChannelActivityEvent,
  type ChannelEventHub,
  createChannelEventHub,
  startChannelActivityListener,
} from "../src/channels/events";
import {
  createChannelAttachmentRoutes,
  createAttachmentRoutes,
} from "../src/channels/attachments";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createSessionGate } from "../src/auth/session-gate";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  brokeredConnections,
  channels,
  intelligenceChannelMappings,
  mcpServers,
  personalOrganizations,
  sessions,
  users,
} from "../src/db/schema";
import { PluginRefusedError } from "../src/plugins/plugin-store/model";
import { createPluginStore } from "../src/plugins/store";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { personalOrgOf, sharedAccountInScope } from "../src/plugins/plugin-store/shared-scope";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Two unrelated users, one deployment: the cross-user isolation contract, on a real PostgreSQL.
 *
 * Casdoor mode gives every person one personal organization, and the actor every route receives
 * carries it as `workspaceId`. Everything here asks the same question the ticket asks: user A of
 * workspace OA and user B of workspace OB create the same kinds of resource, and then each tries
 * the other's by id. The refusals are checked as the routes answer them; every refusal is paired
 * with the same operation succeeding for the owner, so a refusal that came from something simply
 * being broken cannot pass as isolation. The shared (deployment-held) account is bound to one
 * workspace and read through both.
 */

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("t04-isolation"),
);
const auditStore = createAuditStore(database);
const suite = `t04-iso-${randomUUID().slice(0, 8)}`;

const broker: ConnectedAppBroker = {
  grantIsLocal: true,
  authProviderOf: async () => null,
  authorizations: null,
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({ redirectUrl: "x", authorizationId: null }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "a" }),
  revokeAccount: async () => {},
  accountName: async () => null,
};

const pluginStore = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore,
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  broker,
  deploymentId: suite,
  sharedUse: async () => ({ allowed: true }),
});

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdServerIds: string[] = [];
const createdConnectionApp = `t04shared-${randomUUID().slice(0, 8)}`;

afterEach(async () => {
  for (const id of createdChannelIds.splice(0)) {
    await database.delete(channels).where(eq(channels.id, id));
  }
  for (const id of createdServerIds.splice(0)) {
    await database.delete(mcpServers).where(eq(mcpServers.id, id));
  }
  await database
    .delete(brokeredConnections)
    .where(eq(brokeredConnections.app, createdConnectionApp));
  for (const id of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, id));
    await database.delete(agents).where(eq(agents.id, id));
  }
  for (const id of createdOrgIds.splice(0)) {
    await database
      .delete(personalOrganizations)
      .where(eq(personalOrganizations.id, id));
  }
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

afterAll(async () => {
  await database.$client.close();
});

/**
 * One person of one personal workspace, the way `business-access.ts` hands an actor to the
 * routes: verified, workspace-bound, plain `user`. The organization row is what makes the
 * workspace real, and what `personalOrgOf` reads back.
 */
async function identity(
  label: string,
): Promise<{ id: string; workspaceId: string; actor: AgentActor }> {
  const id = `${suite}-${label}-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, emailVerified: true });
  createdUserIds.push(id);
  const workspaceId = randomUUID();
  await database
    .insert(personalOrganizations)
    .values({ id: workspaceId, ownerUserId: id, name: `${label} space` });
  createdOrgIds.push(workspaceId);
  return { id, workspaceId, actor: { id, role: "user", workspaceId } };
}

function actingAs(
  actor: AgentActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: actor.id,
      email: `${actor.id}@example.test`,
      role: "user",
      workspaceId: actor.workspaceId,
      workspace: {
        id: actor.workspaceId,
        name: "personal",
        ownerUserId: actor.id,
        role: "owner",
      },
    });
    await next();
  };
}

function anonymousRefusal(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    // What createRequireUser answers with no session at all, spelled the same way here.
    if (!context.req.header("x-test-sign-in")) {
      return context.json({ error: "Authentication required." }, 401);
    }
    await next();
  };
}

describe("bots: one owner per workspace", () => {
  test("B cannot read, edit, run or delete A's bot; A can do all of them", async () => {
    const a = await identity("a");
    const b = await identity("b");
    const bot = await profileStore.create(a.actor, {
      name: `T04-A-${suite}`,
      title: "A only",
      roleDescription: "Help",
      visibility: "public",
      systemPrompt: "Help",
    });
    createdAgentIds.push(bot.id);

    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createAgentRoutes(profileStore, actingAs(a.actor)));
    const appB = new Hono<{ Variables: AppVariables }>();
    appB.route("/", createAgentRoutes(profileStore, actingAs(b.actor)));

    // The list only carries the owner's own rows, even with the bot marked public: public is
    // within a workspace, and B is in another one.
    const listB = await appB.request("/");
    expect(listB.status).toBe(200);
    const rosterB = (await listB.json()) as { agents: { id: string }[] };
    expect(rosterB.agents.some((row) => row.id === bot.id)).toBe(false);

    // Every shape of reaching into another person's bot by id is a 404 that names nothing.
    for (const [method, path, body] of [
      ["GET", `/${bot.id}`, undefined],
      [
        "PATCH",
        `/${bot.id}`,
        // A shape the input validator accepts, so the 404 B gets is the ownership refusal and
        // not the validator answering first.
        {
          name: `T04-A-${suite}`,
          title: "Taken",
          roleDescription: "Help",
          visibility: "public",
        },
      ],
      ["POST", `/${bot.id}/duplicate`, {}],
      ["DELETE", `/${bot.id}`, undefined],
      ["POST", `/${bot.id}/callback-token`, {}],
    ] as const) {
      const refused = await appB.request(`http://test${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      expect([method, refused.status]).toEqual([method, 404]);
    }

    // The owner still does everything, and the refused attempts changed nothing.
    const ok = await app.request(`http://test/${bot.id}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { agent: { title: string } }).agent.title).toBe("A only");
    const renamed = await app.request(`http://test/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `T04-A-${suite}`,
        title: "A renamed",
        roleDescription: "Help",
        visibility: "public",
      }),
    });
    expect(renamed.status).toBe(200);
  });
});

describe("conversations: membership and the workspace agree", () => {
  test("B's roster has none of A's conversations and every id fails for B", async () => {
    const a = await identity("a");
    const b = await identity("b");
    const bot = await profileStore.create(a.actor, {
      name: `T04-CH-${suite}`,
      title: "Chat bot",
      roleDescription: "Help",
      visibility: "private",
      systemPrompt: "Help",
    });
    createdAgentIds.push(bot.id);
    const channel = await channelStore.create(a.actor, [bot.id]);
    createdChannelIds.push(channel.id);

    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createChannelRoutes(channelStore, actingAs(a.actor)));
    const appB = new Hono<{ Variables: AppVariables }>();
    appB.route("/", createChannelRoutes(channelStore, actingAs(b.actor)));

    const listB = await appB.request("http://test/?limit=50");
    expect(listB.status).toBe(200);
    const rosterB = (await listB.json()) as { channels: { id: string }[] };
    expect(rosterB.channels.some((row) => row.id === channel.id)).toBe(false);

    const detailB = await appB.request(
      `http://test/${channel.id}`,
    );
    expect(detailB.status).toBe(404);
    const renameB = await appB.request(
      `http://test/${channel.id}/title`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "B was here" }),
      },
    );
    expect(renameB.status).toBe(404);
    const deleteB = await appB.request(
      `http://test/${channel.id}`,
      { method: "DELETE" },
    );
    expect(deleteB.status).toBe(404);

    const detailA = await app.request(
      `http://test/${channel.id}`,
    );
    expect(detailA.status).toBe(200);
    const renameA = await app.request(
      `http://test/${channel.id}/title`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `T04-A-${suite}` }),
      },
    );
    expect(renameA.status).toBe(200);
  });
});

describe("attachments: bytes answer membership", () => {
  test("upload, read, HEAD, 304 and delete answer the workspace boundary", async () => {
    const a = await identity("a");
    const b = await identity("b");
    const bot = await profileStore.create(a.actor, {
      name: `T04-AT-${suite}`,
      title: "Attach bot",
      roleDescription: "Help",
      visibility: "private",
      systemPrompt: "Help",
    });
    createdAgentIds.push(bot.id);
    const channel = await channelStore.create(a.actor, [bot.id]);
    createdChannelIds.push(channel.id);

    const uploadApp = new Hono<{ Variables: AppVariables }>();
    uploadApp.route(
      "/",
      createChannelAttachmentRoutes(database, actingAs(a.actor)),
    );
    const readA = new Hono<{ Variables: AppVariables }>();
    readA.route("/", createAttachmentRoutes(database, actingAs(a.actor)));
    const readB = new Hono<{ Variables: AppVariables }>();
    readB.route("/", createAttachmentRoutes(database, actingAs(b.actor)));
    const readAnon = new Hono<{ Variables: AppVariables }>();
    readAnon.route("/", createAttachmentRoutes(database, anonymousRefusal()));

    const bytes = `T04-A-${suite} — attachment body`;
    const form = new FormData();
    form.set("file", new File([bytes], `t04-a-${suite}.txt`, { type: "text/plain" }));
    const uploaded = await uploadApp.request(
      `http://test/${channel.id}/attachments`,
      { method: "POST", body: form },
    );
    expect(uploaded.status).toBe(201);
    const attachment = (await uploaded.json()) as { id: string };

    // B: the id is known and still nothing comes back — GET, HEAD and conditional reads alike.
    const getB = await readB.request(`http://test/${attachment.id}`);
    expect(getB.status).toBe(404);
    const headB = await readB.request(`http://test/${attachment.id}`, {
      method: "HEAD",
    });
    expect(headB.status).toBe(404);
    // Anonymous: the same route answers 401, distinguishable from B's authenticated 404.
    const anon = await readAnon.request(`http://test/${attachment.id}`);
    expect(anon.status).toBe(401);

    // The owner reads the bytes back unchanged, and the 304 path answers them alone.
    const getA = await readA.request(`http://test/${attachment.id}`);
    expect(getA.status).toBe(200);
    expect(await getA.text()).toBe(bytes);
    const etag = getA.headers.get("etag") ?? "";
    const conditional = await readA.request(
      `http://test/${attachment.id}`,
      { headers: { "if-none-match": etag } },
    );
    expect(conditional.status).toBe(304);
    const conditionalB = await readB.request(
      `http://test/${attachment.id}`,
      { headers: { "if-none-match": etag } },
    );
    expect(conditionalB.status).toBe(404);

    // B cannot delete it; A can.
    const deleteB = await readB.request(
      `http://test/${attachment.id}`,
      { method: "DELETE" },
    );
    expect(deleteB.status).toBe(404);
    const still = await readA.request(`http://test/${attachment.id}`);
    expect(still.status).toBe(200);
    const deleteA = await readA.request(
      `http://test/${attachment.id}`,
      { method: "DELETE" },
    );
    expect([204, 200]).toContain(deleteA.status);
  });
});

describe("live events: the hub ends what a sign-out ends", () => {
  test("revokeSession closes one session's connections; the person's other sessions keep receiving", async () => {
    const hub = createChannelEventHub();
    const sent1: string[] = [];
    const closed1: number[] = [];
    const kept: string[] = [];
    const stranger: string[] = [];
    hub.register(
      "user-a",
      "session-a1",
      (payload) => sent1.push(payload),
      () => {
        closed1.push(1);
      },
    );
    hub.register(
      "user-a",
      "session-a2",
      (payload) => kept.push(payload),
      () => {
        kept.push("closed:a2");
      },
    );
    hub.register(
      "user-b",
      "session-b1",
      (payload) => stranger.push(payload),
      () => {},
    );

    const activity = (memberIds: string[]) =>
      ({
        channelId: "ch",
        memberIds,
        lastMessage: "Said something.",
        lastMessageAt: "2026-11-18T10:00:00.000Z",
        lastMessageAgentId: null,
      }) satisfies ChannelActivityEvent;

    await hub.deliver(activity(["user-a"]));
    expect(sent1).toHaveLength(1);
    expect(kept).toHaveLength(1);

    // The sign-out path's own call: the SESSION that signed out ends — its connection is
    // closed and never written again — while the same person's other session keeps receiving,
    // and nobody else's connection moves at all.
    hub.revokeSession("user-a", "session-a1");
    expect(closed1).toEqual([1]);
    expect(hub.connectionCount("user-a")).toBe(1);

    await hub.deliver(activity(["user-a"]));
    expect(sent1).toHaveLength(1);
    expect(closed1).toEqual([1]);
    expect(kept).toHaveLength(2);
    expect(stranger).toHaveLength(0);

    // The broadcast shape, carrying session ids: closes the named session only.
    hub.register(
      "user-a",
      "session-a1",
      (payload) => sent1.push(payload),
      () => {
        closed1.push(2);
      },
    );
    await hub.deliver({
      channelId: "",
      memberIds: ["user-a"],
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      sessionRevoked: true,
      revokedSessions: [{ userId: "user-a", sessionId: "session-a1" }],
    });
    expect(closed1).toEqual([1, 2]);
    expect(sent1).toHaveLength(1);
    expect(kept).toHaveLength(2);
    expect(stranger).toHaveLength(0);

    // An announcement without session ids — an older replica's shape — closes every connection
    // of the named person, which is all that publisher could have meant.
    await hub.deliver({
      channelId: "",
      memberIds: ["user-a"],
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      sessionRevoked: true,
    });
    expect(kept).toEqual([...kept.slice(0, 2), "closed:a2"]);
    expect(stranger).toHaveLength(0);
    expect(hub.connectionCount("user-a")).toBe(0);
    expect(hub.connectionCount("user-b")).toBe(1);
  });

  test("a session the gate refuses receives nothing, on this replica or a fresh one", async () => {
    // A REAL row in the sessions table: the gate's shared answer is the table itself, so the
    // test reads and deletes exactly what a sign-out deletes.
    const userId = `${suite}-gate-user`;
    const sessionId = `${suite}-gate-session`;
    await database.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      name: "Gate Test User",
    });
    await database.insert(sessions).values({
      id: sessionId,
      userId,
      token: `${suite}-gate-token`,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const gate = createSessionGate(database);
    // A session that exists may receive.
    expect(await gate.maySend(sessionId)).toBe(true);
    // A fresh gate — another replica, sharing nothing but the database — answers the same.
    const otherReplica = createSessionGate(database);
    expect(await otherReplica.maySend(sessionId)).toBe(true);

    // Sign-out: the row goes. The local gate is told directly; the other replica only sees the
    // table — which is the point.
    gate.revoke(sessionId);
    await database.delete(sessions).where(eq(sessions.id, sessionId));

    expect(await gate.maySend(sessionId)).toBe(false);
    expect(await otherReplica.maySend(sessionId)).toBe(false);

    // And the hub armed with that gate writes nothing to the refused session's connection: it
    // closes instead — even though the hub itself was never told about the sign-out, which is
    // the cross-replica case.
    const hub = createChannelEventHub(otherReplica);
    const received: string[] = [];
    const closed: number[] = [];
    hub.register(
      userId,
      sessionId,
      (payload) => received.push(payload),
      () => {
        closed.push(1);
      },
    );
    await hub.deliver({
      channelId: "ch",
      memberIds: [userId],
      lastMessage: "Said something after sign-out.",
      lastMessageAt: "2026-11-18T10:00:01.000Z",
      lastMessageAgentId: null,
    });
    expect(received).toEqual([]);
    expect(closed).toEqual([1]);
    expect(hub.connectionCount(userId)).toBe(0);
  });

  test("a session that still exists receives while the gate is armed", async () => {
    const userId = `${suite}-gate-live`;
    const sessionId = `${suite}-gate-live-session`;
    await database.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      name: "Gate Live User",
    });
    await database.insert(sessions).values({
      id: sessionId,
      userId,
      token: `${suite}-gate-live-token`,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const hub = createChannelEventHub(createSessionGate(database));
    const received: string[] = [];
    const closed: number[] = [];
    hub.register(
      userId,
      sessionId,
      (payload) => received.push(payload),
      () => {
        closed.push(1);
      },
    );
    await hub.deliver({
      channelId: "ch",
      memberIds: [userId],
      lastMessage: "Said something signed in.",
      lastMessageAt: "2026-11-18T10:00:00.000Z",
      lastMessageAgentId: null,
    });
    // The negative case is only isolation if the positive case still works.
    expect(received).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  test("a revocation announced on another instance reaches this one over LISTEN/NOTIFY", async () => {
    const hub: ChannelEventHub = createChannelEventHub();
    const listener = await startChannelActivityListener(databaseUrl, hub);
    try {
      const closed: number[] = [];
      hub.register(
        "user-replica",
        "session-replica",
        () => {
          throw new Error("A revoked connection is never written to.");
        },
        () => {
          closed.push(1);
        },
      );
      await announce([
        { userId: "user-replica", sessionId: "session-replica" },
      ]);
      for (let waited = 0; waited < 50 && closed.length === 0; waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(closed).toEqual([1]);
      expect(hub.connectionCount("user-replica")).toBe(0);
    } finally {
      await listener.stop();
    }
  });
});

describe("shared accounts: one workspace per deployment account", () => {
  test("each workspace connects its own account; a second consent adds a row instead of stealing one", async () => {
    const a = await identity("a");
    const b = await identity("b");

    const serverId = `${suite}-srv`;
    await database.insert(mcpServers).values({
      id: serverId,
      title: "T04 shared app",
      vendor: "Composio",
      url: `composio://${createdConnectionApp}`,
      provenance: "composio",
      accountMode: "shared",
      authScheme: "OAUTH2",
      sharedVendorUserId: `shared-${suite}`,
    });
    createdServerIds.push(serverId);

    // The administrator of workspace OA connects the deployment account.
    const written = await pluginStore.recordBrokeredConnection({
      toolkit: createdConnectionApp,
      account: { holder: "deployment", vendorUserId: `shared-${suite}` },
      connectedBy: a.id,
      verified: true,
      probeAction: null,
    });
    expect(written.wrote).toBe(true);

    const [row] = await database
      .select()
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, createdConnectionApp));
    expect(row.holder).toBe("deployment");
    // The binding is the connecting administrator's own workspace, read off the person, never
    // off a request field.
    expect(row.organizationId).toBe(a.workspaceId);

    // The call-time and route-time question: in scope for OA, out of scope for OB.
    expect(
      await sharedAccountInScope(
        database,
        "composio",
        createdConnectionApp,
        a.workspaceId,
      ),
    ).toBe(true);
    expect(
      await sharedAccountInScope(
        database,
        "composio",
        createdConnectionApp,
        b.workspaceId,
      ),
    ).toBe(false);
    expect(await personalOrgOf(database, a.id)).toBe(a.workspaceId);

    // What OB's settings page reads: not connected, with nobody else's administrator named.
    const sharedForB = await pluginStore.sharedConnections({
      workspaceId: b.workspaceId,
    });
    const entryB = sharedForB.find((each) => each.serverId === serverId);
    expect(entryB?.connected).toBe(false);
    expect(entryB?.connectedBy).toBeNull();
    // What OA's own viewer reads: their account, connected by their administrator.
    const sharedForA = await pluginStore.sharedConnections({
      workspaceId: a.workspaceId,
    });
    const entryA = sharedForA.find((each) => each.serverId === serverId);
    expect(entryA?.connected).toBe(true);
    expect(entryA?.connectedBy).toBe(`${a.id}@example.test`);

    // A later consent from OB's administrator gives OB ITS OWN row: OA's row — its
    // administrator, its identity, its verified state — is untouched, and both workspaces now
    // read "connected" about their own account only. The old (provider, app) key let this
    // consent overwrite OA's row out from under OA's users. The consent runs under the app's
    // own Shared identity, the way a real consent does — the workspace is what makes OB's row
    // OB's.
    await pluginStore.recordBrokeredConnection({
      toolkit: createdConnectionApp,
      account: { holder: "deployment", vendorUserId: `shared-${suite}` },
      connectedBy: b.id,
      verified: true,
      probeAction: null,
    });
    const rows = await database
      .select()
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, createdConnectionApp));
    expect(rows).toHaveLength(2);
    expect(rows.map((each) => each.organizationId).sort()).toEqual(
      [a.workspaceId, b.workspaceId].sort(),
    );

    const afterSecondConsentForA = await pluginStore.sharedConnections({
      workspaceId: a.workspaceId,
    });
    expect(
      afterSecondConsentForA.find((each) => each.serverId === serverId)
        ?.connected,
    ).toBe(true);
    const afterSecondConsentForB = await pluginStore.sharedConnections({
      workspaceId: b.workspaceId,
    });
    const entryBNow = afterSecondConsentForB.find(
      (each) => each.serverId === serverId,
    );
    expect(entryBNow?.connected).toBe(true);
    // OB's card names OB's administrator, never OA's.
    expect(entryBNow?.connectedBy).toBe(`${b.id}@example.test`);
  });

  test("a call resolves only the calling actor's workspace row, in one read, on both sides", async () => {
    const a = await identity("a");
    const b = await identity("b");

    const serverId = `${suite}-srv-call`;
    await database.insert(mcpServers).values({
      id: serverId,
      title: "T04 shared app, called",
      vendor: "Composio",
      url: `composio://${createdConnectionApp}`,
      provenance: "composio",
      accountMode: "shared",
      authScheme: "OAUTH2",
      sharedVendorUserId: `shared-${suite}`,
    });
    createdServerIds.push(serverId);

    await pluginStore.recordBrokeredConnection({
      toolkit: createdConnectionApp,
      account: { holder: "deployment", vendorUserId: `shared-${suite}` },
      connectedBy: a.id,
      verified: true,
      probeAction: null,
    });

    const access = {
      transport: "composio",
      credential: "brokered",
      reachedAs: "deployment",
      ownCredential: false,
      toolkit: createdConnectionApp,
    };

    // OA's administrator calls: the ref the resolution built carries OA's workspace, and the
    // one read keyed on it returns OA's own identity.
    const refA = await pluginStore.accountRefFor(serverId, a.id);
    if (!("ref" in refA)) throw new Error("OA's own shared app did not resolve");
    expect(refA.ref.holder).toBe("deployment");
    expect(refA.ref.organizationId).toBe(a.workspaceId);
    const callA = await pluginStore.connectionTokenFor(
      { id: serverId, title: "T04 shared app, called", credentialId: null },
      null,
      a.id,
      access,
      "shared",
    );
    expect(callA.vendorUserId).toBe(`shared-${suite}`);

    // OB calls the same app while OA holds the only row: refused BEFORE a vendor identity is
    // returned — and the refusal is the same "not connected for your workspace" a genuinely
    // unconnected app earns, so it does not even confirm that OA's row exists.
    const refB = await pluginStore.accountRefFor(serverId, b.id);
    if (!("ref" in refB)) throw new Error("OB's shared ref did not resolve");
    expect(refB.ref.organizationId).toBe(b.workspaceId);
    let refused: unknown = null;
    try {
      await pluginStore.connectionTokenFor(
        { id: serverId, title: "T04 shared app, called", credentialId: null },
        null,
        b.id,
        access,
        "shared",
      );
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PluginRefusedError);
    expect(String(refused)).not.toContain(`shared-${suite}`);

    // THE INTERLEAVING THE OLD TWO-READ SHAPE ALLOWED. OB's administrator consents — under
    // the app's own Shared identity, the way a real consent does; what distinguishes the two
    // rows is their workspace binding, not their identity. Under the old code a scope check
    // that read OA's binding could be followed by a credential read keyed on the identity
    // alone, which matched EITHER row and returned whichever sorted first. The read is one
    // statement keyed on the caller's workspace now, so after the second row exists each side
    // still resolves its own row, and neither resolves the other's.
    await pluginStore.recordBrokeredConnection({
      toolkit: createdConnectionApp,
      account: { holder: "deployment", vendorUserId: `shared-${suite}` },
      connectedBy: b.id,
      verified: true,
      probeAction: null,
    });
    const callAAgain = await pluginStore.connectionTokenFor(
      { id: serverId, title: "T04 shared app, called", credentialId: null },
      null,
      a.id,
      access,
      "shared",
    );
    expect(callAAgain.vendorUserId).toBe(`shared-${suite}`);
    const callB = await pluginStore.connectionTokenFor(
      { id: serverId, title: "T04 shared app, called", credentialId: null },
      null,
      b.id,
      access,
      "shared",
    );
    expect(callB.vendorUserId).toBe(`shared-${suite}`);

    // And OA's disconnect — which deletes by the SAME org-carrying predicate the call read
    // used — ends OA's row only: OB's account keeps its row, its identity and its working call.
    const deleted = await database
      .delete(brokeredConnections)
      .where(pluginStore.accountRow(createdConnectionApp, refA.ref))
      .returning({ app: brokeredConnections.app });
    expect(deleted).toHaveLength(1);
    const remaining = await database
      .select()
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, createdConnectionApp));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.organizationId).toBe(b.workspaceId);
    const callAAfterWithdraw = await pluginStore.connectionTokenFor(
      { id: serverId, title: "T04 shared app, called", credentialId: null },
      null,
      a.id,
      access,
      "shared",
    ).catch((error: unknown) => error);
    expect(callAAfterWithdraw).toBeInstanceOf(PluginRefusedError);
    const callBAfterWithdraw = await pluginStore.connectionTokenFor(
      { id: serverId, title: "T04 shared app, called", credentialId: null },
      null,
      b.id,
      access,
      "shared",
    );
    expect(callBAfterWithdraw.vendorUserId).toBe(`shared-${suite}`);
  });

  test("two workspaces consenting at once each get their own row, and nobody's row is lost", async () => {
    const a = await identity("a");
    const b = await identity("b");

    const serverId = `${suite}-srv-race`;
    await database.insert(mcpServers).values({
      id: serverId,
      title: "T04 shared app, raced",
      vendor: "Composio",
      url: `composio://${createdConnectionApp}`,
      provenance: "composio",
      accountMode: "shared",
      authScheme: "OAUTH2",
      sharedVendorUserId: `shared-${suite}`,
    });
    createdServerIds.push(serverId);

    // The two consents run concurrently, the way two administrators on two replicas do.
    await Promise.all([
      pluginStore.recordBrokeredConnection({
        toolkit: createdConnectionApp,
        account: { holder: "deployment", vendorUserId: `shared-${suite}` },
        connectedBy: a.id,
        verified: true,
        probeAction: null,
      }),
      pluginStore.recordBrokeredConnection({
        toolkit: createdConnectionApp,
        account: { holder: "deployment", vendorUserId: `shared-${suite}` },
        connectedBy: b.id,
        verified: true,
        probeAction: null,
      }),
    ]);

    const rows = await database
      .select()
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, createdConnectionApp));
    expect(rows).toHaveLength(2);
    expect(rows.map((each) => each.organizationId).sort()).toEqual(
      [a.workspaceId, b.workspaceId].sort(),
    );
    expect(rows.map((each) => each.connectedBy).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });
});

/** pg_notify on the same topic the listener hears, the way `announceSessionRevoked` publishes. */
async function announce(ended: { userId: string; sessionId?: string }[]): Promise<void> {
  const { announceSessionRevoked } = await import("../src/channels/events");
  await announceSessionRevoked(database, ended);
}
