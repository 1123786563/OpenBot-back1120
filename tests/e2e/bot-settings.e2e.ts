import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";

async function serveProfile(
  browser: Browser,
  botId: string,
  read: () => Record<string, unknown>,
) {
  await browser.route(
    new RegExp(`/api/agents/${RegExp.escape(botId)}$`),
    async (route) => {
      const response = await route.fetch();
      const data = await response.json<{ agent: Record<string, unknown> }>();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...data,
          agent: {
            ...data.agent,
            builtIn: false,
            endpoint: "http://agent-harness:4206/ag-ui",
            framework: "LangChain",
            keyFromOpenBot: true,
            ...read(),
          },
        }),
      });
    },
  );
}

test("Bot setup and available settings reflect the deployment edition", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  await serveProfile(browser, bot.id, () => ({}));
  const path = `/bots/${bot.id}`;
  await app.open(path);
  const settings = browser.locator("section").filter({
    has: screen.getByRole("heading", "Settings for this Bot", { exact: true }),
  });
  const setup = settings.getByRole("link", /^Setup/);
  await expect(setup).toHaveAttribute("href", `${path}/setup`);
  if (personal) {
    await expect(setup).toContainText("Runs on LangChain");
    await expect(setup).not.toContainText("agent-harness:4206");
    await expect(settings.getByRole("link")).toHaveCount(3);
    await expect(settings.getByRole("link", /^Routines/)).toHaveAttribute(
      "href",
      `${path}/routines`,
    );
    await expect(settings.getByRole("link", /^What it can do/)).toHaveAttribute(
      "href",
      `${path}/access`,
    );
    await expect(browser.locator(`a[href="${path}/memory"]`)).toHaveCount(0);
  } else {
    await expect(setup).toContainText("agent-harness:4206");
    await expect(setup).not.toContainText("Runs on LangChain");
  }
  await setup.tap();
  await expect(browser).toHaveURL(`${path}/setup`);
  await expect(
    screen.getByRole("heading", "Setup", { exact: true }),
  ).toBeVisible();
});

if (!personal) {
  test("team Bot settings show Sharing for the owner, an admin and a published audience", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    let mine = true;
    let role: "admin" | "user" = "user";
    let published = false;
    await serveProfile(browser, bot.id, () => ({
      visibility: "public",
      mine,
      canManage: mine || role === "admin",
    }));
    await browser.route(/\/api\/me$/, async (route) => {
      const response = await route.fetch();
      const data = await response.json<{ user: Record<string, unknown> }>();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ...data, user: { ...data.user, role } }),
      });
    });
    await browser.route(/\/api\/team-bots$/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          teamBots: published ? [{ ...bot, audience: "team" }] : [],
          publishable: [],
        }),
      }),
    );

    const path = `/bots/${bot.id}`;
    const sharing = screen.getByRole("link", /^Sharing/);
    await app.open(path);
    await expect(sharing).toContainText("Everyone (public)");
    await expect(sharing).toHaveAttribute("href", `${path}/sharing`);

    mine = false;
    const teamList = browser.waitForResponse(/\/api\/team-bots$/);
    await app.open(path);
    await teamList;
    await expect(screen.getByRole("link", /^Setup/)).toBeVisible();
    await expect(sharing).toHaveCount(0);

    role = "admin";
    await app.open(path);
    await expect(sharing).toContainText("Everyone (public)");

    role = "user";
    published = true;
    await app.open(path);
    await expect(sharing).toContainText("Whole team");
    await expect(sharing).toHaveAttribute("href", `${path}/sharing`);
  });

  test("team Bot settings summarize this Bot's goals, delivery, memory and approval rules", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const others = "other-bot";
    await browser.route(/\/api\/responsibilities$/, (route) =>
      route.fulfill({
        json: {
          responsibilities: [
            { id: "current-goal", agentId: bot.id, status: "active" },
            { id: "paused-goal", agentId: bot.id, status: "paused" },
            { id: "other-goal", agentId: others, status: "active" },
          ],
        },
      }),
    );
    await browser.route(/\/api\/delivery$/, (route) =>
      route.fulfill({
        json: {
          bindings: [
            { id: "own", transport: "slack", agentId: bot.id, enabled: true },
            {
              id: "disabled",
              transport: "teams",
              agentId: bot.id,
              enabled: false,
            },
            { id: "other", transport: "sms", agentId: others, enabled: true },
          ],
          devices: [],
          deliveries: [],
          available: { slack: true, teams: false, sms: true, push: false },
        },
      }),
    );
    await browser.route(/\/api\/memory\/sources$/, (route) =>
      route.fulfill({
        json: { sources: [{ id: "own", agentId: bot.id, enabled: true }] },
      }),
    );
    await browser.route(/\/api\/proactive\/settings$/, (route) =>
      route.fulfill({ json: { settings: [], allowed: true } }),
    );
    await browser.route(/\/api\/approvals$/, (route) =>
      route.fulfill({
        json: {
          enabled: true,
          requests: [],
          questions: [],
          rules: [
            { id: "specific", botId: bot.id },
            { id: "all", botId: "*" },
          ],
          teamRules: [],
        },
      }),
    );

    const path = `/bots/${bot.id}`;
    await app.open(path);
    for (const { name, summary, destination } of [
      { name: /^Goals/, summary: "1 active", destination: "responsibilities" },
      { name: /^Reaching you/, summary: "Slack", destination: "reach" },
      { name: /^Memory/, summary: "1 source", destination: "memory" },
      { name: /^Approval rules/, summary: "1 rule", destination: "approvals" },
    ]) {
      const row = screen.getByRole("link", name);
      await expect(row).toContainText(summary);
      await expect(row).toHaveAttribute("href", `${path}/${destination}`);
    }
  });
}
