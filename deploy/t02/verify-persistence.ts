import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import postgres from "../../server/node_modules/postgres";

assert.equal(process.env.DEPLOYMENT_ID, "openbot-t02");
const databaseUrl = process.env.DATABASE_URL;
assert(databaseUrl, "T02 DATABASE_URL is required");
assert.equal(new URL(databaseUrl).pathname, "/openbot_t02");
assert.equal(new URL(databaseUrl).port, "56432");
const evidence = JSON.parse(
  readFileSync("deploy/t02/evidence/verification.json", "utf8"),
);
const sql = postgres(databaseUrl, { max: 1 });
const results = [];
try {
  for (const identity of evidence.identities) {
    const rows =
      await sql`select u.id, u.email_verified, (select json_agg(role) from user_roles where user_id=u.id) roles, (select count(*)::int from accounts where user_id=u.id and provider_id='casdoor' and issuer='http://localhost:19000') identities, (select count(*)::int from personal_organizations where owner_user_id=u.id) organizations, (select count(*)::int from agent_profiles where owner_user_id=u.id) owned_bots, (select count(*)::int from sessions where user_id=u.id and active_organization_id=${identity.workspaceId}::uuid and auth_source='http://localhost:19000') bound_sessions from users u where u.id=${identity.userId}`;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.email_verified, true);
    assert.deepEqual(row.roles, ["user"]);
    assert.equal(row.identities, 1);
    assert.equal(row.organizations, 1);
    assert.equal(
      row.owned_bots,
      identity.userId === evidence.identities[0].userId ? 1 : 0,
    );
    assert(row.bound_sessions >= 1);
    results.push(row);
  }
  const [bot] =
    await sql`select p.agent_id,p.owner_user_id,p.organization_id from agent_profiles p join agents a on a.id=p.agent_id where p.agent_id=${evidence.botId}`;
  assert.equal(bot.owner_user_id, evidence.identities[0].userId);
  assert.equal(bot.organization_id, evidence.identities[0].workspaceId);
  const [firstPublicUser] =
    await sql`select u.id, (select json_agg(role) from user_roles where user_id=u.id) roles from users u where exists(select 1 from accounts a where a.user_id=u.id and a.provider_id='casdoor') order by u.created_at limit 1`;
  assert.deepEqual(firstPublicUser.roles, ["user"]);
  const [defaults] =
    await sql`select count(*)::int count from personal_organizations where id::text='default' or name='default'`;
  assert.equal(defaults.count, 0);
  writeFileSync(
    "deploy/t02/evidence/persistence.json",
    `${JSON.stringify(
      {
        users: results,
        bot,
        defaultOrganizations: defaults.count,
        firstPublicUser,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    "Persistent identity, ordinary role, unique workspace, session binding and Bot ownership checks passed",
  );
} finally {
  await sql.end();
}
