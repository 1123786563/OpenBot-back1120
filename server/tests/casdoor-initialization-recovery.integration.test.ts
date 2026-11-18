import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { createAuth } from "../src/auth";
import { casdoorRequest } from "../src/auth/casdoor";
import { InitializationRetryableError } from "../src/auth/initialization-faults";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  personalOrganizations,
  sessions,
  users,
} from "../src/db/schema";
import { createWorkspaceStore } from "../src/workspaces/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Casdoor T03, at the real write boundaries.
 *
 * The browser verification in deploy/t03 proves convergence through real Casdoor sign-ins. This
 * suite proves what that browser cannot see: that the identity transaction is atomic under a real
 * concurrent race, that a failure at each initialization boundary leaves exactly the rows it
 * should, and that the next authorization — the ordinary createSession path the callback runs —
 * completes what the failure interrupted. The same `internalAdapter` calls the OAuth callback
 * itself makes (`createOAuthUser`, then `createSession`).
 */

// The generic-OAuth plugin fetches discovery once when the auth context is built. No real Casdoor
// takes part in this suite — every scenario below calls the adapter functions the callback calls —
// so a local document with the shape of Casdoor's is enough to initialise the provider.
const discovery = Bun.serve({
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/.well-known/openid-configuration")
      return new Response(null, { status: 404 });
    return Response.json({
      issuer: `http://127.0.0.1:${discovery.port}`,
      authorization_endpoint: `http://127.0.0.1:${discovery.port}/authorize`,
      token_endpoint: `http://127.0.0.1:${discovery.port}/token`,
      userinfo_endpoint: `http://127.0.0.1:${discovery.port}/api/userinfo`,
      jwks_uri: `http://127.0.0.1:${discovery.port}/.well-known/jwks`,
      id_token_signing_alg_values_supported: ["RS256"],
    });
  },
});
const ISSUER = `http://127.0.0.1:${discovery.port}`;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const config = {
  auth: {
    baseUrl: `http://127.0.0.1:${discovery.port}`,
    secret: "t03-integration-test-secret-32-characters",
    trustedOrigins: [`http://127.0.0.1:${discovery.port}`],
    initialAdminEmails: [],
    allowedEmailDomains: [],
    casdoor: {
      issuer: ISSUER,
      clientId: "t03-integration",
      clientSecret: "t03-integration-secret",
    },
  },
  keyEncryptionKey: Buffer.alloc(32, 2).toString("base64"),
} as unknown as DeploymentConfig;

const audit: AuditEventInput[] = [];
const auth = createAuth(config, database, undefined, {
  insert: async (event) => {
    audit.push(event);
  },
});
const ctx = await auth.$context;
const workspaceStore = createWorkspaceStore(database);

// The one-shot fault file this suite arms and disarms around each failure scenario.
const faultFile = join(mkdtempSync(join(tmpdir(), "t03-faults-")), "faults.json");
process.env.OPENBOT_TEST_FAULT_FILE = faultFile;
function armFault(point: string) {
  writeFileSync(
    faultFile,
    `${JSON.stringify({ mode: "fault", point, remaining: 1 })}\n`,
  );
}
function disarmFault() {
  rmSync(faultFile, { force: true });
}

const made: string[] = [];
afterAll(async () => {
  disarmFault();
  delete process.env.OPENBOT_TEST_FAULT_FILE;
  // Users cascade to their sessions, identity rows and personal organizations.
  for (const id of made) {
    await database.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await database.$client.end({ timeout: 5 });
  discovery.stop(true);
});

/** A Casdoor identity that has not been seen here yet. */
function freshIdentity(verified = true) {
  const sub = randomUUID();
  const email = `t03-${sub}@t03.test`;
  return { sub, email, verified };
}

/** The exact call the OAuth callback makes for a first sign-in. */
async function firstSignIn(identity: {
  sub: string;
  email: string;
  verified?: boolean;
}, issuer = ISSUER) {
  return ctx.internalAdapter.createOAuthUser(
    {
      name: "T03 identity",
      email: identity.email,
      emailVerified: identity.verified ?? true,
      image: null,
    },
    { providerId: "casdoor", accountId: identity.sub, issuer },
  );
}

/** The session the callback binds, with the identity the verified ID token carried. */
async function signInSession(userId: string, identity: { sub: string; email: string; verified?: boolean }) {
  return casdoorRequest.run(
    { identity: { sub: identity.sub, email: identity.email, email_verified: identity.verified ?? true } },
    () => ctx.internalAdapter.createSession(userId),
  );
}

async function identityRows(sub: string, issuer = ISSUER) {
  return database
    .select({ id: accounts.id, userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        eq(accounts.providerId, "casdoor"),
        eq(accounts.issuer, issuer),
        eq(accounts.accountId, sub),
      ),
    );
}

test("concurrent first sign-ins converge on one user with one identity row", async () => {
  const identity = freshIdentity();
  const attempts = await Promise.allSettled([
    firstSignIn(identity),
    firstSignIn(identity),
    firstSignIn(identity),
  ]);
  const winners = attempts.filter((a) => a.status === "fulfilled");
  expect(winners.length).toBeGreaterThanOrEqual(1);
  const userIds = new Set(
    winners
      .map((a) => (a as PromiseFulfilledResult<{ user: { id: string } }>).value.user.id),
  );
  // One identity is one user, whichever attempt won.
  expect(userIds.size).toBe(1);
  const userId = [...userIds][0];
  made.push(userId);

  const rows = await identityRows(identity.sub);
  expect(rows).toHaveLength(1);
  expect(rows[0].userId).toBe(userId);
  const userRows = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, identity.email));
  // No orphan: the losing attempts rolled back whole, leaving no unclaimed user row behind.
  expect(userRows).toHaveLength(1);
  expect(userRows[0].id).toBe(userId);

  // Every attempt that reaches the session stage converges on the same user and workspace.
  const first = await signInSession(userId, identity);
  const second = await signInSession(userId, identity);
  expect(second.userId).toBe(first.userId);
  const workspaces = await database
    .select()
    .from(personalOrganizations)
    .where(eq(personalOrganizations.ownerUserId, userId));
  expect(workspaces).toHaveLength(1);
  expect(first.activeOrganizationId).toBe(workspaces[0].id);
  expect(second.activeOrganizationId).toBe(workspaces[0].id);
  expect(first.authSource).toBe(ISSUER);
});

test("the same subject from a different issuer is a different identity and is never merged", async () => {
  const identity = freshIdentity();
  const created = await firstSignIn(identity);
  made.push(created.user.id);
  await identityRows(identity.sub);

  // Same subject string, same email, another deployment's issuer: the user address is already
  // taken, and the identity must be refused rather than folded into the existing person.
  await expect(firstSignIn(identity, "http://other-issuer.test")).rejects.toThrow();
  const rows = await identityRows(identity.sub, "http://other-issuer.test");
  expect(rows).toHaveLength(0);
  const userRows = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, identity.email));
  expect(userRows).toHaveLength(1);
  expect(userRows[0].id).toBe(created.user.id);
});

test("two identities on one issuer stay two users", async () => {
  const a = freshIdentity();
  const b = freshIdentity();
  const [userA, userB] = [await firstSignIn(a), await firstSignIn(b)];
  made.push(userA.user.id, userB.user.id);
  expect(userA.user.id).not.toBe(userB.user.id);
  await signInSession(userA.user.id, a);
  await signInSession(userB.user.id, b);
  const [wa] = await database
    .select()
    .from(personalOrganizations)
    .where(eq(personalOrganizations.ownerUserId, userA.user.id));
  const [wb] = await database
    .select()
    .from(personalOrganizations)
    .where(eq(personalOrganizations.ownerUserId, userB.user.id));
  expect(wa).toBeDefined();
  expect(wb).toBeDefined();
  expect(wa.id).not.toBe(wb.id);
  // A later authorization on either identity keeps its own space.
  await signInSession(userA.user.id, a);
  await signInSession(userB.user.id, b);
  const [waAfter] = await database
    .select()
    .from(personalOrganizations)
    .where(eq(personalOrganizations.ownerUserId, userA.user.id));
  const [wbAfter] = await database
    .select()
    .from(personalOrganizations)
    .where(eq(personalOrganizations.ownerUserId, userB.user.id));
  expect(waAfter.id).toBe(wa.id);
  expect(wbAfter.id).toBe(wb.id);
});

test("a failure before the user row leaves nothing behind and a retry succeeds", async () => {
  const identity = freshIdentity();
  armFault("before-user-insert");
  try {
    await expect(firstSignIn(identity)).rejects.toThrow(
      InitializationRetryableError,
    );
    expect(await identityRows(identity.sub)).toHaveLength(0);
    const userRows = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, identity.email));
    expect(userRows).toHaveLength(0);
  } finally {
    disarmFault();
  }
  // The retry — a new authorization, not a database repair — creates the identity cleanly.
  const retry = await firstSignIn(identity);
  made.push(retry.user.id);
  const rows = await identityRows(identity.sub);
  expect(rows).toHaveLength(1);
  expect(rows[0].userId).toBe(retry.user.id);
});

test("a failure after the identity commits keeps it, and the next authorization completes initialization", async () => {
  const identity = freshIdentity();
  armFault("user-committed");
  let userId: string;
  try {
    const failure = await firstSignIn(identity).catch((error) => error);
    expect(failure).toBeInstanceOf(InitializationRetryableError);
  } finally {
    disarmFault();
  }
  // The identity transaction had already committed when the hook failed: the association survives.
  const rows = await identityRows(identity.sub);
  expect(rows).toHaveLength(1);
  userId = rows[0].userId;
  made.push(userId);
  const owner = await ctx.internalAdapter.findAccountOwnerByKey({
    issuer: ISSUER,
    accountId: identity.sub,
  });
  expect(owner?.user.id).toBe(userId);

  // Recovery is an ordinary new authorization: it binds a session to a fresh workspace without
  // touching the committed identity.
  const session = await signInSession(userId, identity);
  expect(session.userId).toBe(userId);
  const workspaces = await database
    .select()
    .from(personalOrganizations)
    .where(eq(personalOrganizations.ownerUserId, userId));
  expect(workspaces).toHaveLength(1);
  expect(session.activeOrganizationId).toBe(workspaces[0].id);
});

test("a failure before the workspace leaves the identity ready and a retry creates exactly one", async () => {
  const identity = freshIdentity();
  const created = await firstSignIn(identity);
  const userId = created.user.id;
  made.push(userId);
  armFault("before-workspace-ensure");
  try {
    await expect(signInSession(userId, identity)).rejects.toThrow(
      InitializationRetryableError,
    );
  } finally {
    disarmFault();
  }
  // No workspace, no session, but the identity and its user are intact.
  expect(
    await database
      .select()
      .from(personalOrganizations)
      .where(eq(personalOrganizations.ownerUserId, userId)),
  ).toHaveLength(0);
  const retry = await signInSession(userId, identity);
  expect(retry.activeOrganizationId).not.toBeNull();
  const workspaces = await database
    .select()
    .from(personalOrganizations)
    .where(eq(personalOrganizations.ownerUserId, userId));
  expect(workspaces).toHaveLength(1);
  expect(retry.activeOrganizationId).toBe(workspaces[0].id);
  expect(await workspaceStore.read(userId)).toMatchObject({
    id: workspaces[0].id,
    name: "Personal workspace",
  });
});

test("a failure after the workspace commits keeps its id and name, and a retry binds it", async () => {
  const identity = freshIdentity();
  const created = await firstSignIn(identity);
  const userId = created.user.id;
  made.push(userId);
  armFault("workspace-ensured");
  try {
    await expect(signInSession(userId, identity)).rejects.toThrow(
      InitializationRetryableError,
    );
  } finally {
    disarmFault();
  }
  const committed = await workspaceStore.read(userId);
  expect(committed).not.toBeNull();
  // The person names their space while the broken session is behind them.
  await workspaceStore.rename(userId, "T03 kept name");

  const retry = await signInSession(userId, identity);
  expect(retry.activeOrganizationId).toBe(committed!.id);
  const after = await workspaceStore.read(userId);
  expect(after!.id).toBe(committed!.id);
  // The chosen name survives; the retry did not overwrite or duplicate the space.
  expect(after!.name).toBe("T03 kept name");
  expect(
    await database
      .select()
      .from(personalOrganizations)
      .where(eq(personalOrganizations.ownerUserId, userId)),
  ).toHaveLength(1);
});

test("a failure after the session commits does not revoke it, and a retry binds another session to the same space", async () => {
  const identity = freshIdentity();
  const created = await firstSignIn(identity);
  const userId = created.user.id;
  made.push(userId);
  armFault("session-committed");
  let interruptedToken: string | undefined;
  try {
    const failure = await signInSession(userId, identity).catch((error) => error);
    expect(failure).toBeInstanceOf(InitializationRetryableError);
    // The session row is committed even though the callback never answered: another client that
    // did receive this session keeps it, untouched by the retry below.
    const stored = await database
      .select({ token: sessions.token, activeOrganizationId: sessions.activeOrganizationId })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(stored).toHaveLength(1);
    interruptedToken = stored[0].token;
  } finally {
    disarmFault();
  }
  const retry = await signInSession(userId, identity);
  const stored = await database
    .select({ id: sessions.id, token: sessions.token, activeOrganizationId: sessions.activeOrganizationId })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  expect(stored).toHaveLength(2);
  expect(stored.some((s) => s.token === interruptedToken)).toBe(true);
  expect(stored.every((s) => s.activeOrganizationId === retry.activeOrganizationId)).toBe(true);
});

test("concurrent workspace initialisation yields one organization with a stable id and name", async () => {
  const identity = freshIdentity();
  const created = await firstSignIn(identity);
  const userId = created.user.id;
  made.push(userId);
  const ensured = await Promise.all(
    Array.from({ length: 6 }, () => workspaceStore.ensure(userId)),
  );
  const ids = new Set(ensured.map((w) => w.id));
  expect(ids.size).toBe(1);
  await workspaceStore.rename(userId, "Concurrent keep");
  const again = await workspaceStore.ensure(userId);
  expect(again.id).toBe(ensured[0].id);
  expect(again.name).toBe("Concurrent keep");
});

test("one database connection is enough: the session hooks never wait on a second", async () => {
  const identity = freshIdentity();
  const created = await firstSignIn(identity);
  const userId = created.user.id;
  made.push(userId);
  // The production shape the T03 design warns about: every write in the sign-in path — the
  // workspace transaction included — sharing one connection must complete, not deadlock.
  const single = createDatabase(testDatabaseUrl(), { max: 1 });
  try {
    const singleAuth = createAuth(config, single);
    const singleCtx = await singleAuth.$context;
    const session = await casdoorRequest.run(
      { identity: { sub: identity.sub, email: identity.email, email_verified: true } },
      () => singleCtx.internalAdapter.createSession(userId),
    );
    expect(session.userId).toBe(userId);
    expect(session.activeOrganizationId).not.toBeNull();
  } finally {
    await single.$client.end({ timeout: 5 });
  }
});
