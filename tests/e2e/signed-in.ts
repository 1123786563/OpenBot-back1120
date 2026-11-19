import { type Browser, test } from "@e2e-dev/web";
import { credentials, expect, type TestFixtures } from "e2e";

const suite = process.env.OPENBOT_E2E_SUITE;
export const workspace =
  suite === "authenticated" || suite === "live" ? { session: "workspace" } : {};

if (workspace.session) {
  test.setup(
    "sign in to the personal workspace through Casdoor",
    { sessions: ["workspace"], trace: "off" },
    async ({ app, browser, screen, session }) => {
      const account = credentials.user("casdoor");
      await app.open("/sign");
      await browser
        .locator('input[autocomplete="username"], input[id="username"]')
        .fill(account.username);
      await browser.locator('input[type="password"]').fill(account.password);
      await screen.getByRole("button", /^(sign in|log in)$/i).tap();
      await browser.waitForURL(
        new RegExp(
          `^${RegExp.escape(new URL(app.baseUrl).origin)}(?:/$|/(?!api/|sign(?:[/?#]|$)))`,
        ),
      );
      const status = await browser.evaluate(async () => {
        const response = await fetch("/api/me/onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ completed: true }),
        });
        return response.status;
      });
      if (status !== 200)
        throw new Error(`Could not prepare the test workspace: HTTP ${status}`);
      await app.open("/bots");
      await expect(
        screen.getByRole("heading", "Bots", { exact: true }),
      ).toBeVisible();
      await session.save("workspace");
    },
  );
}

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

export async function createBot({ app, browser, screen }: Fixtures) {
  const name = `E2E Bot ${crypto.randomUUID().slice(0, 8)}`;
  await app.open("/bots");
  await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
  await browser.locator("#new-bot-name").fill(name);
  await screen.getByRole("button", "Create Bot", { exact: true }).tap();
  await expect(browser).toHaveURL(/\/bots\/[^/?#]+\/?$/);
  await expect(
    screen.getByRole("heading", name, { exact: true }),
  ).toBeVisible();
  const id = new URL(await browser.url()).pathname
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (!id) throw new Error("The created Bot did not open a detail page");
  return { id, name };
}

export async function sendMessage(fixtures: Fixtures) {
  const { app, browser, screen } = fixtures;
  const { id } = await createBot(fixtures);
  const message = "Please reply with a short greeting.";
  await app.open(`/channel/new?agent=${encodeURIComponent(id)}`);
  await browser
    .locator('[data-slot="composer-input"] [role="textbox"]')
    .fill(message);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect(browser).toHaveURL(/\/channel\/(?!new(?:[/?#]|$))[^/?#]+/);
  await expect(screen.getByText(message, { exact: true })).toBeVisible();
  return browser.locator(
    '[data-slot="message"][data-align="start"] [data-slot="message-content"]',
  );
}
