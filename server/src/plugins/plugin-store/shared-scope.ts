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
 * Whether the deployment-held account this workspace may act on exists for `(provider, app)`.
 *
 * The workspace is IN THE QUERY, not compared after it: an app can now hold one Shared account
 * per workspace, so "the deployment row" is not one row, and picking any row and comparing its
 * workspace afterwards could answer the question about a row the actor may never see — or, worse,
 * let a second read without the workspace land on a row that was re-bound between the two reads.
 * One statement, one predicate: a row of this workspace, or no row.
 *
 * False for a workspace with no row of its own — including when ANOTHER workspace holds one:
 * that another space connected the app is a fact of a space the caller is not in, and the answer
 * they get is the same "not in scope" either way. Person-held rows never reach this question —
 * they are scoped by `user_id` at every reader already.
 */
export async function sharedAccountInScope(
  database: Database,
  provider: BrokerProvider,
  app: string,
  actorWorkspaceId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: brokeredConnections.vendorUserId })
    .from(brokeredConnections)
    .where(
      and(
        eq(brokeredConnections.provider, provider),
        eq(brokeredConnections.app, app),
        eq(brokeredConnections.holder, "deployment"),
        eq(brokeredConnections.organizationId, actorWorkspaceId),
      ),
    )
    .limit(1);
  return row !== undefined;
}
