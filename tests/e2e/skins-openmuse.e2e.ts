import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const product = "OpenBot";
const now = "2026-11-19T08:00:00.000Z";
const earlier = "2026-11-19T07:00:00.000Z";
const agent = (id: string, name: string) => ({
  id,
  name,
  title: "Your helper",
  roleDescription: "",
  avatarSeed: id,
  builtIn: true,
  canManage: true,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  mine: true,
  systemOwned: false,
  visibility: "private",
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
});
const muse = agent("picked-harness", "Muse");
const scout = agent("scout", "Scout");
const channel = (
  id: string,
  agentIds: string[],
  summary: string,
  busy = false,
) => ({
  id,
  agentIds,
  name:
    agentIds.length > 1 ? "Team" : agentIds[0] === scout.id ? "Scout" : "Muse",
  threadId: `thread-${id}`,
  active: true,
  lastMessageAt: earlier,
  summary,
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: earlier,
  pinned: false,
  lastReadAt: earlier,
  busy,
});
const channels = [
  channel("c-muse", [muse.id], "Planning the week"),
  channel("c-scout", [scout.id], "Competitor notes", true),
  channel("g-team", [muse.id, scout.id], "Launch plan"),
];
const attention = (agentId: string, overrides = {}) => ({
  agentId,
  name: agentId === muse.id ? "Muse" : "Scout",
  questions: 0,
  approvals: 0,
  handoffs: 0,
  unread: 0,
  paused: false,
  notify: "all",
  items: 0,
  tasks: { needsInput: 0, ready: 0, failed: 0 },
  ...overrides,
});
const approval = (
  id: string,
  status: string,
  toolRef = "computer_open_url",
) => ({
  id,
  status,
  createdAt: now,
  action: {
    botId: muse.id,
    threadId: "thread-c-muse",
    toolRef,
    effect: "read",
    scope: "https://example.com",
    args: { url: "https://example.com" },
    target: null,
  },
});
const suggestion = (agentId: string, id: string, title: string) => ({
  id,
  agentId,
  title,
  detail: "Read this in your inbox.",
  sourceApp: null,
  sourceRef: null,
  sourceLink: null,
  pingId: null,
  createdAt: now,
});
const goal = (agentId: string, id: string, title: string) => ({
  id,
  agentId,
  channelId: agentId === muse.id ? "c-muse" : "c-scout",
  threadId: `thread-${id}`,
  title,
  instruction: "Triage new mail each morning",
  successCriteria: "Nothing unread by noon",
  status: "active",
  progress: "Down to 4 unread",
  lastResult: null,
  subscriptions: [],
  updatedAt: now,
});

async function serveMuse(
  browser: Browser,
  options: {
    role?: "admin" | "user";
    userId?: string;
    empty?: boolean;
    roster?: typeof channels;
    bots?: ReturnType<typeof attention>[];
  } = {},
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const state = {
    userId: options.userId ?? "u-1",
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: true,
      narration: null,
      skin: "openmuse",
      proactive: "on",
    },
  };
  let enabled = true;
  let suggestions = [
    suggestion(muse.id, "s-muse", "Book a table for Friday dinner"),
    suggestion(scout.id, "s-scout", "Compare pricing pages"),
  ];
  let requests = [
    approval("r-pending", "pending"),
    approval("r-done", "consumed", "send_email"),
  ];
  const roster = options.roster ?? channels;
  const agents = options.empty ? [] : [scout, muse];
  await browser.route(/\/api\//, (route) => {
    const path = new URL(route.request.url).pathname;
    const method = route.request.method;
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (method !== "GET") {
      const body = JSON.parse(route.request.postData ?? "null");
      calls.push({ method, path, body });
      if (path === "/api/settings/preferences" && method === "PATCH") {
        Object.assign(state.preferences, body);
        return json({ preferences: state.preferences });
      }
      if (path === "/api/routines/rt-1/enabled" && method === "PUT") {
        enabled = body.enabled;
        return json({ ok: true });
      }
      if (
        path === "/api/proactive/suggestions/s-muse/start" &&
        method === "POST"
      ) {
        suggestions = suggestions.filter((row) => row.id !== "s-muse");
        return json({ ok: true });
      }
      if (path === "/api/approvals/r-pending/decision" && method === "POST") {
        requests = requests.filter((row) => row.id !== "r-pending");
        return json({ ok: true });
      }
      if (/^\/api\/channels\/[^/]+\/read$/.test(path))
        return json({ ok: true });
      return route.continue();
    }
    const routes: Record<string, unknown> = {
      "/api/me": {
        user: {
          id: state.userId,
          name: "Alex Rivera",
          email: "alex@example.test",
          role: options.role ?? "admin",
          onboarding: null,
        },
      },
      "/api/capabilities": {
        edition: personal ? "personal" : "team",
        localEvaluation: personal,
        selfHostBanner: false,
        generativeUi: false,
      },
      "/api/settings/preferences": { preferences: state.preferences },
      "/api/agents": { agents },
      "/api/channels": { channels: roster, nextCursor: null },
      "/api/approvals": {
        enabled: true,
        rules: [],
        teamRules: [],
        questions: [],
        requests,
      },
      "/api/bots/attention": {
        bots: options.bots ?? [
          attention(muse.id, { approvals: 1 }),
          attention(scout.id, { unread: 1 }),
        ],
        lastPingId: null,
      },
      "/api/tasks": { tasks: [] },
      "/api/proactive/settings": {
        settings: [
          {
            id: "p-muse",
            agentId: muse.id,
            channelId: "c-muse",
            focus: "",
            enabled: true,
            intervalMinutes: 240,
            nextRunAt: now,
            lastRunAt: earlier,
            lastStatus: "succeeded",
            lastError: null,
          },
        ],
        allowed: true,
      },
      "/api/proactive/suggestions": { suggestions },
      "/api/routines": {
        routines: [
          {
            id: "rt-1",
            agentId: muse.id,
            schedule: "Every weekday at 9:00",
            timezone: "Europe/London",
            instruction: "Send me the headlines",
            title: null,
            channel: {
              id: "c-muse",
              name: "Muse",
              title: "Morning headlines",
              gone: false,
            },
            enabled,
            nextRunAt: "2099-01-01T08:00:00.000Z",
            lastRun: null,
          },
        ],
        sweep: { lastSweptAt: now, working: true },
      },
      "/api/responsibilities": {
        responsibilities: [
          goal(muse.id, "g-1", "Keep my inbox at zero"),
          goal(scout.id, "g-scout", "Watch the competition"),
        ],
      },
      "/api/plugins": {
        catalogue: [],
        servers: [],
        skills: [],
        botsMayCallBack: false,
        redirectUri: null,
        composioConfigured: false,
        authorizesPerAction: false,
      },
      "/api/plugins/connections": { connections: [], redirectUri: null },
      "/api/identity/links": { links: [] },
      "/api/identity/providers": { providers: { slack: false, github: false } },
      "/api/browser": { available: false },
    };
    const detail = path.match(/^\/api\/channels\/([^/]+)$/);
    if (detail) {
      const found = roster.find((row) => row.id === detail[1]);
      return found
        ? json({ channel: found })
        : json({ error: "Not found" }, 404);
    }
    const bot = path.match(/^\/api\/agents\/([^/]+)$/);
    if (bot) {
      const found = agents.find((row) => row.id === bot[1]);
      return found ? json({ agent: found }) : json({ error: "Not found" }, 404);
    }
    if (/^\/api\/bots\/[^/]+\/activity$/.test(path))
      return json({
        activity: {
          inProgress: path.includes(muse.id)
            ? [
                {
                  id: "a-live",
                  kind: "routine",
                  title: "Morning briefing",
                  detail: "Reading the overnight news",
                  status: "running",
                  at: now,
                  channelId: "c-muse",
                  needsYou: false,
                  stoppable: false,
                  cancellable: false,
                },
              ]
            : [],
          scheduled: [],
          completed: path.includes(muse.id)
            ? [
                {
                  id: "a-done",
                  kind: "handoff",
                  title: "Draft the launch post",
                  detail: null,
                  status: "succeeded",
                  at: earlier,
                  channelId: null,
                  needsYou: false,
                  stoppable: false,
                  cancellable: false,
                },
              ]
            : [],
        },
      });
    if (path in routes) return json(routes[path]);
    return route.continue();
  });
  // Seed the pre-paint cache on the app's own origin; a plain document, so the
  // browser treats it as a page rather than a download.
  await browser.goto(`${process.env.OPENBOT_WEB_URL ?? "http://localhost:3010"}/`);
  await browser.evaluate(() => {
    localStorage.setItem("openbot-skin", "openmuse");
    return localStorage.getItem("openbot-skin");
  });
  return { calls, state };
}

async function frame({
  browser,
  screen,
}: Pick<TestFixtures, "screen"> & { browser: Browser }) {
  await expect(browser.locator("html")).toHaveAttribute(
    "data-skin",
    "openmuse",
  );
  await expect(browser.locator(".openmuse-frame")).toBeVisible();
  return screen.getByRole("navigation", product, { exact: true });
}

// Registry identities are checked through the saved skin and its real rendered routes, not imports.
test("OpenFuse keeps the openmuse saved id in the real skin picker", async ({
  app,
  browser,
  screen,
}) => {
  const { calls } = await serveMuse(browser);
  await app.open("/settings");
  const picker = screen.getByRole("combobox", "Skin", { exact: true });
  await expect(picker).toHaveText("OpenFuse");
  await picker.click();
  await screen.getByRole("option", /^OpenBot/).click();
  await picker.click();
  await screen.getByRole("option", /^OpenFuse/).click();
  await expect
    .poll(() => calls.filter((row) => row.path === "/api/settings/preferences"))
    .toEqual([
      {
        method: "PATCH",
        path: "/api/settings/preferences",
        body: { skin: "openbot" },
      },
      {
        method: "PATCH",
        path: "/api/settings/preferences",
        body: { skin: "openmuse" },
      },
    ]);
  await browser.reload();
  await expect(picker).toHaveText("OpenFuse");
  await app.open("/s/activity");
  await frame({ browser, screen });
  await expect(
    screen.getByRole("heading", "Activity", { exact: true }),
  ).toBeVisible();
});

test("the default Bot, pending count and its own avatar occupy the centre", async ({
  app,
  browser,
  screen,
}) => {
  await serveMuse(browser);
  await app.open("/connections");
  await frame({ browser, screen });
  const centre = screen.getByRole(
    "button",
    "Muse, Ready to review · 1 approval. Switch Bot",
    { exact: true },
  );
  await expect(centre).toBeVisible();
  await expect(centre.getByRole("img", "Muse", { exact: true })).toBeVisible();
  await expect(
    screen.getByRole("button", "Needs you, 1 waiting", { exact: true }),
  ).toBeVisible();
});

test("the conversation Bot outranks the chosen Bot and follows it off Chat", async ({
  app,
  browser,
  screen,
}) => {
  await serveMuse(browser);
  await app.open("/s/goals");
  await frame({ browser, screen });
  await screen.getByRole("button", /Switch Bot$/).click();
  await screen.getByRole("dialog").getByRole("button", /Scout/).click();
  await expect(
    screen.getByRole("button", /^Scout, Working on Competitor notes…/),
  ).toBeVisible();
  await app.open("/channel/c-muse");
  await expect(
    screen.getByRole("button", /^Muse, Ready to review/),
  ).toBeVisible();
  await app.open("/channel/c-scout");
  await expect(
    screen.getByRole("button", /^Scout, Working on Competitor notes…/),
  ).toBeVisible();
  await expect(browser).toHaveURL("/channel/c-scout");
  await screen.getByRole("link", "Ideas", { exact: true }).click();
  await expect(
    screen.getByText("Compare pricing pages", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Book a table for Friday dinner", { exact: true }),
  ).toHaveCount(0);
});

test("the five tabs use real screens, chat and Connections", async ({
  app,
  browser,
  screen,
}) => {
  await serveMuse(browser);
  await app.open("/s/goals");
  const nav = await frame({ browser, screen });
  for (const [label, href] of [
    ["Chat", "/channel/c-muse"],
    ["Activity", "/s/activity"],
    ["Ideas", "/s/ideas"],
    ["Goals", "/s/goals"],
    ["Apps", "/connections"],
  ]) {
    await expect(nav.getByRole("link", label, { exact: true })).toHaveAttribute(
      "href",
      href,
    );
  }
  for (const [label, heading] of [
    ["Activity", "Activity"],
    ["Ideas", "Ideas"],
    ["Goals", "Goals"],
    ["Apps", "Connections"],
  ]) {
    await nav.getByRole("link", label, { exact: true }).click();
    await expect(
      screen.getByRole("heading", heading, { exact: true }).first(),
    ).toBeVisible();
  }
  await nav.getByRole("link", "Chat", { exact: true }).click();
  await expect(browser).toHaveURL("/channel/c-muse");
  await expect(browser.locator('[data-slot="composer-input"]')).toBeVisible();
});

for (const [path, tab, width] of [
  ["/", "Chat", "column"],
  ["/channel/new", "Chat", "column"],
  ["/group/g-team", "Chat", "column"],
  ["/s/activity", "Activity", "column"],
  ["/s/ideas", "Ideas", "column"],
  ["/s/goals", "Goals", "column"],
  ["/connections", "Apps", "column"],
  ["/connections/notion", "Apps", "column"],
  ["/channel/c-muse", "Chat", "column"],
  ["/channel/c-muse?watch=true", "Chat", "page"],
  ["/channel/c-muse?settings=true", "Chat", "page"],
  ["/routines", "", "page"],
  ["/settings/approvals", "", ""],
  ["/bots/scout/setup", "", "page"],
  ["/capabilities/memory", "", "page"],
  ["/capabilities/skills", "", "page"],
] as const) {
  test(`${path} marks only its own tab and uses the ${width || "settings"} layout`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveMuse(browser);
    await browser.setViewport({ width: 1440, height: 1000 });
    await app.open(path);
    if (path === "/settings/approvals") {
      // Settings has its own real layout, outside the skin frame.
      await expect(browser.locator(".openmuse-frame")).toHaveCount(0);
      await expect(browser).toHaveURL(path);
      return;
    }
    await frame({ browser, screen });
    await expect(browser.locator(".openmuse-stage")).toHaveAttribute(
      "data-openmuse-width",
      width,
    );
    await expect(browser.locator('nav a[aria-current="page"]')).toHaveCount(
      tab ? 1 : 0,
    );
    if (tab)
      await expect(
        browser.locator('nav a[aria-current="page"]'),
      ).toHaveAttribute("aria-label", tab);
  });
}

test("a chosen Bot survives reload but is isolated from the next person", async ({
  app,
  browser,
  screen,
}) => {
  const { state, calls } = await serveMuse(browser);
  await app.open("/s/activity");
  await frame({ browser, screen });
  await screen.getByRole("button", /Switch Bot$/).click();
  await screen.getByRole("dialog").getByRole("button", /Scout/).click();
  await expect(screen.getByRole("button", /^Scout, /)).toBeVisible();
  await browser.reload();
  await expect(screen.getByRole("button", /^Scout, /)).toBeVisible();
  state.userId = "u-2";
  await browser.reload();
  await expect(screen.getByRole("button", /^Muse, /)).toBeVisible();
  state.userId = "u-1";
  await browser.reload();
  await expect(screen.getByRole("button", /^Scout, /)).toBeVisible();
  // The current product stores this choice locally, not in account preferences.
  expect(
    calls.filter((row) => row.path === "/api/settings/preferences"),
  ).toEqual([]);
});

test("a group is never the main chat and a Bot without a direct chat opens a new one", async ({
  app,
  browser,
  screen,
}) => {
  await serveMuse(browser, {
    roster: channels.filter((row) => row.id !== "c-scout"),
  });
  await app.open("/s/ideas");
  const nav = await frame({ browser, screen });
  await screen.getByRole("button", /Switch Bot$/).click();
  await screen.getByRole("dialog").getByRole("button", /Scout/).click();
  await expect(nav.getByRole("link", "Chat", { exact: true })).toHaveAttribute(
    "href",
    "/channel/new?agent=scout",
  );
  await nav.getByRole("link", "Chat", { exact: true }).click();
  await expect(browser).toHaveURL("/channel/new?agent=scout");
  await expect(screen.getByRole("button", /^Scout, /)).toBeVisible();
  await expect(browser.locator('[data-slot="composer-input"]')).toBeVisible();
});

for (const path of [
  "/",
  "/channel/c-muse",
  "/s/activity",
  "/s/ideas",
  "/s/goals",
  "/connections",
  "/bots/scout/setup",
]) {
  test(`${path} wears the deployment brand and reaches Settings in one menu tap`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveMuse(browser);
    await app.open(path);
    await frame({ browser, screen });
    await screen
      .getByRole("button", "Open conversations and menu", { exact: true })
      .click();
    const menu = screen.getByRole("dialog");
    await expect(
      menu.getByRole("heading", product, { exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByText("Planning the week", { exact: true }),
    ).toBeVisible();
    const readable = await browser.evaluate(() =>
      [
        document.body.textContent ?? "",
        ...Array.from(document.body.querySelectorAll("*"), (element) =>
          ["aria-label", "alt", "title", "placeholder"]
            .map((name) => element.getAttribute(name))
            .filter(Boolean)
            .join("\n"),
        ),
      ].join("\n"),
    );
    expect(readable).toContain(product);
    expect(readable).not.toMatch(/openmuse/i);
    await expect(
      browser.locator(
        'img[src*="capybara" i], img[alt*="capybara" i], img[src*="mascot" i], img[alt*="mascot" i]',
      ),
    ).toHaveCount(0);
    await menu.getByRole("link", "Settings", { exact: true }).click();
    await expect(browser).toHaveURL("/settings");
    await expect(
      screen.getByRole("heading", "General", { exact: true }),
    ).toBeVisible();
    await expect(menu).toHaveCount(0);
  });
}

test("with no Bots the brand occupies the centre and skin screens remain reachable", async ({
  app,
  browser,
  screen,
}) => {
  await serveMuse(browser, { empty: true });
  await app.open("/s/activity");
  await frame({ browser, screen });
  await expect(
    screen.getByRole("button", "Choose a Bot", { exact: true }),
  ).toContainText(product);
  await expect(
    screen.getByRole("heading", "No Bots yet", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", "Choose a Bot", { exact: true }).click();
  await expect(
    screen.getByText("You don't have a Bot yet.", { exact: true }),
  ).toBeVisible();
});

for (const role of ["admin", "user"] as const) {
  test(`the ${role} menu exposes the edition's whole navigation and direct and group conversations`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveMuse(browser, { role });
    await app.open("/s/activity");
    await frame({ browser, screen });
    await screen
      .getByRole("button", "Open conversations and menu", { exact: true })
      .click();
    const menu = screen.getByRole("dialog");
    for (const [name, href] of [
      ["Main chat", "/channel/c-muse"],
      ["New chat", "/channel/new?agent=picked-harness"],
      ["New group", "/channel/new"],
      ["Home", "/"],
      ["Bots", "/bots"],
      ["Routines", "/routines"],
      ["Connections", "/connections"],
      ["Settings", "/settings"],
      ...(!personal ? [["Capabilities", "/capabilities"]] : []),
      ...(!personal && role === "admin" ? [["Admin", "/admin"]] : []),
      ["Planning the week", "/channel/c-muse"],
      ["Competitor notes", "/channel/c-scout"],
      ["Launch plan", "/group/g-team"],
    ])
      await expect(
        menu.getByRole("link", new RegExp(`^${name}`)),
      ).toHaveAttribute("href", href);
    await expect(menu.getByRole("link", "Admin", { exact: true })).toHaveCount(
      !personal && role === "admin" ? 1 : 0,
    );
    if (personal) {
      await expect(
        menu.getByRole("link", "Capabilities", { exact: true }),
      ).toHaveCount(0);
      await expect(
        menu.getByRole("button", "OpenBot for Business", { exact: true }),
      ).toBeVisible();
    }
    await menu.getByRole("link", /Competitor notes/).click();
    await expect(browser).toHaveURL("/channel/c-scout");
    await expect(menu).toHaveCount(0);
  });
}

test("the Bot switcher links to the current Bot, all Bots and a new Bot without conflating unread and needs you", async ({
  app,
  browser,
  screen,
}) => {
  await serveMuse(browser);
  await app.open("/connections");
  await frame({ browser, screen });
  await screen.getByRole("button", /Switch Bot$/).click();
  const sheet = screen.getByRole("dialog");
  for (const [name, href] of [
    ["Muse's page", "/bots/picked-harness"],
    ["All Bots", "/bots"],
    ["New Bot", "/bots?new=true"],
  ])
    await expect(
      sheet.getByRole("link", new RegExp(`^${name}`)),
    ).toHaveAttribute("href", href);
  await expect(
    sheet.getByText("Needs you · 1 approval", { exact: true }),
  ).toBeVisible();
  await expect(sheet.getByText("1 unread", { exact: true })).toBeVisible();
  await expect(sheet.getByText(/Needs you · 1 unread/)).toHaveCount(0);
  await sheet.getByRole("button", /Scout/).click();
  await expect(screen.getByRole("button", /^Scout, /)).toBeVisible();
  await expect(sheet).toHaveCount(0);
});

test("Activity renders the centre Bot's approval details and work sections", async ({
  app,
  browser,
  screen,
}) => {
  await serveMuse(browser);
  await app.open("/s/activity");
  await frame({ browser, screen });
  for (const text of [
    "Open url",
    "URL",
    "Morning briefing",
    "Draft the launch post",
  ])
    await expect(screen.getByText(text, { exact: true })).toBeVisible();
  await expect(
    screen.getByText("https://example.com", { exact: true }),
  ).toHaveCount(2);
  for (const heading of ["In progress", "Completed"])
    await expect(
      screen.getByRole("heading", heading, { exact: true }),
    ).toBeVisible();
});

test("Ideas scopes suggestions and check-ins and starts the selected suggestion once", async ({
  app,
  browser,
  screen,
}) => {
  const { calls } = await serveMuse(browser);
  await app.open("/s/ideas");
  await frame({ browser, screen });
  await expect(
    screen.getByText("Book a table for Friday dinner", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Compare pricing pages", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("heading", "Check-ins", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", "Work on it", { exact: true }).click();
  await expect
    .poll(() =>
      calls.filter(
        (row) => row.path === "/api/proactive/suggestions/s-muse/start",
      ),
    )
    .toEqual([
      {
        method: "POST",
        path: "/api/proactive/suggestions/s-muse/start",
        body: null,
      },
    ]);
  await expect(
    screen.getByText("Book a table for Friday dinner", { exact: true }),
  ).toHaveCount(0);
});

test("Goals scopes routines and goals and saves a paused routine", async ({
  app,
  browser,
  screen,
}) => {
  const { calls } = await serveMuse(browser);
  await app.open("/s/goals");
  await frame({ browser, screen });
  await expect(
    screen.getByText("Send me the headlines", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Keep my inbox at zero", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Watch the competition", { exact: true }),
  ).toHaveCount(0);
  const toggle = screen.getByRole(
    "switch",
    "Enable the routine scheduled Every weekday at 9:00",
    { exact: true },
  );
  await toggle.click();
  await expect
    .poll(() =>
      calls.filter((row) => row.path === "/api/routines/rt-1/enabled"),
    )
    .toEqual([
      {
        method: "PUT",
        path: "/api/routines/rt-1/enabled",
        body: { enabled: false },
      },
    ]);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await browser.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

// Approval presentation/choice coverage already lives in approval-presentations.e2e.ts.
test("the bell excludes consumed approvals and submits the decision once", async ({
  app,
  browser,
  screen,
}) => {
  const { calls } = await serveMuse(browser);
  await app.open("/s/goals");
  await frame({ browser, screen });
  await screen
    .getByRole("button", "Needs you, 1 waiting", { exact: true })
    .click();
  const sheet = screen.getByRole("dialog", "Needs you", { exact: true });
  await expect(sheet.getByText(/send email/i)).toHaveCount(0);
  await sheet.getByRole("button", "Allow once", { exact: true }).click();
  await expect
    .poll(() =>
      calls.filter((row) => row.path === "/api/approvals/r-pending/decision"),
    )
    .toEqual([
      {
        method: "POST",
        path: "/api/approvals/r-pending/decision",
        body: { decision: "allow_once" },
      },
    ]);
  await expect(
    sheet.getByText("You're all caught up", { exact: true }),
  ).toBeVisible();
});

for (const [overrides, busy, status] of [
  [{}, true, "Working on Report…"],
  [{ questions: 2 }, true, "Needs your input · 2 questions"],
  [{ approvals: 1, questions: 2 }, true, "Ready to review · 1 approval"],
  [{ paused: true }, false, "Paused"],
  [{}, false, "Ready when you are"],
] as const) {
  test(`the status line prioritizes ${status}`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveMuse(browser, {
      bots: [attention(muse.id, overrides)],
      roster: [channel("c-muse", [muse.id], "Report", busy)],
    });
    await app.open("/s/goals");
    await frame({ browser, screen });
    await expect(
      screen.getByRole("button", `Muse, ${status}. Switch Bot`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(browser.locator('[data-testid="openmuse-status"]')).toHaveText(
      status,
    );
  });
}
