/**
 * The T04 test fixture the shared-account evidence needs: a way to make one identity a platform
 * administrator on the isolated test instance, because "enable an app out of the broker's
 * catalogue" is an administrator's act and the evidence must be preset by an administrator
 * WITHOUT promoting A or B — the third identity is the administrator, and this is how.
 *
 * Loopback-only (127.0.0.1), on a port nothing else uses, in the deployment's private tooling and
 * never part of OpenBot. It answers POST /promote { email } by writing the `user_roles` row
 * directly — the same fact an operator with a dashboard would establish — and returns the user id
 * it promoted, sanitized.
 */
import { createDatabase } from "../../../server/src/db/client";
import { userRoles, users } from "../../../server/src/db/schema";

const PORT = 19611;
const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required (the T04 server environment)");

const database = createDatabase(databaseUrl, { max: 2 });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/promote" || request.method !== "POST") {
      return Response.json({ error: "POST /promote { email }" }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as { email?: string };
    const email = body.email?.trim();
    if (!email) return Response.json({ error: "email required" }, { status: 400 });
    // The test database is small; finding the one identity in JS keeps this file off a direct
    // drizzle import, which would resolve from the wrong package root.
    const rows = await database.select({ id: users.id, email: users.email }).from(users);
    const user = rows.find((row) => row.email === email);
    if (!user) return Response.json({ error: "no such user" }, { status: 404 });
    const existing = await database
      .select({ role: userRoles.role })
      .from(userRoles);
    if (!existing.some((row) => row.role === "admin" && row.userId === user.id)) {
      await database.insert(userRoles).values({ userId: user.id, role: "admin" });
    }
    return Response.json({ promoted: email.replace(/@.*/, "***"), userId: user.id });
  },
});

console.log(`admin promoter on http://127.0.0.1:${server.port}`);
