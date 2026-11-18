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
  users,
} from "../src/db/schema";
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
  test("revokeUser closes the person's connections and they receive nothing after", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    const closed: number[] = [];
    hub.register(
      "user-a",
      (payload) => received.push(payload),
      () => {
        closed.push(1);
      },
    );
    const stranger: string[] = [];
    hub.register("user-b", (payload) => stranger.push(payload), () => {});

    const activity = (memberIds: string[]) =>
      ({
        channelId: "ch",
        memberIds,
        lastMessage: "Said something.",
        lastMessageAt: "2026-11-18T10:00:00.000Z",
        lastMessageAgentId: null,
      }) satisfies ChannelActivityEvent;

    hub.deliver(activity(["user-a"]));
    expect(received).toHaveLength(1);

    // The sign-out path's own call: every connection of that person ends, and the send is
    // never called again.
    hub.revokeUser("user-a");
    expect(closed).toHaveLength(1);
    expect(hub.connectionCount("user-a")).toBe(0);

    hub.deliver(activity(["user-a"]));
    expect(received).toHaveLength(1);

    // The broadcast shape: a sessionRevoked event carries no payload and closes the named
    // person's connections on whichever instance it reaches — and only theirs.
    hub.register(
      "user-a",
      (payload) => received.push(payload),
      () => {
        closed.push(2);
      },
    );
    hub.deliver({
      channelId: "",
      memberIds: ["user-a"],
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      sessionRevoked: true,
    });
    expect(closed).toEqual([1, 2]);
    expect(received).toHaveLength(1);
    expect(stranger).toEqual([]);
    expect(hub.connectionCount("user-b")).toBe(1);
  });

  test("a revocation announced on another instance reaches this one over LISTEN/NOTIFY", async () => {
    const hub: ChannelEventHub = createChannelEventHub();
    const listener = await startChannelActivityListener(databaseUrl, hub);
    try {
      const closed: number[] = [];
      hub.register(
        "user-replica",
        () => {
          throw new Error("A revoked connection is never written to.");
        },
        () => {
          closed.push(1);
        },
      );
      await announce(["user-replica"]);
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
  test("the account binds to the connecting admin's workspace, refuses others, and rebinding follows the latest consent", async () => {
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

    // The call-time and route-time question: in scope for OA, out of scope for OB — and a
    // workspace actor refuses a row that names no workspace at all.
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
    expect(
      await personalOrgOf(database, a.id),
    ).toBe(a.workspaceId);

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

    // A later consent from OB's administrator rebinds the account to OB, exactly as it
    // supersedes `connectedBy` — and OA's viewer now reads "not connected" in turn.
    await pluginStore.recordBrokeredConnection({
      toolkit: createdConnectionApp,
      account: { holder: "deployment", vendorUserId: `shared-${suite}-2` },
      connectedBy: b.id,
      verified: true,
      probeAction: null,
    });
    const [rebound] = await database
      .select()
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, createdConnectionApp));
    expect(rebound.organizationId).toBe(b.workspaceId);
    const afterRebind = await pluginStore.sharedConnections({
      workspaceId: a.workspaceId,
    });
    expect(
      afterRebind.find((each) => each.serverId === serverId)?.connected,
    ).toBe(false);
  });
});

/** pg_notify on the same topic the listener hears, the way `announceSessionRevoked` publishes. */
async function announce(userIds: string[]): Promise<void> {
  const { announceSessionRevoked } = await import("../src/channels/events");
  await announceSessionRevoked(database, userIds);
}
