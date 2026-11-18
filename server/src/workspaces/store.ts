import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { personalOrganizations } from "../db/schema";

export function createWorkspaceStore(database: Database) {
  return {
    async ensure(userId: string) {
      return database.transaction(async (tx) => {
        await tx
          .insert(personalOrganizations)
          .values({ ownerUserId: userId, name: "Personal workspace" })
          .onConflictDoNothing({ target: personalOrganizations.ownerUserId });
        const [workspace] = await tx
          .select()
          .from(personalOrganizations)
          .where(eq(personalOrganizations.ownerUserId, userId));
        if (!workspace) throw new Error("WORKSPACE_INITIALIZATION_FAILED");
        return workspace;
      });
    },
    async read(userId: string) {
      const [workspace] = await database
        .select()
        .from(personalOrganizations)
        .where(eq(personalOrganizations.ownerUserId, userId));
      return workspace ?? null;
    },
    async rename(userId: string, name: string) {
      const [workspace] = await database
        .update(personalOrganizations)
        .set({ name, updatedAt: new Date() })
        .where(eq(personalOrganizations.ownerUserId, userId))
        .returning();
      return workspace ?? null;
    },
  };
}
export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
