import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const path = "/capabilities/memory";
const preference = "I prefer mornings.";
const receipts = "Receipts go to finance@.";
const newFact = "I work from Lisbon.";

function memory(id: string, content: string, botId: string | null = null) {
  return {
    id,
    content,
    provenance: "You told a Bot",
    sourceId: null,
    enabled: true,
    reviewState: botId ? "unreviewed" : "confirmed",
    formedBy: botId ? "bot" : "person",
    formedByAgentId: botId,
    sourceApp: botId ? "Gmail" : null,
    sourceLink: null,
    observedAt: null,
    updatedAt: "2026-10-09T10:00:00Z",
  };
}

async function serveMemory(
  browser: Browser,
  botId: string | null,
  refusal?: string,
) {
  const memories = [memory("m1", preference)];
  if (botId) memories.push(memory("m2", receipts, botId));
  const writes: { request: string; body: unknown }[] = [];
  await browser.route(/\/api\/memory(?:\/m1)?$/, (route) => {
    if (route.request.method === "GET")
      return route.fulfill({ json: { memories } });
    const pathname = new URL(route.request.url).pathname;
    const body = JSON.parse(route.request.postData ?? "null");
    writes.push({ request: `${route.request.method} ${pathname}`, body });
    if (refusal && writes.length === 1)
      return route.fulfill({ status: 400, json: { error: refusal } });
    if (route.request.method === "PATCH") {
      const stored = memories.find(({ id }) => pathname.endsWith(`/${id}`));
      if (!stored)
        return route.fulfill({
          status: 404,
          json: { error: "Unknown fixture memory" },
        });
      stored.enabled = body.enabled;
      return route.fulfill({ json: { memory: stored } });
    }
    const stored = memory("m3", body.content);
    memories.push(stored);
    return route.fulfill({ status: 201, json: { memory: stored } });
  });
  return writes;
}

test("Memory attributes a learned fact and gives every fact an independently named switch", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const writes = await serveMemory(browser, bot.id);
  await app.open("/settings/memory");
  await expect(browser).toHaveURL(path);
  await expect(
    screen.getByText(`Formed by ${bot.name}`, { exact: false }),
  ).toBeVisible();
  const personalFact = screen.getByRole(
    "switch",
    `Use this memory: ${preference}`,
    { exact: true },
  );
  const learnedFact = screen.getByRole(
    "switch",
    `Use this memory: ${receipts}`,
    { exact: true },
  );
  await expect(personalFact).toHaveAttribute("aria-checked", "true");
  await expect(learnedFact).toHaveAttribute("aria-checked", "true");
  await personalFact.click();
  await expect(personalFact).toHaveAttribute("aria-checked", "false");
  await expect(learnedFact).toHaveAttribute("aria-checked", "true");
  expect(writes).toEqual([
    { request: "PATCH /api/memory/m1", body: { enabled: false } },
  ]);
  await browser.reload();
  await expect(personalFact).toHaveAttribute("aria-checked", "false");
});

test("Remember a fact starts clean when reopened after failure and saves the retried fact", async ({
  app,
  browser,
  screen,
}) => {
  const failure = "Memory is full.";
  const writes = await serveMemory(browser, null, failure);
  await app.open(path);
  const open = screen.getByRole("button", "Remember a fact", { exact: true });
  const dialog = screen.getByRole("dialog", "Remember a fact");
  const field = dialog.getByRole(
    "textbox",
    "Something you want your Bots to know",
  );
  const save = dialog.getByRole("button", "Remember", { exact: true });
  await open.click();
  await field.fill(newFact);
  await save.click();
  const error = dialog.getByRole("alert");
  await expect(error).toBeVisible();
  await error.getByText("Details", { exact: true }).click();
  await expect(error.getByText(failure, { exact: true })).toBeVisible();
  await field.press("Escape");
  await expect(dialog).toHaveCount(0);
  await open.click();
  await expect(field).toHaveValue("");
  await expect(error).toHaveCount(0);
  await field.fill(newFact);
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(screen.getByText(newFact, { exact: true })).toBeVisible();
  expect(writes).toEqual([
    { request: "POST /api/memory", body: { content: newFact } },
    { request: "POST /api/memory", body: { content: newFact } },
  ]);
  await browser.reload();
  await expect(screen.getByText(newFact, { exact: true })).toBeVisible();
});
