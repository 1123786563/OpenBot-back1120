import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";

test("activity records show named, hidden and deleted Bots without exposing their IDs", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const hiddenId = "fixture-hidden-bot";
  const hiddenName = "Research colleague";
  const goneId = "fixture-deleted-bot";
  const events = [
    {
      id: "write",
      targetId: bot.id,
      file: "draft.txt",
      action: "computer_write_file",
      initiatorKind: "person",
      initiatorId: null,
    },
    {
      id: "handoff",
      targetId: hiddenId,
      file: "notes.txt",
      action: "computer_read_file",
      initiatorKind: "handoff",
      initiatorId: bot.id,
    },
    {
      id: "old",
      targetId: goneId,
      file: "archive.txt",
      action: "computer_read_file",
      initiatorKind: "person",
      initiatorId: null,
    },
  ].map(
    ({ id, targetId, file, action, initiatorKind, initiatorId }, index) => ({
      id,
      targetId,
      initiatorKind,
      initiatorId,
      actorUserId: null,
      eventType: "computer.action_allowed",
      targetType: "computer",
      payload: { bot: targetId, action, file },
      createdAt: `2026-11-07T11:3${index}:00Z`,
    }),
  );
  const release = Promise.withResolvers<void>();
  let rosterReads = 0;
  await browser.route(/\/api\/agents(?:\?hidden=true)?$/, async (route) => {
    rosterReads++;
    await release.promise;
    const hidden = new URL(route.request.url).searchParams.has("hidden");
    return route.fulfill({
      json: {
        agents: hidden
          ? [{ id: hiddenId, name: hiddenName, hidden: true }]
          : [bot],
      },
    });
  });
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) =>
    route.fulfill({ json: { events } }),
  );
  const userFacingIdentifiers = () =>
    browser.evaluate(() => {
      return [...document.querySelectorAll("tbody")]
        .flatMap((table) => [
          table.textContent ?? "",
          ...[
            ...table.querySelectorAll("[title], [aria-label], [alt]"),
          ].flatMap((element) =>
            ["title", "aria-label", "alt"].map(
              (attribute) => element.getAttribute(attribute) ?? "",
            ),
          ),
        ])
        .join("\n");
    });
  const exposedIds = [bot.id, hiddenId, goneId];
  try {
    await app.open(personal ? "/settings/activity" : "/admin/audit");
    const tableRows = browser.locator("tbody tr[data-outcome]");
    await expect(tableRows).toHaveCount(3);
    await expect.poll(() => rosterReads).toBeGreaterThanOrEqual(2);
    await expect(
      screen.getByText("A Bot no longer here", { exact: true }),
    ).toHaveCount(0);
    const whileLoading = await userFacingIdentifiers();
    for (const id of exposedIds) expect(whileLoading).not.toContain(id);

    release.resolve();
    const write = tableRows.filter({ hasText: "draft.txt" });
    const handoff = tableRows.filter({ hasText: "notes.txt" });
    const old = tableRows.filter({ hasText: "archive.txt" });
    await expect(write).toContainText(bot.name);
    await expect(handoff).toContainText(hiddenName);
    await expect(handoff).toContainText(`Handed on by ${bot.name}`);
    await expect(old).toContainText("A Bot no longer here");
    const displayed = await userFacingIdentifiers();
    for (const id of exposedIds) expect(displayed).not.toContain(id);
  } finally {
    release.resolve();
  }
});

test("a conversation avatar uses the Bot's name in its accessibility label", async (fixtures) => {
  const { app, browser } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(
    browser,
    bot.id,
    "Named avatar conversation",
  );
  await configureChatStream(browser, []);
  await app.open(`/channel/${channelId}`);
  const rowSelector = `[data-sidebar="content"] a[href="/channel/${channelId}"]`;
  const row = browser.locator(rowSelector);
  await expect(row).toBeVisible();
  const avatar = browser
    .locator(`${rowSelector} [role="img"][aria-label]`)
    .first();
  await expect(avatar).toHaveAttribute("aria-label", bot.name);
  await expect(avatar).not.toHaveAttribute("aria-label", bot.id);
  await expect(row).not.toContainText(bot.id);
});
