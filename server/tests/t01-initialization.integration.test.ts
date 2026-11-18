import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { createAuth } from "../src/auth";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const made: string[] = [];
const config = {
  auth: {
    baseUrl: "http://localhost:13001",
    secret: "t01-integration-test-secret-32-characters",
    trustedOrigins: ["http://localhost:13001"],
    initialAdminEmails: [],
    allowedEmailDomains: ["t01.test"],
    google: { clientId: "unit-test", clientSecret: "unit-test" },
  },
  keyEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
} as unknown as DeploymentConfig;
// Exercise the production DB hooks directly; end-to-end OIDC is verified separately by the real browser.
async function newUser(auth: ReturnType<typeof createAuth>, email: string) {
  const user = {
    id: randomUUID(),
    email,
    name: "T01 hook identity",
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const hooks = auth.options.databaseHooks!.user!.create!;
  await hooks.before!(user, null);
  await database.insert(users).values(user);
  made.push(user.id);
  await hooks.after!(user, null);
  return user;
}
afterAll(async () => {
  if (made.length) await database.delete(users).where(inArray(users.id, made));
  await database.$client.end({ timeout: 5 });
});
test("initializes once per user, not once per session", async () => {
  const events: AuditEventInput[] = [];
  const auth = createAuth(config, database, undefined, {
    insert: async (event) => {
      events.push(event);
    },
  });
  const ctx = await auth.$context;
  const user = await newUser(auth, `t01-${randomUUID()}@t01.test`);

  await ctx.internalAdapter.createSession(user.id);
  await ctx.internalAdapter.createSession(user.id);
  expect(
    events.filter((e) => e.eventType === "t01.login_initialized"),
  ).toHaveLength(1);
  expect(
    events.filter((e) => e.eventType === "session.signed_in"),
  ).toHaveLength(2);
});
test("audit unavailability does not lock out a new admitted user", async () => {
  const auth = createAuth(config, database, undefined, {
    insert: async () => {
      throw new Error("unit-test audit failure");
    },
  });
  const ctx = await auth.$context;
  const user = await newUser(auth, `t01-${randomUUID()}@t01.test`);

  expect((await ctx.internalAdapter.createSession(user.id))?.userId).toBe(
    user.id,
  );
});
test("denied domains never reach initialization", async () => {
  const events: AuditEventInput[] = [];
  const auth = createAuth(config, database, undefined, {
    insert: async (event) => {
      events.push(event);
    },
  });
  const ctx = await auth.$context;
  await expect(
    newUser(auth, `t01-${randomUUID()}@other.test`),
  ).rejects.toThrow();
  expect(events.some((e) => e.eventType === "t01.login_initialized")).toBe(
    false,
  );
});
