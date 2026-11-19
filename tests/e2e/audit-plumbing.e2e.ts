import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { readAuditRows } from "./audit-rows";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const eventsEndpoint = /\/api\/admin\/audit-events(?:\?|$)/;
const BOT = "fixture-bot";

function row(
  id: string,
  minute: number,
  eventType: string,
  targetType: string,
  payload: Record<string, unknown>,
) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType,
    targetId: id,
    payload,
    createdAt: `2026-11-07T18:${String(minute).padStart(2, "0")}:00Z`,
  };
}

const CHOOSE_TOOLS = row("tools", 2, "mcp.tools_discovered", "bot", {
  bot: BOT,
  reason: "unavailable",
  granted: 96,
  offered: 96,
  skills: [],
});
const READ = row("read", 1, "computer.action_allowed", "host_access", {
  bot: BOT,
  action: "host/read_file",
  file: "todo.txt",
});

const FOLDER_ROWS = [
  row("given", 9, "configuration.changed", "host_access", {
    change: "host_folder_granted",
    bot: BOT,
    folder: "share",
  }),
  row("taken", 8, "configuration.changed", "host_access", {
    change: "host_folder_revoked",
    bot: BOT,
    folder: "share",
  }),
  row("stopped", 7, "configuration.changed", "host_access", {
    change: "host_access_stopped",
    bot: BOT,
    folders: ["share", "Documents"],
  }),
  row("old-given", 3, "configuration.changed", "host_access", {
    actorUserId: "dev-local-user",
    targetId: "old-given",
    change: "host_folder_granted",
    botId: BOT,
  }),
  row("old-taken", 2, "configuration.changed", "host_access", {
    actorUserId: "dev-local-user",
    targetId: "old-given",
    change: "host_folder_revoked",
  }),
  row("old-stopped", 1, "configuration.changed", "host_access", {
    actorUserId: "dev-local-user",
    change: "host_access_stopped",
  }),
];

async function cells(browser: Browser) {
  const rows = await readAuditRows(browser);
  return rows.map(({ what, who, decision }) => ({ what, who, decision }));
}

test(`${personal ? "Activity" : "Admin Audit"} requests the appropriate tool-selection records`, async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { id, name } = await createBot(fixtures);
  const requests: { exclude: string | null; initiator: string | null }[] = [];
  const events = [CHOOSE_TOOLS, READ].map((event) => ({
    ...event,
    payload: { ...event.payload, bot: id },
  }));
  await browser.route(eventsEndpoint, (route) => {
    const search = new URL(route.request.url).searchParams;
    const exclude = search.get("excludeEventType");
    const initiator = search.get("initiatorKind");
    requests.push({ exclude, initiator });
    const visible = events.filter(
      (event) =>
        !exclude?.split(",").includes(event.eventType) &&
        (!initiator || initiator.split(",").includes(event.initiatorKind)),
    );
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events: visible }),
    });
  });
  await app.open(personal ? "/settings/activity" : "/admin/audit");
  const table = browser.locator("tbody");
  const read = {
    what: ["Read a file", "todo.txt"],
    who: [name, "Started by a person"],
    decision: ["Allowed"],
  };
  await expect(table.getByText("todo.txt", { exact: true })).toBeVisible();
  if (personal) {
    expect(await cells(browser)).toEqual([read]);
    const excluded = requests[0]?.exclude;
    expect(excluded?.split(",")).toContain("mcp.tools_discovered");
    await screen.getByRole("button", "Nobody watching", { exact: true }).tap();
    await expect(screen.getByText("No matches", { exact: true })).toBeVisible();
    expect(requests).toEqual([
      { exclude: excluded, initiator: null },
      { exclude: excluded, initiator: "routine,handoff,responsibility,memory" },
    ]);
  } else {
    expect(await cells(browser)).toEqual([
      {
        what: ["Choose tools for a run", "96 of 96 tools"],
        who: [name, "Started by a person"],
        decision: [
          "Tools offered for one run",
          "Couldn't choose, so all were offered",
        ],
      },
      read,
    ]);
    expect(requests).toEqual([{ exclude: null, initiator: null }]);
  }
});

if (personal) {
  test("Activity identifies folder grants, revocations and access stops in new and legacy records", async (fixtures) => {
    const { app, browser } = fixtures;
    const { id, name } = await createBot(fixtures);
    const events = FOLDER_ROWS.map((row) => {
      const payload = { ...row.payload };
      if ("bot" in payload) payload.bot = id;
      if ("botId" in payload) payload.botId = id;
      return { ...row, payload };
    });
    await browser.route(eventsEndpoint, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ events }),
      }),
    );
    await app.open("/settings/activity");
    await expect(browser.locator("tbody tr[data-outcome]")).toHaveCount(6);
    const person = "Started by a person";
    const changed = ["Configuration changed"];
    expect(await cells(browser)).toEqual([
      {
        what: ["Give a Bot a folder", "share"],
        who: [name, person],
        decision: changed,
      },
      {
        what: ["Take a folder from a Bot", "share"],
        who: [name, person],
        decision: changed,
      },
      {
        what: ["Stop folder access", "share, Documents"],
        who: [name, person],
        decision: changed,
      },
      // Older rows read as well as what they kept: the Bot a folder was given to, and no folder.
      {
        what: ["Give a Bot a folder"],
        who: [name, person],
        decision: changed,
      },
      {
        what: ["Take a folder from a Bot"],
        who: ["-", person],
        decision: changed,
      },
      { what: ["Stop folder access"], who: ["-", person], decision: changed },
    ]);
    await expect(browser.locator("tbody")).not.toContainText(
      "Change a setting",
    );
  });
}
