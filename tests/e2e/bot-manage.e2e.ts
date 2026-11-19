import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";

test("hiding returns to the roster, unhiding stays on the Bot page and Duplicate opens the copy", async (fixtures) => {
  const { browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const botPath = `/bots/${bot.id}`;
  const actionPath = `/api/agents/${RegExp.escape(bot.id)}`;
  const hidden = screen.getByRole("switch", "Hidden", { exact: true });
  const pinned = screen.getByRole("switch", "Pinned", { exact: true });
  const suffix = personal ? "" : " Only your list changes.";
  await expect(hidden).toHaveAttribute("aria-checked", "false");
  await expect(pinned).toHaveAttribute("aria-checked", "false");
  await expect(
    screen.getByText(`Keep it at the top of your Bots list.${suffix}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    screen.getByText(`Take it off your Bots list.${suffix}`, { exact: true }),
  ).toBeVisible();

  await pinned.tap();
  await expect(pinned).toHaveAttribute("aria-checked", "true");
  await expect(
    screen.getByText(`At the top of your Bots list.${suffix}`, { exact: true }),
  ).toBeVisible();
  const hiddenResponse = browser.waitForResponse(
    new RegExp(`${actionPath}/hide$`),
  );
  await hidden.tap();
  expect((await hiddenResponse).status).toBeLessThan(300);
  await expect(browser).toHaveURL(/\/bots\/?$/);
  const row = screen.getByRole("link", new RegExp(RegExp.escape(bot.name)));
  await expect(row).toHaveCount(0);
  await screen.getByRole("button", "Show", { exact: true }).tap();
  await expect(row).toHaveAttribute("href", botPath);
  await row.tap();
  await expect(browser).toHaveURL(new RegExp(`${RegExp.escape(botPath)}$`));
  await expect(hidden).toHaveAttribute("aria-checked", "true");
  await expect(
    screen.getByText(`Under Hidden on your Bots list.${suffix}`, {
      exact: true,
    }),
  ).toBeVisible();

  const unhiddenResponse = browser.waitForResponse(
    new RegExp(`${actionPath}/unhide$`),
  );
  await hidden.tap();
  expect((await unhiddenResponse).status).toBeLessThan(300);
  await expect(hidden).toHaveAttribute("aria-checked", "false");
  await expect(browser).toHaveURL(new RegExp(`${RegExp.escape(botPath)}$`));
  await expect(
    screen.getByRole("heading", bot.name, { exact: true }),
  ).toBeVisible();

  const duplicated = browser.waitForResponse(
    new RegExp(`${actionPath}/duplicate$`),
  );
  await screen.getByRole("button", /^Duplicate/).tap();
  const response = await duplicated;
  expect(response.status).toBeLessThan(300);
  const { agent: copy } = await response.json<{
    agent: { id: string; name: string };
  }>();
  expect(copy.id).not.toBe(bot.id);
  await expect(browser).toHaveURL(
    new RegExp(`/bots/${RegExp.escape(copy.id)}$`),
  );
  await expect(
    screen.getByRole("heading", copy.name, { exact: true }),
  ).toBeVisible();
});

test("Reset and Delete explain their scope before confirming", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  await createConversation(browser, bot.id);
  await app.open(`/bots/${bot.id}`);
  const reset = screen.getByRole("button", /^Reset/);
  const remove = screen.getByRole("button", /^Delete/);
  const duplicate = screen.getByRole("button", /^Duplicate/);
  const chevrons = browser
    .locator("button")
    .filter({ has: browser.locator(".tabler-icon-chevron-right") });
  await expect(chevrons.filter({ hasText: /^Reset\b/ })).toHaveCount(1);
  await expect(chevrons.filter({ hasText: /^Delete\b/ })).toHaveCount(1);
  await expect(duplicate).toBeVisible();
  await expect(chevrons.filter({ hasText: /^Duplicate\b/ })).toHaveCount(0);
  await expect(reset).toContainText(
    personal
      ? "Delete your conversations with it and its scheduled work."
      : "what it remembers for you",
  );
  await expect(remove).toContainText(
    personal
      ? "You can still read your conversations with it."
      : "Deletes it for everyone.",
  );

  await reset.tap();
  const resetDialog = screen.getByRole(
    "dialog",
    new RegExp(`^Reset ${RegExp.escape(bot.name)}`),
  );
  await expect(
    resetDialog.getByText("1 conversation", { exact: true }),
  ).toBeVisible();
  await expect(resetDialog).toContainText(
    `This deletes what ${bot.name} has with you.`,
  );
  if (personal) {
    await expect(resetDialog).not.toContainText(/other people|memor/i);
  } else {
    await expect(resetDialog).toContainText(
      "Other people's conversations and data stay.",
    );
    await expect(resetDialog).toContainText(
      "Memories you told a Bot yourself are kept.",
    );
  }
  await resetDialog.getByRole("button", "Cancel", { exact: true }).tap();
  await expect(resetDialog).toHaveCount(0);

  await remove.tap();
  const deleteDialog = screen.getByRole(
    "dialog",
    new RegExp(`^Delete ${RegExp.escape(bot.name)}`),
  );
  await expect(deleteDialog).toContainText(
    personal
      ? "You can still read your conversations with it, but it can't reply."
      : "It's deleted for everyone.",
  );
  await deleteDialog.getByRole("button", "Cancel", { exact: true }).tap();
  await expect(deleteDialog).toHaveCount(0);
  await expect(
    screen.getByRole("heading", bot.name, { exact: true }),
  ).toBeVisible();
});

if (!personal) {
  test("an assigned Bot stays pinned and a user without management rights cannot delete it", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    await browser.route(
      new RegExp(`/api/agents/${RegExp.escape(bot.id)}$`),
      async (route) => {
        const response = await route.fetch();
        const data = await response.json<{ agent: Record<string, unknown> }>();
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ...data,
            agent: {
              ...data.agent,
              assignedToMe: true,
              canManage: false,
              mine: false,
              hidden: false,
              pinned: false,
            },
          }),
        });
      },
    );
    await app.open(`/bots/${bot.id}`);
    const pinned = screen.getByRole("switch", "Pinned", { exact: true });
    await expect(pinned).toHaveAttribute("aria-checked", "true");
    await expect(pinned).toBeDisabled();
    const hidden = screen.getByRole("switch", "Hidden", { exact: true });
    await expect(hidden).toHaveAttribute("aria-checked", "false");
    await expect(hidden).toBeDisabled();
    await expect(
      screen.getByText(
        "An admin assigned it to you. It stays at the top of your Bots list.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(screen.getByRole("button", /^Delete/)).toHaveCount(0);
    await expect(screen.getByRole("button", /^Duplicate/)).toBeVisible();
  });
}
