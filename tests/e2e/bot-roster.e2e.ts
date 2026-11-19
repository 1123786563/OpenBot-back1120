import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const rosterPath = /\/api\/agents(?:\?hidden=true)?$/;

function profile(
  id: string,
  name: string,
  flags?: {
    mine?: boolean;
    pinned?: boolean;
    hidden?: boolean;
    systemOwned?: boolean;
  },
) {
  const mine = flags?.mine ?? true;
  return {
    id,
    name,
    title: "Helps with the work",
    roleDescription: "A roster fixture.",
    avatarSeed: id,
    visibility: mine ? "private" : "public",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: flags?.hidden ?? false,
    pinned: flags?.pinned ?? false,
    systemOwned: flags?.systemOwned ?? false,
    canManage: mine,
    mine,
  };
}

if (!personal) {
  test("the team roster groups pinned, owned and shared Bots and opens hidden Bots on demand", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const hidden = await createBot(fixtures);
    const pinned = profile("fixture-pinned", "Pinned Bot", { pinned: true });
    const own = profile("fixture-owned", "Owned Bot");
    const shared = profile("fixture-shared", "Shared Bot", { mine: false });
    await browser.route(rosterPath, (route) => {
      const { searchParams } = new URL(route.request.url);
      return route.fulfill({
        json: {
          agents: searchParams.has("hidden")
            ? [profile(hidden.id, hidden.name, { hidden: true })]
            : [pinned, own, shared],
        },
      });
    });
    await browser.route(/\/api\/bots\/attention$/, (route) =>
      route.fulfill({ json: { bots: [], lastPingId: null } }),
    );
    await app.open("/bots");
    const main = screen.getByRole("main");
    const headings = browser.locator("main h2");
    await expect(headings).toHaveCount(4);
    for (const [index, label] of [
      "Pinned",
      "Yours",
      "Shared with you",
      "Hidden",
    ].entries()) {
      await expect(headings.nth(index)).toHaveText(label);
    }
    for (const bot of [pinned, own, shared]) {
      const row = main.getByRole("link", new RegExp(`^${bot.name}\\b`));
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute("href", `/bots/${bot.id}`);
    }
    const hiddenRow = main.getByRole(
      "link",
      new RegExp(RegExp.escape(hidden.name)),
    );
    await expect(hiddenRow).toHaveCount(0);
    await main.getByRole("button", "Show", { exact: true }).tap();
    await expect(hiddenRow).toHaveAttribute("href", `/bots/${hidden.id}`);
    await hiddenRow.tap();
    await expect(browser).toHaveURL(
      new RegExp(`/bots/${RegExp.escape(hidden.id)}$`),
    );
    await expect(
      screen.getByRole("heading", hidden.name, { exact: true }),
    ).toBeVisible();
  });

  test("the roster keeps waiting Bots in their sections and explains the all-pinned state", async ({
    app,
    browser,
    screen,
  }) => {
    const pinned = profile("fixture-favorite", "Favourite Bot", {
      pinned: true,
    });
    const waiting = profile("fixture-waiting", "Waiting Bot", { mine: false });
    const scout = profile("fixture-scout", "Scout Bot", { mine: false });
    await browser.route(rosterPath, (route) =>
      route.fulfill({
        json: {
          agents: new URL(route.request.url).searchParams.has("hidden")
            ? []
            : [pinned, waiting, scout],
        },
      }),
    );
    const common = {
      handoffs: 0,
      unread: 0,
      paused: false,
      notify: "all",
      tasks: { needsInput: 0, ready: 0, failed: 0 },
    };
    await browser.route(/\/api\/bots\/attention$/, (route) =>
      route.fulfill({
        json: {
          bots: [
            {
              ...common,
              agentId: waiting.id,
              name: waiting.name,
              questions: 1,
              approvals: 1,
              items: 0,
            },
            {
              ...common,
              agentId: scout.id,
              name: scout.name,
              questions: 0,
              approvals: 0,
              items: 2,
            },
          ],
          lastPingId: null,
        },
      }),
    );
    await app.open("/bots");
    const main = screen.getByRole("main");
    await expect(
      main.getByText("Your Bots are all pinned above.", { exact: true }),
    ).toBeVisible();
    await expect(
      main.getByRole("heading", "Hidden", { exact: true }),
    ).toHaveCount(0);
    await expect(
      main.getByRole("heading", "Shared with you", { exact: true }),
    ).toBeVisible();
    const waitingRow = browser.locator(`main a[href="/bots/${waiting.id}"]`);
    await expect(waitingRow).toHaveCount(1);
    const sharedSection = browser.locator("main section").filter({
      has: screen.getByRole("heading", "Shared with you", { exact: true }),
    });
    await expect(sharedSection.getByRole("link", /^Waiting Bot/)).toHaveCount(
      1,
    );
    await expect(waitingRow.getByText("2", { exact: true })).toBeVisible();
    const scoutRow = browser.locator(`main a[href="/bots/${scout.id}"]`);
    await expect(
      scoutRow.getByText("2 things need you", { exact: true }),
    ).toBeVisible();
    await expect(scoutRow).not.toContainText(/suggestion/i);
  });
} else {
  test("the personal roster lists starter Bots under Included with OpenBot", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.route(rosterPath, (route) =>
      route.fulfill({
        json: {
          agents: new URL(route.request.url).searchParams.has("hidden")
            ? []
            : [
                profile("fixture-starter", "Starter Bot", {
                  mine: false,
                  systemOwned: true,
                }),
              ],
        },
      }),
    );
    await app.open("/bots");
    const main = screen.getByRole("main");
    await expect(
      main.getByRole("heading", "Included with OpenBot", { exact: true }),
    ).toBeVisible();
    await expect(main.getByRole("link", /^Starter Bot/)).toBeVisible();
    await expect(
      main.getByRole("heading", "Shared with you", { exact: true }),
    ).toHaveCount(0);
  });
}

if (!personal) {
  test("shared app warnings are visible to Bot managers and messaging remains available to other users", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    let canManage = true;
    await browser.route(/\/api\/me$/, async (route) => {
      const response = await route.fetch();
      const data = await response.json<{ user: Record<string, unknown> }>();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ...data, user: { ...data.user, role: "user" } }),
      });
    });
    await browser.route(
      new RegExp(`/api/agents/${RegExp.escape(bot.id)}$`),
      async (route) => {
        const response = await route.fetch();
        const data = await response.json<{ agent: Record<string, unknown> }>();
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ...data,
            agent: { ...data.agent, canManage, mine: canManage },
          }),
        });
      },
    );
    await browser.route(/\/api\/approvals\/shared-use\/bot\/[^/]+$/, (route) =>
      route.fulfill({
        json: {
          apps: [{ serverId: "gmail", title: "Gmail", covered: false }],
          pending: [],
        },
      }),
    );

    await app.open(`/bots/${bot.id}`);
    const notice = screen.getByText(/can't use the shared Gmail account/);
    await expect(notice).toBeVisible();
    canManage = false;
    await browser.reload();
    await expect(
      screen.getByRole("heading", bot.name, { exact: true }),
    ).toBeVisible();
    const message = screen.getByRole(
      "link",
      new RegExp(`^Message ${RegExp.escape(bot.name)}`),
    );
    await expect(message).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(
      browser.locator(
        `a[href*="/channel/new?agent=${bot.id}"] .tabler-icon-chevron-right`,
      ),
    ).toBeVisible();
    await message.tap();
    await expect(browser).toHaveURL(/\/channel\/new\?agent=/);
    expect(new URL(await browser.url()).searchParams.get("agent")).toBe(bot.id);
  });
}

test("the Active switch pauses a Bot, keeps its state through reload and resumes it", async (fixtures) => {
  const { browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const active = screen.getByRole("switch", "Active", { exact: true });
  const paused = screen.getByText(
    "Paused. Nothing runs for you until you turn it back on.",
    { exact: true },
  );
  const lifecyclePath = `/api/bots/${RegExp.escape(bot.id)}`;
  const actions: { action: string; method: string }[] = [];
  await browser.route(
    new RegExp(`${lifecyclePath}/(?:pause|resume)$`),
    async (route) => {
      const action = new URL(route.request.url).pathname.split("/").at(-1);
      if (!action) throw new Error("The lifecycle operation is missing");
      actions.push({ action, method: route.request.method });
      await route.continue();
    },
  );

  await expect(active).toHaveAttribute("aria-checked", "true");
  await expect(paused).toHaveCount(0);
  const pause = browser.waitForResponse(new RegExp(`${lifecyclePath}/pause$`));
  await active.tap();
  expect((await pause).status).toBe(200);
  await expect(active).toHaveAttribute("aria-checked", "false");
  await expect(paused).toBeVisible();
  await browser.reload();
  await expect(active).toHaveAttribute("aria-checked", "false");
  await expect(paused).toBeVisible();

  const resume = browser.waitForResponse(
    new RegExp(`${lifecyclePath}/resume$`),
  );
  await active.tap();
  expect((await resume).status).toBe(200);
  await expect(active).toHaveAttribute("aria-checked", "true");
  await expect(paused).toHaveCount(0);
  expect(actions).toEqual([
    { action: "pause", method: "POST" },
    { action: "resume", method: "POST" },
  ]);
});
