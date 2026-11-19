import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot, sendMessage } from "./signed-in";

test("a live model returns a completed reply", {
  session: "workspace",
}, async (fixtures) => {
  const reply = await sendMessage(fixtures);
  await expect(reply).toHaveText(/\S/, { timeout: 60_000 });
  await expect(
    fixtures.browser.locator('[data-testid="composer-stop"]'),
  ).toBeHidden();
  await fixtures.browser.reload();
  await expect(reply).toHaveText(/\S/);
});

if (process.env.OPENBOT_E2E_AGENT_MODEL) {
  test("a message sent by the test agent gets the requested live reply", {
    session: "workspace",
  }, async (fixtures) => {
    const { id } = await createBot(fixtures);
    const { agent, app, browser } = fixtures;
    await app.open(`/channel/new?agent=${encodeURIComponent(id)}`);
    const greeting = "Hello from OpenBot.";
    const message = `Reply with exactly this sentence: ${greeting}`;
    await agent.act("Send this exact message to the selected Bot: {message}", {
      params: { message },
    });
    await expect(browser).toHaveURL(/\/channel\/(?!new(?:[/?#]|$))[^/?#]+$/);
    const sent = browser
      .locator('[data-slot="message"][data-align="end"]')
      .getByText(message, { exact: true });
    const reply = browser.locator(
      '[data-slot="message"][data-align="start"] [data-slot="message-content"]',
    );
    await expect(sent).toHaveCount(1);
    await expect(sent).toBeVisible();
    await expect(reply).toHaveText(greeting, { timeout: 60_000 });
    await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
    await expect(reply).toHaveText(greeting);
    await browser.reload();
    await expect(sent).toHaveCount(1);
    await expect(sent).toBeVisible();
    await expect(reply).toHaveText(greeting);
  });
}
