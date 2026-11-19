import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { readAuditRows } from "./audit-rows";

const BOT = "tide-pal";

function row(
  id: string,
  minute: number,
  fields: {
    eventType: string;
    targetType: string;
    targetId: string;
    initiatorKind?: string;
    payload: Record<string, unknown>;
  },
) {
  return {
    id,
    actorUserId: "dev",
    initiatorId: null,
    initiatorKind: "person",
    ...fields,
    createdAt: `2026-11-08T17:${String(minute).padStart(2, "0")}:00Z`,
  };
}

const skillGiven = (slug: string, minute: number) =>
  row(`skill-${slug}`, minute, {
    eventType: "configuration.changed",
    targetType: "skill",
    targetId: slug,
    payload: {
      actor: "dev",
      change: "plugin_granted",
      kind: "skill",
      ref: slug,
      bot: BOT,
    },
  });

/** Newest first, as the server answers. Each row as the server stores it. */
const ROWS = [
  row("connect", 59, {
    eventType: "app_access.approved",
    targetType: "mcp_server",
    targetId: "notion",
    payload: {
      request: "request-1",
      app: "notion",
      bot: BOT,
      kind: "enable",
      enabled: true,
      granted: 0,
      direct: true,
    },
  }),
  skillGiven("skill-creator", 58),
  skillGiven("bot-creator", 57),
  skillGiven("research-public-web", 56),
  row("sign-in", 55, {
    eventType: "mcp.oauth_client_registered",
    targetType: "mcp_server",
    targetId: "notion",
    payload: {
      actor: "dev",
      server: "notion",
      clientId: "client-1",
      replaced: false,
    },
  }),
];

/** The skills as the Skills page lists them, each with its own title. */
const SKILLS = [
  { slug: "skill-creator", title: "Write a skill" },
  { slug: "bot-creator", title: "Make a coworker" },
  { slug: "research-public-web", title: "Research the public web" },
].map(({ slug, title }) => ({
  id: slug,
  slug,
  title,
  ownerUserId: "dev",
  summary: "",
  instructions: "",
  origin: "bundled",
  installedBy: null,
  grantedTo: [BOT],
  tools: [],
}));

const personal = process.env.OPENBOT_E2E_SUITE === "personal";

test(`${personal ? "Activity" : "Admin Audit"} shows app approvals, skill grants and sign-in in the edition's terms`, async ({
  app,
  browser,
}) => {
  await browser.route(/\/api\/plugins$/, (route) =>
    route.fulfill({ json: { catalogue: [], servers: [], skills: SKILLS } }),
  );
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events: ROWS }),
    }),
  );
  await app.open(personal ? "/settings/activity" : "/admin/audit");
  await expect(browser.locator("tbody tr[data-outcome]")).toHaveCount(5);
  const rows = (await readAuditRows(browser)).map(
    ({ what, who, decision }) => ({
      what: what[0],
      on: what[1],
      startedBy: who[1],
      decision: decision[0],
    }),
  );
  if (personal) {
    const person = "Started by a person";
    expect(rows).toEqual([
      {
        what: "Let a Bot use an app",
        on: "Notion",
        startedBy: person,
        decision: "Allowed automatically",
      },
      ...SKILLS.map(({ title }) => ({
        what: "Give a Bot a skill",
        on: title,
        startedBy: person,
        decision: "Configuration changed",
      })),
      {
        what: "Set up an app's sign-in",
        on: "Notion",
        startedBy: person,
        decision: "Allowed",
      },
    ]);
    await expect(browser.locator("tbody")).not.toContainText(
      /OAuth|Approve a request|Skill creator|Bot creator|Research public web/,
    );
  } else {
    expect(rows[0]).toMatchObject({
      what: "Approve a request for an app",
      on: "notion",
      decision: "Allowed",
    });
  }
});
