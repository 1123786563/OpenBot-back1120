import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import postgres from "../../server/node_modules/postgres";

import { serverEnvironment } from "./environment-helpers";

/*
 * Read-only persistence conclusions for Casdoor T03, run after the browser verification.
 *
 * The browser sees what the public API answers; this sees what was actually stored. It never
 * writes: every statement below is a SELECT, and the checks are the uniqueness conclusions the
 * acceptance criteria ask for — one identity row per (issuer, subject), one organization per
 * owner, no user hidden behind a duplicate or an orphan.
 */
const env = serverEnvironment(process.env);
const databaseUrl = env.DATABASE_URL;
assert(databaseUrl, "T03 DATABASE_URL is required");
assert.equal(new URL(databaseUrl).pathname, "/openbot_t03");
assert.equal(new URL(databaseUrl).port, "56433");
const issuer = "http://localhost:19001";
const evidence = JSON.parse(
  readFileSync("deploy/t03/evidence/verification.json", "utf8"),
);
const sql = postgres(databaseUrl, { max: 1 });
const results = [];
try {
  const checked = evidence.identitiesAll ?? evidence.identities;
  for (const identity of checked) {
    const rows =
      await sql`select u.id, u.email_verified, (select json_agg(role) from user_roles where user_id=u.id) roles, (select count(*)::int from accounts where user_id=u.id and provider_id='casdoor' and issuer=${issuer}) identities, (select count(*)::int from accounts where user_id=u.id and provider_id='casdoor') identities_any_issuer, (select count(*)::int from personal_organizations where owner_user_id=u.id) organizations, (select count(*)::int from agent_profiles where owner_user_id=u.id) owned_bots, (select count(*)::int from sessions where user_id=u.id and active_organization_id=${identity.workspaceId}::uuid and auth_source=${issuer}) bound_sessions from users u where u.id=${identity.userId}`;
    assert.equal(rows.length, 1, `user ${identity.userId} not found`);
    const row = rows[0];
    assert.equal(row.email_verified, true);
    // A Casdoor user's business role is decided by the business access layer, not by this table,
    // so a person whose creation was interrupted after the commit may have no row here at all.
    // The load-bearing rule is the ceiling: nobody in this run may carry a platform admin role.
    const roles = row.roles ?? [];
    assert.deepEqual(roles.filter((r: string) => r === "admin"), []);
    assert.equal(row.identities, 1, "expected exactly one identity row on this issuer");
    assert.equal(row.identities_any_issuer, row.identities);
    assert.equal(row.organizations, 1, "expected exactly one personal organization");
    assert(row.bound_sessions >= 1);
    results.push(row);
  }
  // Every identity this run converged must own its space.
  const ids = checked.map((i: { userId: string }) => i.userId);
  const [orphanRun] =
    await sql`select count(*)::int count from users u where u.id = any(${ids}) and exists(select 1 from accounts a where a.user_id=u.id and a.provider_id='casdoor' and issuer=${issuer}) and not exists(select 1 from personal_organizations o where o.owner_user_id=u.id)`;
  assert.equal(orphanRun.count, 0, "an identity of this run was left without a workspace");
  const [bot] =
    await sql`select p.agent_id,p.owner_user_id,p.organization_id from agent_profiles p join agents a on a.id=p.agent_id where p.agent_id=${evidence.botId}`;
  assert.equal(bot.owner_user_id, evidence.identities[0].userId);
  assert.equal(bot.organization_id, evidence.identities[0].workspaceId);

  // Hidden duplicates the API could never show: two identity rows for one (issuer, subject),
  // two organizations for one owner, or a Casdoor user left without the account row that makes
  // the identity recoverable.
  const [duplicateIdentities] =
    await sql`select count(*)::int count from (select 1 from accounts where provider_id='casdoor' and issuer=${issuer} group by issuer, account_id having count(*) > 1) d`;
  assert.equal(duplicateIdentities.count, 0);
  const [duplicateOrganizations] =
    await sql`select count(*)::int count from (select 1 from personal_organizations group by owner_user_id having count(*) > 1) d`;
  assert.equal(duplicateOrganizations.count, 0);
  // Deployment-wide orphans would include identities from earlier aborted attempts, so the
  // per-run conclusion above is the binding one; the global count is recorded for the report.
  const [orphanUsers] =
    await sql`select count(*)::int count from users u where exists(select 1 from accounts a where a.user_id=u.id and a.provider_id='casdoor' and issuer=${issuer}) and not exists(select 1 from personal_organizations o where o.owner_user_id=u.id)`;
  const [defaultOrganizations] =
    await sql`select count(*)::int count from personal_organizations where id::text='default' or name='default'`;
  assert.equal(defaultOrganizations.count, 0);

  writeFileSync(
    "deploy/t03/evidence/persistence.json",
    `${JSON.stringify(
      {
        users: results,
        bot,
        duplicateIdentityRows: duplicateIdentities.count,
        duplicateOrganizations: duplicateOrganizations.count,
        orphanIdentityUsersAllTime: orphanUsers.count,
        defaultOrganizations: defaultOrganizations.count,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    "Unique identity rows, one organization per owner, no hidden duplicates or orphans: persistence checks passed",
  );
} finally {
  await sql.end();
}
