import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  brokeredConnections,
  personalOrganizations,
} from "../../db/schema";
import type { BrokerProvider } from "../access";

/**
 * The workspace a Shared account belongs to, and the workspace a person speaks for.
 *
 * Two lookups, one module, because the organization check on a deployment-held account is asked
 * from three places that must never disagree: the call path, which refuses before a vendor is
 * touched; the connection routes, which refuse before a state is shown or an act is done; and the
 * writers, which bind the connecting administrator's workspace onto the row. A check inlined at
 * each of those is a check that drifts; this module is the one copy.
 *
 * BOTH ANSWERS MAY BE NULL, and the nulls mean different things callers must not conflate: a
 * person with no personal organization is a single-user or legacy identity, for whom the
 * workspace dimension does not exist and legacy behaviour holds; a deployment row with no
 * workspace is a row written before binding existed, which a workspace actor is refused rather
 * than lent — an unscoped team account must not become every space's fallback.
 */
export async function personalOrgOf(
  database: Database,
  userId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ id: personalOrganizations.id })
    .from(personalOrganizations)
    .where(eq(personalOrganizations.ownerUserId, userId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Whether the deployment-held account behind `(provider, app)` belongs to this workspace.
 *
 * False for a row of another workspace AND for a row with no workspace at all: both are answers a
 * workspace actor may not act on, and neither may fall back to "the deployment's". Person-held
 * rows never reach this question — they are scoped by `user_id` at every reader already.
 */
export async function sharedAccountInScope(
  database: Database,
  provider: BrokerProvider,
  app: string,
  actorWorkspaceId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ organizationId: brokeredConnections.organizationId })
    .from(brokeredConnections)
    .where(
      and(
        eq(brokeredConnections.provider, provider),
        eq(brokeredConnections.app, app),
        eq(brokeredConnections.holder, "deployment"),
      ),
    )
    .limit(1);
  return row?.organizationId === actorWorkspaceId;
}
