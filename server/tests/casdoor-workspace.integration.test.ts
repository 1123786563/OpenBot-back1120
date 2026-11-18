import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createBusinessAccess } from "../src/auth/business-access";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
} from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agents,
  personalOrganizations,
  sessions,
  users,
} from "../src/db/schema";
import { createWorkspaceStore } from "../src/workspaces/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const db = createDatabase(testDatabaseUrl(), TEST_POOL);
const workspaceStore = createWorkspaceStore(db);
const ids: string[] = [];
const bots: string[] = [];
afterAll(async () => {
  if (bots.length) await db.delete(agents).where(inArray(agents.id, bots));
  if (ids.length) {
    await db.delete(sessions).where(inArray(sessions.userId, ids));
    await db
      .delete(personalOrganizations)
      .where(inArray(personalOrganizations.ownerUserId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  }
  await db.$client.end({ timeout: 5 });
});
async function identity(verified: boolean) {
  const id = randomUUID();
  ids.push(id);
  await db
    .insert(users)
    .values({ id, email: `${id}@gmail.com`, emailVerified: verified });
  await db.insert(accounts).values({
    id: randomUUID(),
    providerId: "casdoor",
    accountId: id,
    issuer: "http://localhost:19000",
    userId: id,
  });
  const session = {
    id: randomUUID(),
    userId: id,
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 60000),
    authSource: "http://localhost:19000",
  };
  await db.insert(sessions).values(session);
  const service: AuthService = {
    handler: () => new Response(),
    api: {
      getSession: async () => ({
        session: { id: session.id },
        user: { id, email: `${id}@gmail.com` },
      }),
    },
  };
  const resolve = createBusinessAccess(service, db, "http://localhost:19000");
  service.resolveBusinessAccess = resolve;
  return { id, session, resolve, service };
}
test("persistent verification, provenance and owner binding gate HTTP access", async () => {
  const a = await identity(false);
  const app = new Hono<{ Variables: AppVariables }>();
  app.get(
    "/business",
    createRequireUser(a.service, { rolesForUser: async () => ["admin"] }),
    (c) => c.json(c.var.actor),
  );
  expect((await app.request("/business")).status).toBe(403);
  expect(await a.resolve(new Headers())).toEqual({
    kind: "denied",
    code: "EMAIL_VERIFICATION_REQUIRED",
  });
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, a.id));
  expect(await a.resolve(new Headers())).toEqual({
    kind: "denied",
    code: "WORKSPACE_REQUIRED",
  });
  const workspace = await workspaceStore.ensure(a.id);
  await db
    .update(sessions)
    .set({ activeOrganizationId: workspace.id })
    .where(eq(sessions.id, a.session.id));
  const response = await app.request("/business");
  expect(response.status).toBe(200);
  const actor = await response.json();
  expect(actor.role).toBe("user");
  expect(actor.workspace.id).toBe(workspace.id);
  const b = await identity(true);
  const other = await workspaceStore.ensure(b.id);
  await db
    .update(sessions)
    .set({ activeOrganizationId: other.id })
    .where(eq(sessions.id, a.session.id));
  expect(await a.resolve(new Headers())).toEqual({
    kind: "denied",
    code: "WORKSPACE_REQUIRED",
  });
  await db
    .update(sessions)
    .set({ authSource: null })
    .where(eq(sessions.id, a.session.id));
  expect(await a.resolve(new Headers())).toEqual({
    kind: "denied",
    code: "AUTH_SOURCE_REQUIRED",
  });
});
test("workspace retries preserve one organization and its chosen name; Bot CRUD and duplicate stay scoped", async () => {
  const a = await identity(true);
  const b = await identity(true);
  const wa = await workspaceStore.ensure(a.id),
    wb = await workspaceStore.ensure(b.id);
  await workspaceStore.rename(a.id, "Chosen name");
  const again = await workspaceStore.ensure(a.id);
  expect(again.id).toBe(wa.id);
  expect(again.name).toBe("Chosen name");
  const store = createAgentProfileStore(db, undefined);
  const aa: AgentActor = { id: a.id, role: "user", workspaceId: wa.id };
  const ba: AgentActor = { id: b.id, role: "user", workspaceId: wb.id };
  const bot = await store.create(aa, {
    name: "Scoped Bot",
    title: "Test",
    roleDescription: "Help",
    visibility: "public",
    systemPrompt: "Help",
  });
  bots.push(bot.id);
  expect(bot.organizationId).toBe(wa.id);
  expect(await store.get(ba, bot.id)).toBeNull();
  expect(await store.get({ id: a.id, role: "user" }, bot.id)).toBeNull();
  expect((await store.list(ba)).some((x) => x.id === bot.id)).toBe(false);
  expect((await store.get(aa, bot.id))?.ownerUserId).toBe(a.id);
  const copy = await store.duplicate(aa, bot.id);
  bots.push(copy.id);
  expect(copy.organizationId).toBe(wa.id);
  const rows = await db
    .select()
    .from(personalOrganizations)
    .where(eq(personalOrganizations.ownerUserId, a.id));
  expect(rows).toHaveLength(1);
});
