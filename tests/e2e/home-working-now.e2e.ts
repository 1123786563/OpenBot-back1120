import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

test("home links to the working conversation and hides the note while all Bots are idle", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const busyTitle = "Plan the Lisbon trip budget";
  const idleTitle = "Book the dentist";
  const busyId = await createConversation(browser, bot.id, busyTitle);
  const idleId = await createConversation(browser, bot.id, idleTitle);
  let working = false;
  const roster = /\/api\/channels(?:\?[^#]*)?$/;
  await browser.route(roster, async (route) => {
    if (route.request.method !== "GET") return route.continue();
    const response = await route.fetch();
    const page = await response.json<{
      channels: { id: string }[];
      nextCursor: string | null;
    }>();
    return route.fulfill({
      json: {
        ...page,
        channels: page.channels.map((channel) => ({
          ...channel,
          ...(channel.id === busyId
            ? { name: bot.name, summary: busyTitle, busy: working }
            : {}),
          ...(channel.id === idleId
            ? { name: bot.name, summary: idleTitle, busy: false }
            : {}),
        })),
      },
    });
  });
  const note = screen.getByRole(
    "link",
    new RegExp(`${RegExp.escape(bot.name)} is working`),
  );
  const firstRoster = browser.waitForResponse(roster);
  await app.open("/");
  await firstRoster;
  await expect(
    screen.getByRole("link", idleTitle, { exact: false }).first(),
  ).toBeVisible();
  await expect(note).toHaveCount(0);

  working = true;
  const currentRoster = browser.waitForResponse(roster);
  await browser.reload();
  await currentRoster;
  await expect(note).toBeVisible();
  await expect(note).toContainText(busyTitle);
  await expect(note).not.toContainText(idleTitle);
  await expect(note).toHaveAttribute("href", `/channel/${busyId}`);
  await note.click();
  await expect(browser).toHaveURL(`/channel/${busyId}`);
  await expect(
    screen.getByRole("region", "Messages", { exact: true }),
  ).toBeVisible();
});
