import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { notionServer } from "./fixtures/app-details";
import { createBot } from "./signed-in";

type Access = {
  key: string;
  displayName: string;
  provider: string;
  account: "personal" | "shared";
  accountMode: "personal" | "shared";
  connect: "consent" | "oauth";
  state: string;
  unavailable: string | null;
  accountHolder: "you" | "owner";
  givenByOwner: boolean;
  requestKind: string | null;
  request: { id: string; kind: string; createdAt: string } | null;
};

function access(overrides: Partial<Access> = {}) {
  return {
    key: "composio-gmail",
    displayName: "Gmail",
    logo: null,
    provider: "composio",
    account: "personal",
    connect: "consent",
    authScheme: "OAUTH2",
    accountMode: "personal",
    state: "ready",
    unavailable: null,
    accountHolder: "you",
    asksFirst: false,
    granted: true,
    ownerGrants: "any",
    givenByOwner: false,
    needsConnect: false,
    connectedAt: null,
    requestKind: null,
    request: null,
    ...overrides,
  };
}

const notion = (overrides: Partial<Access> = {}) =>
  access({
    key: "notion",
    displayName: "Notion",
    provider: "catalogue",
    ...overrides,
  });

const tool = (ref: string) => ({
  ref,
  toolName: `mcp__${ref.replace("/", "__")}`,
  description: "",
  inputSchema: {},
});

async function appAccessRoutes(
  browser: Browser,
  botId: string,
  options: {
    apps: () => ReturnType<typeof access>[] | "fail";
    tools?: ReturnType<typeof tool>[];
    mine: () => boolean;
    role?: "admin" | "user";
  },
) {
  await browser.route(/\/api\/me$/, async (route) => {
    const response = await route.fetch();
    const data = await response.json<{ user: Record<string, unknown> }>();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...data,
        user: { ...data.user, role: options.role ?? "user" },
      }),
    });
  });
  const idPattern = RegExp.escape(botId);
  await browser.route(
    new RegExp(`/api/agents/${idPattern}$`),
    async (route) => {
      const response = await route.fetch();
      const data = await response.json<{ agent: Record<string, unknown> }>();
      const mine = options.mine();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...data,
          agent: {
            ...data.agent,
            mine,
            canManage: mine || options.role === "admin",
          },
        }),
      });
    },
  );
  await browser.route(
    new RegExp(`/api/plugins/for/${idPattern}/apps$`),
    (route) => {
      const apps = options.apps();
      return apps === "fail"
        ? route.fulfill({
            status: 500,
            json: { error: "Cannot load app access." },
          })
        : route.fulfill({ json: { apps } });
    },
  );
  await browser.route(new RegExp(`/api/plugins/for/${idPattern}$`), (route) =>
    route.fulfill({ json: { tools: options.tools ?? [], skills: [] } }),
  );
}

test("owners can give and take back their apps while administrator grants stay locked", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  let mine = true;
  let ownApps = [notion({ givenByOwner: true })];
  await appAccessRoutes(browser, bot.id, {
    apps: () => ownApps,
    mine: () => mine,
  });
  await browser.route(/\/api\/plugins\/giveable$/, (route) =>
    route.fulfill({
      json: {
        apps: [
          {
            key: "composio-gmail",
            displayName: "Gmail",
            logo: null,
            account: "personal",
          },
          {
            key: "notion",
            displayName: "Notion",
            logo: null,
            account: "personal",
          },
        ],
      },
    }),
  );
  const writes: string[] = [];
  const base = `/api/plugins/for/${bot.id}/apps`;
  await browser.route(
    new RegExp(`${RegExp.escape(base)}/[^/?]+/give$`),
    (route) => {
      const path = new URL(route.request.url).pathname;
      const method = route.request.method;
      writes.push(`${method} ${path}`);
      ownApps =
        method === "POST"
          ? [...ownApps, access({ givenByOwner: true })]
          : ownApps.filter(({ key }) => key !== "notion");
      return route.fulfill({ json: { granted: [], revoked: [] } });
    },
  );

  const path = `/bots/${bot.id}/access`;
  await app.open(path);
  const gmail = screen.getByRole("switch", `Let ${bot.name} use Gmail`, {
    exact: true,
  });
  const notionSwitch = screen.getByRole(
    "switch",
    `Let ${bot.name} use Notion`,
    { exact: true },
  );
  await expect(gmail).toHaveAttribute("aria-checked", "false");
  await expect(notionSwitch).toHaveAttribute("aria-checked", "true");
  await expect(
    screen.getByText(`${bot.name} can't use your Gmail.`, { exact: true }),
  ).toBeVisible();
  await gmail.tap();
  await expect(gmail).toHaveAttribute("aria-checked", "true");
  await expect(
    screen.getByText(`${bot.name} can use your Gmail.`, { exact: true }),
  ).toBeVisible();
  await notionSwitch.tap();
  await expect(notionSwitch).toHaveAttribute("aria-checked", "false");
  expect(writes).toEqual([
    `POST ${base}/composio-gmail/give`,
    `DELETE ${base}/notion/give`,
  ]);

  ownApps = [access({ givenByOwner: false })];
  await app.open(path);
  await expect(gmail).toHaveAttribute("aria-checked", "true");
  await expect(gmail).toBeDisabled();
  await expect(
    screen.getByText("An admin gave it to this Bot.", { exact: true }),
  ).toBeVisible();

  mine = false;
  await app.open(path);
  await expect(
    screen.getByRole("heading", "What it can use", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("heading", "Your apps", { exact: true }),
  ).toHaveCount(0);
});

test("the access page names granted apps and tools and explains when only the owner can reconnect", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  let apps = [access()];
  await appAccessRoutes(browser, bot.id, {
    apps: () => apps,
    mine: () => false,
    tools: [
      tool("composio-gmail/GMAIL_SEND_EMAIL"),
      tool("composio-gmail/GMAIL_FETCH_EMAILS"),
      ...[
        "complete_goal",
        "create_goal",
        "create_routine",
        "create_trigger",
      ].map((name) => tool(`routines/${name}`)),
    ],
  });
  const path = `/bots/${bot.id}/access`;
  await app.open(path);
  const gmail = browser.locator('[data-app="composio-gmail"]');
  await expect(gmail.getByText("Gmail", { exact: true })).toBeVisible();
  await expect(gmail.getByText(/^Ready to use\./)).toBeVisible();
  await expect(gmail.getByText("2 tools", { exact: true })).toBeVisible();
  await expect(screen.getByText(/Composio Gmail/)).toHaveCount(0);
  await expect(gmail.getByRole("button")).toHaveCount(0);
  await expect(gmail.getByRole("button", /Manage/)).toHaveCount(0);
  await expect(
    screen.getByText(
      "Complete goal, Create goal, Create routine, Create trigger",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText(/Created a goal|Marked a goal complete/),
  ).toHaveCount(0);

  apps = [
    access({ accountHolder: "owner" }),
    notion({ connect: "oauth", state: "reconnect", accountHolder: "owner" }),
  ];
  await app.open(path);
  await expect(
    gmail.getByText(
      /^Ready to use\. This Bot uses its owner's Gmail account\./,
    ),
  ).toBeVisible();
  const reconnect = browser.locator('[data-app="notion"]');
  await expect(
    reconnect.getByText(
      "This Bot uses its owner's Notion account, which needs reconnecting. Only the Bot's owner can reconnect it.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(reconnect.getByRole("button")).toHaveCount(0);
});

test("access rows show a shared-account request, a pending request and full setup guidance at phone width", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  await appAccessRoutes(browser, bot.id, {
    mine: () => false,
    apps: () => [
      access({
        key: "composio-slack",
        displayName: "Slack",
        state: "shared_not_connected",
        account: "shared",
        accountMode: "shared",
        requestKind: "connect_shared",
      }),
      notion({
        state: "disabled",
        requestKind: "enable",
        request: {
          id: "request-1",
          kind: "enable",
          createdAt: "2026-10-20T10:00:00.000Z",
        },
      }),
      access({
        state: "disabled",
        unavailable: "composio_unconfigured",
        requestKind: "enable",
      }),
    ],
  });
  await browser.setViewport({ width: 375, height: 800 });
  await app.open(`/bots/${bot.id}/access`);
  const slack = browser.locator('[data-app="composio-slack"]');
  await expect(
    slack.getByText(
      "Your organisation's Slack account isn't connected yet. Only an admin can connect it.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    slack.getByRole("button", "Request access to Slack", { exact: true }),
  ).toBeVisible();
  const pending = browser.locator('[data-app="notion"]');
  await expect(
    pending.getByText(
      "Notion isn't turned on yet. Only an admin can turn it on.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(pending.getByText("Requested", { exact: true })).toBeVisible();
  await expect(
    pending.getByRole("button", "Withdraw request for Notion", { exact: true }),
  ).toBeVisible();

  const guidance = "Gmail isn't set up yet. An admin has to turn it on.";
  await expect(screen.getByText(guidance, { exact: true })).toBeVisible();
  const fits = await browser.evaluate((text) => {
    const element = [
      ...document.querySelectorAll(
        '[data-app="composio-gmail"] [data-slot="item-description"]',
      ),
    ].find((candidate) => candidate.textContent === text);
    if (!element) return false;
    const bounds = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = [...range.getClientRects()];
    return (
      lines.length > 1 &&
      lines.every(
        (line) =>
          line.bottom <= bounds.bottom + 1 && line.right <= bounds.right + 1,
      )
    );
  }, guidance);
  expect(fits).toBe(true);
});

test("an admin can find the app's grant settings next to the user's Connect action", async (fixtures) => {
  const { app, browser } = fixtures;
  const bot = await createBot(fixtures);
  await appAccessRoutes(browser, bot.id, {
    apps: () => [access({ state: "not_connected" })],
    mine: () => false,
    role: "admin",
  });
  await app.open(`/bots/${bot.id}/access`);
  const gmail = browser.locator('[data-app="composio-gmail"]');
  await expect(
    gmail.getByText("You haven't connected your Gmail account yet.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    gmail.getByRole("button", "Connect Gmail", { exact: true }),
  ).toBeVisible();
  await expect(
    gmail.getByRole("button", "Manage Gmail on this Bot", { exact: true }),
  ).toHaveAttribute("href", `/admin/plugins/composio-gmail/bots/${bot.id}`);
});

test("the access page keeps known grants when reading readiness fails", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  await appAccessRoutes(browser, bot.id, {
    apps: () => "fail",
    mine: () => false,
    tools: [tool("google-drive/search_files")],
  });
  await app.open(`/bots/${bot.id}/access`);
  await expect(screen.getByRole("alert")).toContainText(
    "Couldn't check whether each app is ready for you. Reload the page.",
  );
  await expect(screen.getByText("Google Drive", { exact: true })).toBeVisible();
});

const pluginsPath = /\/api\/plugins$/;
const missingPlugin = "No app with that name is turned on.";
const failedPlugins = "Couldn't load plugins. Reload the page.";

const pluginAction = (
  name: string,
  effect: "read" | "write",
  destructive = false,
) => ({
  serverId: "notion",
  name,
  ref: `notion/${name}`,
  description: "Used in the grant settings.",
  inputSchema: {},
  effect,
  destructive,
  grantedTo: [] as string[],
});

function pluginsPage(tools: ReturnType<typeof pluginAction>[] | null) {
  return {
    catalogue: [],
    servers: tools ? [{ ...notionServer, tools }] : [],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
    authorizesPerAction: false,
  };
}

test("grant settings report a failed first plugin read without claiming the app is off", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  await browser.route(pluginsPath, (route) => route.fulfill({ status: 500 }));
  await app.open(`/admin/plugins/notion/bots/${bot.id}`);
  await expect(screen.getByRole("alert")).toContainText(failedPlugins);
  for (const label of [
    missingPlugin,
    "Nothing to give a Bot here.",
    "Turn on every read-only action",
    "Reads",
    "Changes things",
  ]) {
    await expect(screen.getByText(label, { exact: true })).toHaveCount(0);
  }
  await expect(screen.getByRole("switch")).toHaveCount(0);
});

for (const appIsOn of [false, true]) {
  test(`grant settings keep the last ${appIsOn ? "available app" : "absent app"} result after a refresh failure`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    await appAccessRoutes(browser, bot.id, {
      apps: () => [notion()],
      mine: () => true,
      role: "admin",
    });
    let offline = false;
    let failures = 0;
    const reads = Promise.withResolvers<void>();
    const result = pluginsPage(
      appIsOn ? [pluginAction("list_pages", "read")] : null,
    );
    await browser.route(pluginsPath, async (route) => {
      if (offline) {
        await route.fulfill({ status: 500 });
        failures++;
        return;
      }
      await route.fulfill({ json: result });
      reads.resolve();
    });
    await app.open(`/bots/${bot.id}/access`);
    await reads.promise;
    const manage = screen.getByRole("button", "Manage Notion on this Bot", {
      exact: true,
    });
    await expect(manage).toBeVisible();
    offline = true;
    await manage.tap();
    await expect(browser).toHaveURL(`/admin/plugins/notion/bots/${bot.id}`);
    await expect.poll(() => failures).toBeGreaterThanOrEqual(2);
    await expect(screen.getByText(failedPlugins, { exact: true })).toHaveCount(
      0,
    );
    const missing = screen.getByText(missingPlugin, { exact: true });
    if (appIsOn) {
      await expect(
        screen.getByRole("switch", `Let ${bot.name} call list_pages`, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(missing).toHaveCount(0);
    } else {
      await expect(missing).toBeVisible();
      await expect(screen.getByRole("switch")).toHaveCount(0);
    }
  });
}

test("the grant settings find a hidden Bot and mark only explicitly destructive actions", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const hidden = browser.waitForResponse(
    new RegExp(`/api/agents/${RegExp.escape(bot.id)}/hide$`),
  );
  await screen.getByRole("switch", "Hidden", { exact: true }).tap();
  expect((await hidden).status).toBeLessThan(300);
  await expect(browser).toHaveURL(/\/bots\/?$/);
  const list = pluginAction("list_pages", "read");
  list.grantedTo = [bot.id];
  await browser.route(pluginsPath, (route) =>
    route.fulfill({
      json: pluginsPage([
        list,
        pluginAction("update_page", "write"),
        pluginAction("delete_page", "write", true),
      ]),
    }),
  );
  await app.open(`/admin/plugins/notion/bots/${bot.id}`);
  const action = (name: string) =>
    screen.getByRole("switch", `Let ${bot.name} call ${name}`, { exact: true });
  await expect(action("list_pages")).toHaveAttribute("aria-checked", "true");
  await expect(screen.getByText("Not a Bot", { exact: true })).toHaveCount(0);
  const actions = (name: string) =>
    browser.locator('[data-slot="item-actions"]').filter({ has: action(name) });
  await expect(
    actions("delete_page").getByText("destroys things", { exact: true }),
  ).toBeVisible();
  await expect(actions("update_page")).toHaveText("");
});
