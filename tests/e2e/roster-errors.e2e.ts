import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const agentsPath = /\/api\/agents$/;
const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const sharedFailure = "Couldn't load the Bots shared with you.";
const composerFailure =
  "Couldn't load your Bots, so there's no one to send this to. Reload the page.";
const noShared = "Nobody has shared a Bot with you yet.";
const rosterFailure = "Could not load Bots.";

if (!personal) {
  test("first-load roster failures are visible on Home and the Bots page", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.route(agentsPath, (route) => route.fulfill({ status: 500 }));
    await app.open("/");
    await expect(
      screen.getByText(sharedFailure, { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText(composerFailure, { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText(noShared, { exact: true })).toHaveCount(0);
    await expect(
      screen.getByRole("textbox", "Message", { exact: true }),
    ).toHaveAttribute("aria-disabled", "true");

    await screen.getByRole("link", /^Bots(?: Unread messages)?$/).tap();
    await expect(
      screen.getByText(rosterFailure, { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText("No Bots yet", { exact: true })).toHaveCount(
      0,
    );
  });
}

for (const shared of personal ? [false] : [true, false]) {
  const kind = shared ? "shared" : "private";
  test(`a failed Home refresh keeps a loaded ${kind} roster and the composer usable`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    let offline = false;
    let failures = 0;
    await browser.route(agentsPath, async (route) => {
      if (offline) {
        await route.fulfill({ status: 500 });
        failures++;
        return;
      }
      const response = await route.fetch();
      const { agents } = await response.json<{ agents: { id: string }[] }>();
      const own = agents.find(({ id }) => id === bot.id);
      if (!own) throw new Error("The created Bot is missing from the roster");
      await route.fulfill({
        json: {
          agents: [
            {
              ...own,
              mine: !shared,
              visibility: shared ? "public" : "private",
            },
          ],
        },
      });
    });
    await app.open("/bots");
    await expect(
      screen.getByRole("link", new RegExp(RegExp.escape(bot.name))),
    ).toBeVisible();
    offline = true;
    await screen.getByRole("link", "OpenBot", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/$/);
    await expect.poll(() => failures).toBeGreaterThanOrEqual(2);
    await expect(screen.getByText(sharedFailure, { exact: true })).toHaveCount(
      0,
    );
    await expect(
      screen.getByText(composerFailure, { exact: true }),
    ).toHaveCount(0);
    const editor = screen.getByRole("textbox", "Message", { exact: true });
    await editor.fill("I can still write after the refresh.");
    await expect(editor).toHaveText("I can still write after the refresh.");
    const explore = screen.getByRole("heading", "Explore Bots", {
      exact: true,
    });
    if (shared) {
      await expect(explore).toBeVisible();
      await expect(
        screen.getByRole("link", new RegExp(RegExp.escape(bot.name))),
      ).toBeVisible();
      await expect(screen.getByText(noShared, { exact: true })).toHaveCount(0);
    } else if (personal) {
      await expect(explore).toHaveCount(0);
      await expect(screen.getByText(noShared, { exact: true })).toHaveCount(0);
    } else {
      await expect(explore).toBeVisible();
      await expect(screen.getByText(noShared, { exact: true })).toBeVisible();
    }

    await screen.getByRole("link", /^Bots(?: Unread messages)?$/).tap();
    await expect.poll(() => failures).toBeGreaterThanOrEqual(4);
    await expect(
      screen.getByRole("link", new RegExp(RegExp.escape(bot.name))),
    ).toBeVisible();
    await expect(screen.getByText(rosterFailure, { exact: true })).toHaveCount(
      0,
    );
  });
}
