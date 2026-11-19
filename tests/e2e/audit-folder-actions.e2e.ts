import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { readAuditRows } from "./audit-rows";
import { createBot } from "./signed-in";

function row(
  botId: string,
  id: string,
  minute: number,
  eventType: string,
  payload: Record<string, unknown>,
) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType: "host_access",
    targetId: "grant-notes",
    payload: {
      bot: botId,
      actor: "dev-local-user",
      grant: "grant-notes",
      ...payload,
    },
    createdAt: `2026-11-07T17:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** Newest first, as the server answers. */
const rows = (botId: string) => [
  row(botId, "none", 59, "computer.action_refused", {
    action: "host/list_folders",
    reason: "No host folders are granted to this Bot.",
  }),
  row(botId, "command", 58, "computer.action_allowed", {
    action: "host/run_command",
    command: "dir",
    attempt: "a3",
  }),
  // The person pressed Deny on the desktop: the row written as it went there, and the refusal.
  row(botId, "denied", 57, "computer.action_refused", {
    action: "host/write_file",
    file: "todo.txt",
    attempt: "a2",
    refusal: "person_declined",
    reason: "The local owner denied this operation.",
  }),
  row(botId, "asked", 57, "computer.action_allowed", {
    action: "host/write_file",
    file: "todo.txt",
    attempt: "a2",
  }),
  row(botId, "read", 56, "computer.action_allowed", {
    action: "host/read_file",
    file: "todo.txt",
    attempt: "a1",
  }),
  // As they were recorded before: a setting changed, the operation and how it went in the payload.
  row(botId, "old-refused", 50, "configuration.changed", {
    change: "host_access_tool_call",
    operation: "write_file",
    outcome: "refused",
    reason: "The local owner denied this operation.",
  }),
  row(botId, "old-requested", 50, "configuration.changed", {
    change: "host_access_tool_call",
    operation: "write_file",
    outcome: "requested",
  }),
  row(botId, "old-read", 49, "configuration.changed", {
    change: "host_access_tool_call",
    operation: "read_file",
    outcome: "succeeded",
  }),
];

test("Activity describes current and legacy folder actions without duplicating a denied write", async (fixtures) => {
  const { app, browser } = fixtures;
  const { id, name } = await createBot(fixtures);
  const events = rows(id);
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events }),
    }),
  );
  await app.open("/settings/activity");
  await expect(browser.locator("tbody tr[data-outcome]")).toHaveCount(7);
  const bot = [name, "Started by a person"];
  expect(await readAuditRows(browser)).toEqual([
    {
      what: ["Check your folders"],
      who: bot,
      decision: ["Blocked", "No host folders are granted to this Bot."],
      outcome: "refused",
    },
    {
      what: ["Run a command", "dir"],
      who: bot,
      decision: ["Allowed"],
      outcome: "allowed",
    },
    // One row for the denied write, not "Allowed" beside "Blocked".
    {
      what: ["Save a file", "todo.txt"],
      who: bot,
      decision: ["Blocked", "A person denied it when asked."],
      outcome: "refused",
    },
    {
      what: ["Read a file", "todo.txt"],
      who: bot,
      decision: ["Allowed"],
      outcome: "allowed",
    },
    // Older rows read in the same words, though they cannot say which file.
    {
      what: ["Save a file"],
      who: bot,
      decision: ["Blocked"],
      outcome: "refused",
    },
    {
      what: ["Save a file"],
      who: bot,
      decision: ["Asked for"],
      outcome: "allowed",
    },
    {
      what: ["Read a file"],
      who: bot,
      decision: ["Allowed"],
      outcome: "allowed",
    },
  ]);
  await expect(browser.locator("tbody")).not.toContainText("Change a setting");
});
