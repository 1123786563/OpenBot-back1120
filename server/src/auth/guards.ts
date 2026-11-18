import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { Database } from "../db/client";
import { userRoles } from "../db/schema";
import type { BusinessAccess } from "./business-access";
import type { OpenBotRole } from "./roles";

export type AuthenticatedActor = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: OpenBotRole;
  workspaceId?: string;
  workspace?: { id: string; name: string; ownerUserId: string; role: "owner" };
  /**
   * The server session this actor was resolved from, when one exists.
   *
   * Revocation is PER SESSION, not per person: the person who signs out ends the session they
   * signed out of, and their other devices keep working. Everything that outlives a single
   * request on this actor's authority — a WebSocket subscription, a streaming response — carries
   * this id, so the session that ended can be refused without touching the sessions that did
   * not. Absent where no session exists at all (single-user mode, which has no sign-out).
   */
  sessionId?: string;
};

export type AuthService = {
  resolveBusinessAccess?: (headers: Headers) => Promise<BusinessAccess>;
  handler: (request: Request) => Response | Promise<Response>;
  api: {
    getSession: (input: {
      headers: Headers;
      query?: { disableCookieCache: boolean };
    }) => Promise<{
      session?: { id: string };
      user: {
        id: string;
        email: string;
        name?: string | null;
        image?: string | null;
        /** Set only by a server-verified organization authority. */
        role?: OpenBotRole;
      };
    } | null>;
  };
};

export type RoleRepository = {
  rolesForUser: (userId: string) => Promise<OpenBotRole[]>;
};

export type AppVariables = {
  actor: AuthenticatedActor;
};

export function createRoleRepository(database: Database): RoleRepository {
  return {
    rolesForUser: async (userId) => {
      const records = await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));

      return records.map((record) => record.role);
    },
  };
}

export function createRequireUser(
  auth: AuthService,
  roleRepository: RoleRepository,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (auth.resolveBusinessAccess) {
      const access = await auth.resolveBusinessAccess(context.req.raw.headers);
      if (access.kind === "anonymous")
        return context.json({ error: "Authentication required." }, 401);
      if (access.kind === "denied")
        return context.json({ error: access.code }, 403);
      context.set("actor", access.actor);
      await next();
      return;
    }
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
      query: { disableCookieCache: true },
    });

    if (!session) {
      return context.json({ error: "Authentication required." }, 401);
    }

    const roles = session.user.role
      ? [session.user.role]
      : await roleRepository.rolesForUser(session.user.id);
    const role = roles.includes("admin")
      ? "admin"
      : roles.includes("user")
        ? "user"
        : undefined;

    if (!role) {
      return context.json({ error: "Authorization required." }, 403);
    }

    context.set("actor", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
      role,
      sessionId: session.session?.id,
    });
    await next();
  };
}

export function requireAdmin(context: Context<{ Variables: AppVariables }>) {
  if (context.var.actor.role !== "admin") {
    return context.json({ error: "Only an admin can do this." }, 403);
  }

  return undefined;
}
