import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const BOT = "chatgpt-plan-check";
const GOAL_TOOLS = [
  "routines/complete_goal",
  "routines/create_goal",
  "routines/list_goals",
  "routines/pause_goal",
  "routines/resume_goal",
  "routines/run_goal",
  "routines/update_goal",
];

function row(
  id: string,
  minute: number,
  fields: {
    eventType: string;
    targetType: string;
    targetId: string;
    initiatorKind: string;
    payload: Record<string, string | string[]>;
  },
) {
  return {
    id,
    actorUserId: null,
    initiatorId: null,
    ...fields,
    payload: { bot: BOT, ...fields.payload },
    createdAt: `2026-11-07T17:${String(minute).padStart(2, "0")}:32Z`,
  };
}

/** Newest first, as the table draws them. */
const ROWS = [
  // What a start writes now: one row per Bot, every tool it was given, started by OpenBot.
  row("given", 59, {
    eventType: "configuration.changed",
    targetType: "mcp_server",
    targetId: "routines",
    initiatorKind: "deployment",
    payload: {
      actor: "openbot:always-on",
      change: "plugin_granted",
      kind: "mcp",
      app: "routines",
      refs: GOAL_TOOLS,
    },
  }),
  // What the upgrade wrote before: one row per tool, recorded as started by a person.
  row("legacy", 58, {
    eventType: "configuration.changed",
    targetType: "mcp_tool",
    targetId: "routines/complete_goal",
    initiatorKind: "person",
    payload: {
      actor: "openbot:always-on",
      change: "plugin_granted",
      kind: "mcp",
      ref: "routines/complete_goal",
    },
  }),
  // A person really giving a Bot an app's tool.
  row("person-grant", 57, {
    eventType: "configuration.changed",
    targetType: "mcp_tool",
    targetId: "composio-gmail/GMAIL_SEND_EMAIL",
    initiatorKind: "person",
    payload: {
      actor: "dev",
      change: "plugin_granted",
      kind: "mcp",
      ref: "composio-gmail/GMAIL_SEND_EMAIL",
    },
  }),
  // The Bot using that tool.
  row("call", 56, {
    eventType: "mcp.call_succeeded",
    targetType: "mcp_tool",
    targetId: "composio-gmail/GMAIL_SEND_EMAIL",
    initiatorKind: "person",
    payload: { actor: "dev" },
  }),
  // A component a build brought, published on arrival when a page announced it, recorded as the
  // person whose page that was.
  row("component", 55, {
    eventType: "component.published",
    targetType: "component",
    targetId: "showTable",
    initiatorKind: "person",
    payload: {
      actor: "dev@openbot.local",
      note: "First seen in a build, published and available to every Bot.",
    },
  }),
];

const ACTIVITY = [
  {
    what: "Give a Bot tools",
    on: "Complete goal, create goal and 5 more on Routines",
    startedBy: "Started by OpenBot",
  },
  {
    // Recorded as a person's before the fix. Its own actor says it was OpenBot's.
    what: "Give a Bot a tool",
    on: "Complete goal on Routines",
    startedBy: "Started by OpenBot",
  },
  {
    what: "Give a Bot a tool",
    on: "Send email on Gmail",
    startedBy: "Started by a person",
  },
  { what: "Send email", on: "Gmail", startedBy: "Started by a person" },
];

const AUDIT = [
  {
    what: "Give a Bot tools",
    on: GOAL_TOOLS.join(", "),
    startedBy: "Started by this deployment",
  },
  {
    what: "Give a Bot a tool",
    on: "routines/complete_goal",
    startedBy: "Started by this deployment",
  },
  {
    what: "Give a Bot a tool",
    on: "composio-gmail/GMAIL_SEND_EMAIL",
    startedBy: "Started by a person",
  },
  {
    what: "Send email",
    on: "composio-gmail/GMAIL_SEND_EMAIL",
    startedBy: "Started by a person",
  },
  {
    what: "Publish a component",
    on: "showTable",
    startedBy: "Started by this deployment",
  },
];

const personal = process.env.OPENBOT_E2E_SUITE === "personal";

test(`${personal ? "Activity" : "Admin Audit"} describes legacy and current Bot tool grants`, async ({
  app,
  browser,
}) => {
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) => {
    const excluded =
      new URL(route.request.url).searchParams
        .get("excludeEventType")
        ?.split(",") ?? [];
    return route.fulfill({
      json: { events: ROWS.filter((row) => !excluded.includes(row.eventType)) },
    });
  });
  await app.open(personal ? "/settings/activity" : "/admin/audit");
  const expected = personal ? ACTIVITY : AUDIT;
  await expect(browser.locator("tbody tr")).toHaveCount(expected.length);
  const rows = await browser.evaluate(() =>
    Array.from(document.querySelectorAll("tbody tr"), (tr) => {
      const what = Array.from(
        tr.querySelector('[data-column="what"]')?.children ?? [],
        (line) => line.textContent,
      );
      const who = tr.querySelector('[data-column="bot"]')?.children;
      return {
        what: what[0] ?? "",
        on: what[1] ?? "",
        startedBy: who?.[1]?.textContent ?? "",
      };
    }),
  );
  expect(rows).toEqual(expected);
  if (personal) {
    await expect(browser.locator("tbody")).not.toContainText(
      /routines\/|_goal|composio-gmail|GMAIL_SEND_EMAIL|Change a setting/,
    );
  }
});
