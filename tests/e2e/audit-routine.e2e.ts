import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";

function event(
  id: string,
  minute: number,
  data: {
    eventType: string;
    targetType: string;
    targetId: string;
    initiatorKind: "person" | "deployment";
    payload: {
      actor?: string;
      function?: string;
      functions?: string[];
      agentId?: string;
      channelId?: null;
      cron?: string;
    };
  },
) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorId: null,
    ...data,
    createdAt: `2026-11-08T03:${minute}:00Z`,
  };
}

function grant(
  id: string,
  minute: number,
  functions: { function: string } | { functions: string[] },
) {
  return event(id, minute, {
    eventType: "component.function_granted",
    targetType: "component",
    targetId: "showActivityReport",
    initiatorKind: "deployment",
    payload: { actor: "person@example.test", ...functions },
  });
}

test(`${personal ? "Activity" : "Admin Audit"} shows component grants and the Routine under its Bot`, async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const events = [
    event("routine", 30, {
      eventType: "routine.created",
      targetType: "routine",
      targetId: "routine-1",
      initiatorKind: "person",
      payload: { agentId: bot.id, channelId: null, cron: "0 9 * * *" },
    }),
    grant("given", 25, { functions: ["botActivity", "recentRefusals"] }),
    grant("given-one", 20, { function: "botActivity" }),
    grant("given-two", 20, { function: "recentRefusals" }),
  ];
  const reads: {
    excludedEvents: string | null;
    excludedCalls: string | null;
  }[] = [];
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) => {
    const search = new URL(route.request.url).searchParams;
    reads.push({
      excludedEvents: search.get("excludeEventType"),
      excludedCalls: search.get("excludeCalls"),
    });
    return route.fulfill({ json: { events } });
  });
  await app.open(personal ? "/settings/activity" : "/admin/audit");
  await expect(
    screen.getByText("Create a routine", { exact: true }),
  ).toBeVisible();
  await expect(browser.locator("tbody tr")).toHaveCount(4);
  const rows = await browser.evaluate(() => {
    function lines(cell: Element | null) {
      return Array.from(cell?.children ?? [], (line) => line.textContent);
    }
    return Array.from(document.querySelectorAll("tbody tr"), (row) => ({
      what: lines(row.querySelector('[data-column="what"]')),
      who: lines(row.querySelector('[data-column="bot"]')),
    }));
  });
  const label = "Let a component read data";
  if (personal) {
    expect(reads[0]).toEqual({
      excludedEvents:
        "mcp.tools_discovered,channel.routed,component.published,component.description_updated,computer.policy_loaded,computer.isolation_loaded",
      excludedCalls:
        "routines/create_routine,routines/update_routine,routines/delete_routine",
    });
    const startedByOpenBot = ["-", "Started by OpenBot"];
    expect(rows).toEqual([
      { what: ["Create a routine"], who: [bot.name, "Started by a person"] },
      {
        what: [
          label,
          "Activity report · your Bots' activity and what was refused",
        ],
        who: startedByOpenBot,
      },
      {
        what: [label, "Activity report · your Bots' activity"],
        who: startedByOpenBot,
      },
      {
        what: [label, "Activity report · what was refused"],
        who: startedByOpenBot,
      },
    ]);
  } else {
    expect(reads[0]).toEqual({ excludedEvents: null, excludedCalls: null });
    expect(rows.map(({ what }) => what)).toEqual([
      ["Create a routine"],
      [label, "showActivityReport · botActivity, recentRefusals"],
      [label, "showActivityReport · botActivity"],
      [label, "showActivityReport · recentRefusals"],
    ]);
  }
});
