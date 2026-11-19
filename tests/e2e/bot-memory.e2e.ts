import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

async function serveMemory(browser: Browser, own: string, other: string) {
  const source = (id: string, agentId: string, title: string) => ({
    id,
    title,
    agentId,
    toolRef: "mcp/drive/search",
    enabled: true,
    syncStatus: "succeeded",
    syncError: null,
    lastSyncAt: null,
  });
  const checkIn = (id: string, agentId: string, focus: string) => ({
    id,
    agentId,
    focus,
    channelId: `channel-${agentId}`,
    enabled: true,
    intervalMinutes: 240,
    nextRunAt: "2026-10-09T12:00:00Z",
    lastRunAt: null,
    lastStatus: "idle",
    lastError: null,
  });
  let sources = [
    source("own-source", own, "Receipts folder"),
    source("other-source", other, "Wiki pages"),
  ];
  const sourceWrites: { method: string; body: unknown }[] = [];
  await browser.route(/\/api\/memory\/sources$/, (route) => {
    if (route.request.method === "GET")
      return route.fulfill({ json: { sources } });
    const body = JSON.parse(route.request.postData ?? "null");
    sourceWrites.push({ method: route.request.method, body });
    if (sourceWrites.length === 1)
      return route.fulfill({
        status: 400,
        json: { error: "That folder cannot be read." },
      });
    const added = source("added-source", body.agentId, body.title);
    sources = [...sources, added];
    return route.fulfill({ json: { source: added } });
  });
  const availableFor: string[] = [];
  await browser.route(/\/api\/memory\/sources\/available\/[^/?]+$/, (route) => {
    availableFor.push(new URL(route.request.url).pathname);
    return route.fulfill({
      json: {
        tools: [
          {
            ref: "mcp/drive/search",
            title: "Search Drive",
            description: "",
            inputSchema: { properties: { name: { type: "string" } } },
          },
        ],
      },
    });
  });
  await browser.route(/\/api\/proactive\/settings$/, (route) =>
    route.fulfill({
      json: {
        settings: [
          checkIn("own-check-in", own, "Unpaid invoices"),
          checkIn("other-check-in", other, "Stale pages"),
        ],
        allowed: true,
      },
    }),
  );
  const runs: string[] = [];
  await browser.route(/\/api\/proactive\/settings\/[^/?]+\/run$/, (route) => {
    runs.push(`${route.request.method} ${new URL(route.request.url).pathname}`);
    return route.fulfill({
      status: 400,
      json: { error: "Research is paused." },
    });
  });
  return { availableFor, sourceWrites, runs };
}

test("a Bot's Memory limits sources and check-ins to that Bot and preserves a failed draft", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const other = await createBot(fixtures);
  const bot = await createBot(fixtures);
  const { availableFor, sourceWrites } = await serveMemory(
    browser,
    bot.id,
    other.id,
  );
  await app.open(`/bots/${bot.id}/memory`);
  await expect(
    screen.getByRole("heading", "Memory", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Receipts folder", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("Wiki pages", { exact: true })).toHaveCount(0);
  await expect(screen.getByText(/Unpaid invoices/)).toBeVisible();
  await expect(screen.getByText(/Stale pages/)).toHaveCount(0);
  const open = screen.getByRole("button", "Add source", { exact: true });
  await open.tap();
  const dialog = screen.getByRole("dialog");
  await expect(dialog.getByRole("combobox", /^Bot/)).toHaveCount(0);
  await dialog.getByRole("combobox", "What to read", { exact: true }).tap();
  await screen.getByRole("option", "Search Drive", { exact: true }).tap();
  expect(availableFor.length).toBeGreaterThan(0);
  expect([...new Set(availableFor)]).toEqual([
    `/api/memory/sources/available/${bot.id}`,
  ]);
  const sourceName = dialog.getByLabel("Source name", { exact: true });
  const toolName = dialog.getByLabel("name", { exact: true });
  await sourceName.fill("Invoices");
  await toolName.fill("Finance folder");
  await expect(sourceName).toHaveValue("Invoices");
  await expect(toolName).toHaveValue("Finance folder");
  const submit = dialog.getByRole("button", "Add and sync source", {
    exact: true,
  });
  await submit.tap();
  await expect(dialog.getByRole("alert")).toContainText(
    "That folder cannot be read.",
  );
  await sourceName.press("Escape");
  await expect(dialog).toHaveCount(0);
  await open.tap();
  await expect(sourceName).toHaveValue("Invoices");
  await expect(toolName).toHaveValue("Finance folder");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await submit.tap();
  await expect(dialog).toHaveCount(0);
  await expect(screen.getByText("Invoices", { exact: true })).toBeVisible();
  const write = {
    method: "POST",
    body: {
      agentId: bot.id,
      toolRef: "mcp/drive/search",
      title: "Invoices",
      args: { name: "Finance folder" },
    },
  };
  expect(sourceWrites).toEqual([write, write]);
});

test("reopening a check-in clears the previous Run now error", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const { runs } = await serveMemory(browser, bot.id, "other-bot");
  await app.open(`/bots/${bot.id}/memory`);
  const edit = screen.getByRole("button", /Unpaid invoices/);
  await edit.tap();
  const dialog = screen.getByRole("dialog", "Check-ins", { exact: true });
  await expect(dialog.getByRole("combobox", /^Bot/)).toHaveCount(0);
  const run = dialog.getByRole("button", "Run now", { exact: true });
  await run.tap();
  const details = dialog.getByRole("button", "Details", { exact: true });
  await details.tap();
  await expect(
    dialog.getByText("Research is paused.", { exact: true }),
  ).toBeVisible();
  await details.press("Escape");
  await expect(dialog).toHaveCount(0);
  await edit.tap();
  await expect(run).toBeEnabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(runs).toEqual(["POST /api/proactive/settings/own-check-in/run"]);
});
