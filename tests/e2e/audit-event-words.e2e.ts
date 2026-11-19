import { test } from "@e2e-dev/web";
import { expect } from "e2e";

function row(
  id: string,
  minute: number,
  eventType: string,
  targetType: string,
  payload: Record<string, string | number | boolean>,
  targetId: string | null = "personal-assistant",
) {
  return {
    id,
    actorUserId: "dev",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType,
    targetId,
    payload: { bot: "personal-assistant", ...payload },
    createdAt: `2026-11-07T11:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** Newest first, as the table draws them. */
const ROWS = [
  row("e1", 59, "mcp.tools_discovered", "agent", {
    offered: 85,
    granted: 85,
    reason: "unavailable",
  }),
  row("e2", 58, "computer.action_failed", "computer", {
    action: "computer_read_file",
    file: "missing-file-9481.txt",
    failure: "There is no file at missing-file-9481.txt.",
  }),
  row("e3", 57, "computer.action_allowed", "computer", {
    action: "computer_write_file",
    file: "allow-test.txt",
  }),
  row("e4", 56, "approval.person_decided", "approval", {
    decision: "allow_once",
    tool: "computer_write_file",
    file: "allow-test.txt",
  }),
  row("e5", 55, "mcp.call_succeeded", "mcp_tool", {}, "parallel/web_search"),
  row("e6", 54, "channel.routed", "agent", { viaMention: true }),
  row("e7", 53, "computer.policy_loaded", "computer", {}),
];

const WORDS = [
  "Choose tools for a run",
  "Read a file",
  "Save a file",
  "Save a file",
  "Search the web",
  "Choose a Bot for a message",
  "Start the computer",
];

const STORED = [
  "mcp.tools_discovered",
  "computer_read_file",
  "computer_write_file",
  "computer_write_file",
  "parallel/web_search",
  "channel.routed",
  "computer.policy_loaded",
];

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const eventsEndpoint = /\/api\/admin\/audit-events(?:\?|$)/;
const what = 'tbody tr [data-column="what"] > div:first-child';

test(`${personal ? "Activity" : "Admin Audit"} shows readable event names and edition-specific identifiers`, async ({
  app,
  browser,
  screen,
}) => {
  await browser.route(eventsEndpoint, (route) => {
    const excluded =
      new URL(route.request.url).searchParams
        .get("excludeEventType")
        ?.split(",") ?? [];
    return route.fulfill({
      json: {
        events: ROWS.filter((event) => !excluded.includes(event.eventType)),
      },
    });
  });
  await app.open(personal ? "/settings/activity" : "/admin/audit");
  const expected = personal
    ? ["Read a file", "Save a file", "Save a file", "Search the web"]
    : WORDS;
  await expect(browser.locator(what)).toHaveCount(expected.length);
  const labels = await browser.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll(selector), (line) => ({
        text: line.textContent,
        title: line.getAttribute("title"),
      })),
    what,
  );
  expect(labels.map((label) => label.text)).toEqual(expected);
  expect(labels.map((label) => label.title)).toEqual(
    personal ? [null, null, null, null] : STORED,
  );

  if (personal) {
    await expect(browser.locator("tbody")).not.toContainText(
      /mcp\.tools_discovered|write_file|read_file/,
    );
    await screen
      .getByRole("searchbox", "Search events")
      .fill("parallel/web_search");
    await expect(browser.locator(what)).toHaveCount(1);
    await expect(browser.locator(what)).toHaveText("Search the web");
  }
});

if (personal) {
  test("Activity uses the readable Gmail Action names from its App page", async ({
    app,
    browser,
  }) => {
    const actions = [
      { tool: "GMAIL_SETTINGS_GET_IMAP", name: "Get IMAP settings" },
      { tool: "GMAIL_UPDATE_POP_SETTINGS", name: "Update POP settings" },
      {
        tool: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
        name: "Fetch thread messages",
      },
      { tool: "GMAIL_WHO_AM_I", name: "Who am I" },
    ];
    const events = actions.map(({ tool }, i) =>
      row(
        `gmail-${i}`,
        50 - i,
        "mcp.call_succeeded",
        "mcp_tool",
        {},
        `composio-gmail/${tool}`,
      ),
    );
    await browser.route(eventsEndpoint, (route) =>
      route.fulfill({ json: { events } }),
    );
    await app.open("/settings/activity");
    await expect(browser.locator(what)).toHaveCount(4);
    const shown = await browser.evaluate(
      (selector) =>
        Array.from(
          document.querySelectorAll(selector),
          (line) => line.textContent,
        ),
      what,
    );
    expect(shown).toEqual(actions.map(({ name }) => name));
  });
}
