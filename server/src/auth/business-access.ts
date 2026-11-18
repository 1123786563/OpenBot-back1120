import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { accounts, personalOrganizations, sessions, users } from "../db/schema";
import type { AuthenticatedActor, AuthService } from "./guards";

export type BusinessAccess =
  | { kind: "anonymous" }
  | { kind: "denied"; code: string }
  | { kind: "ready"; actor: AuthenticatedActor };
export function createBusinessAccess(
  auth: AuthService,
  database: Database,
  issuer: string,
) {
  return async (headers: Headers): Promise<BusinessAccess> => {
    const session = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    });
    if (!session) return { kind: "anonymous" };
    const storedSession = session.session;
    if (!storedSession?.id)
      return { kind: "denied", code: "AUTH_SOURCE_REQUIRED" };
    const [row] = await database
      .select({
        source: sessions.authSource,
        workspaceId: sessions.activeOrganizationId,
        emailVerified: users.emailVerified,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, storedSession.id),
          eq(sessions.userId, session.user.id),
        ),
      );
    if (!row || row.source !== issuer)
      return { kind: "denied", code: "AUTH_SOURCE_REQUIRED" };
    if (!row.emailVerified)
      return { kind: "denied", code: "EMAIL_VERIFICATION_REQUIRED" };
    const [identity] = await database
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, session.user.id),
          eq(accounts.providerId, "casdoor"),
          eq(accounts.issuer, issuer),
        ),
      );
    if (!identity) return { kind: "denied", code: "AUTH_SOURCE_REQUIRED" };
    const [workspace] = await database
      .select()
      .from(personalOrganizations)
      .where(eq(personalOrganizations.ownerUserId, session.user.id));
    if (!workspace || workspace.id !== row.workspaceId)
      return { kind: "denied", code: "WORKSPACE_REQUIRED" };
    return {
      kind: "ready",
      actor: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image,
        role: "user",
        workspaceId: workspace.id,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          ownerUserId: workspace.ownerUserId,
          role: "owner",
        },
      },
    };
  };
}
