import { type Browser, test, type WebApp } from "@e2e-dev/web";
import { expect } from "e2e";
import { appConfig } from "../../app/src/lib/generated/application-config";
import { configureChatStream } from "./chat-stream";
import { serveComputer } from "./computer-fixtures";

/*
 * The OpenDots frame around OpenBot's real pages, in Chromium. The routes are the app's own and so
 * are the components; only the API answers are fixed, so the frame is held to what OpenBot's
 * endpoints actually send: the Bots the agents route lists, the conversations the channels route
 * returns, the edition the capabilities route names, and the account preference that turns the
 * skin on.
 */

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const edition = personal ? "personal" : "team";
const productName = appConfig.brand.productName;

type Fixtures = { app: WebApp; browser: Browser };

function bot(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    title: "Coworker",
    roleDescription: `${name} helps.`,
    // Unlike the id on purpose, so a test can tell which of the two an avatar was drawn from.
    avatarSeed: `seed-${id}`,
    ownerUserId: "dana",
    visibility: "private",
    mine: true,
    canManage: true,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    builtIn: false,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    ...overrides,
  };
}

function channel(
  id: string,
  agentIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: id,
    agentIds,
    threadId: id,
    active: true,
    lastMessageAt: "2026-10-20T10:00:00.000Z",
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

/**
 * OpenBot's endpoints, answering in the envelopes the browser reads them in, with the skin turned
 * on for the account. The returned state is what a test changes; the routes close over it.
 */
async function serveFrame(browser: Browser) {
  const state = {
    role: "user" as "user" | "admin",
    agentsFail: false,
    // Pinned first, then the person's own, then shared with them: the Bots roster's own order.
    bots: [
      bot("ada", "Ada"),
      bot("brook", "Brook", { pinned: true }),
      bot("cass", "Cass", {
        mine: false,
        ownerUserId: "someone",
        visibility: "public",
      }),
    ],
    channels: [
      channel("trip", ["brook"], { summary: "Planning the Lisbon trip" }),
      channel("standup", ["ada", "brook"], { summary: "Monday standup" }),
    ],
    agentListReads: 0,
    memoryReads: 0,
    lifecycleWrites: [] as string[],
    paused: new Set<string>(),
  };

  await browser.route(/\/api\/me$/, (route) =>
    route.fulfill({
      json: {
        user: {
          id: "dana",
          name: "Dana Reyes",
          email: "dana@example.test",
          role: state.role,
          onboarding: null,
        },
      },
    }),
  );
  await browser.route(/\/api\/capabilities$/, async (route) => {
    const capabilities = await (await route.fetch()).json<
      Record<string, boolean | string | string[] | null>
    >();
    return route.fulfill({
      json: { ...capabilities, localEvaluation: personal },
    });
  });
  // The account's saved skin; the localStorage cache below keeps the first paint from flashing.
  await browser.route(/\/api\/settings\/preferences$/, (route) =>
    route.fulfill({
      json: {
        preferences: {
          messageListEmphasis: "thread",
          selfHostBannerDismissed: true,
          narration: null,
          skin: "opendots",
          proactive: "on",
        },
      },
    }),
  );
  await browser.route(/\/api\/browser$/, (route) =>
    route.fulfill({ json: { available: false } }),
  );
  await browser.route(/\/api\/bots\/attention$/, (route) =>
    route.fulfill({ json: { bots: [], lastPingId: null } }),
  );
  await browser.route(/\/api\/agents$/, (route) => {
    state.agentListReads++;
    if (state.agentsFail)
      return route.fulfill({ status: 500, json: { error: "down" } });
    return route.fulfill({ json: { agents: state.bots } });
  });
  await browser.route(/\/api\/agents\/[^/]+$/, (route) => {
    if (state.agentsFail)
      return route.fulfill({ status: 500, json: { error: "down" } });
    const id = new URL(route.request.url).pathname.split("/").at(-1) ?? "";
    const found = state.bots.find((item) => item.id === id);
    if (!found) return route.fallback();
    return route.fulfill({ json: { agent: found } });
  });
  await browser.route(/\/api\/channels$/, (route) =>
    route.fulfill({ json: { channels: state.channels, nextCursor: null } }),
  );
  await browser.route(/\/api\/channels\/[^/]+$/, (route) => {
    const id = decodeURIComponent(
      new URL(route.request.url).pathname.split("/").at(-1) ?? "",
    );
    const found = state.channels.find((item) => item.id === id);
    if (!found) return route.fallback();
    return route.fulfill({ json: { channel: found } });
  });
  await browser.route(/\/api\/routines$/, (route) =>
    route.fulfill({
      json: { routines: [], sweep: { lastSweptAt: null, working: true } },
    }),
  );
  await browser.route(/\/api\/memory$/, (route) => {
    state.memoryReads++;
    return route.fulfill({ json: { memories: [] } });
  });
  await browser.route(
    /\/api\/bots\/[^/]+\/(?:lifecycle|pause|resume)$/,
    (route) => {
      const url = new URL(route.request.url);
      const [, , id, action] = url.pathname.split("/");
      if (route.request.method === "POST") {
        if (action === "pause") state.paused.add(id);
        if (action === "resume") state.paused.delete(id);
        state.lifecycleWrites.push(`${route.request.method} ${url.pathname}`);
      }
      return route.fulfill({
        json: {
          lifecycle: {
            agentId: id,
            paused: state.paused.has(id),
            pausedAt: null,
            notify: "all",
          },
        },
      });
    },
  );

  await browser.addInitScript(() => {
    if (window.top === window && /^https?:$/.test(location.protocol))
      localStorage.setItem("openbot-skin", "opendots");
  });
  // An empty, settled chat behind every conversation the frame is drawn around.
  await configureChatStream(browser, []);
  return state;
}

/** Opens `path` with the skin on the account, and holds the page to actually wearing it. */
async function openSkin({ app, browser }: Fixtures, path: string) {
  await app.open(path);
  await expect(browser.locator("html")).toHaveAttribute(
    "data-skin",
    "opendots",
  );
}

/** Every address a scope links to, as the browser would follow it. */
function hrefs(browser: Browser, scope = "body") {
  return browser.evaluate(
    (scope) =>
      Array.from(
        document.querySelectorAll(`${scope} a[href]`),
        (link) => link.getAttribute("href") ?? "",
      ),
    scope,
  );
}

/** The frame's Bot rows, in order: their names, where each opens, and the avatar each wears. */
function botRows(browser: Browser) {
  return browser.evaluate(() => {
    // React gives each avatar instance its own ids; strip them so two drawings can be compared.
    const drawing = (root: Element | null) =>
      (root?.querySelector("svg")?.outerHTML ?? "").replace(/_r_[\w]+_/g, "");
    return Array.from(
      document.querySelectorAll(
        'nav[aria-label="Your Bots"] [data-testid="opendots-bot"]',
      ),
      (row) => ({
        name: row.textContent?.trim() ?? "",
        href: row.getAttribute("href") ?? "",
        avatar:
          row
            .querySelector('[role="img"][aria-label]')
            ?.getAttribute("aria-label") ?? "",
        drawing: drawing(row),
      }),
    );
  });
}

/** OpenBot's own destinations for `role` on this edition, as the rail draws them, in order. */
function railDestinations(role: "user" | "admin") {
  if (personal)
    return [
      { label: "Bots", href: "/bots" },
      { label: "Connections", href: "/connections" },
      { label: "Settings", href: "/settings" },
    ];
  return [
    { label: "Bots", href: "/bots" },
    { label: "Capabilities", href: "/capabilities" },
    { label: "Connections", href: "/connections" },
    ...(role === "admin" ? [{ label: "Admin", href: "/admin" }] : []),
    { label: "Settings", href: "/settings" },
  ];
}

test("BOTS lists the Bots the agents route returns, in the roster's order", async (fixtures) => {
  const { browser, screen } = fixtures;
  const state = await serveFrame(browser);
  await openSkin(fixtures, "/");
  await expect(
    screen.getByRole("navigation", "Your Bots", { exact: true }),
  ).toBeVisible();
  await expect(browser.locator('[data-testid="opendots-bot"]')).toHaveCount(3);
  const rows = await botRows(browser);
  expect(rows.map((row) => row.name)).toEqual(["Brook", "Ada", "Cass"]);
  expect(state.agentListReads).toBeGreaterThan(0);
});

test("a Bot's row reopens its latest chat, starts one when there is none, and its settings open the Bot", async (fixtures) => {
  const { browser, screen } = fixtures;
  await serveFrame(browser);
  await openSkin(fixtures, "/");
  await expect(browser.locator('[data-testid="opendots-bot"]')).toHaveCount(3);
  const rows = await botRows(browser);
  const hrefOf = (name: string) => rows.find((row) => row.name === name)?.href;
  // Brook has a conversation of his own; Ada is only in a group, so choosing her starts one.
  expect(hrefOf("Brook")).toBe("/channel/trip");
  expect(hrefOf("Ada")).toBe("/channel/new?agent=ada");

  await screen.getByRole("link", "Ada", { exact: true }).click();
  await expect(browser).toHaveURL("/channel/new?agent=ada");
  await expect(browser.locator('[data-testid="opendots-crumb"]')).toHaveText(
    "Ada",
  );

  // The row's trailing dots open the Bot; IconAction renders it as a labelled button over a link.
  await screen
    .getByRole("button", "Open Cass's settings", { exact: true })
    .click();
  await expect(browser).toHaveURL("/bots/cass");
});

test("a new conversation with a chosen Bot is OpenDots' coworker home", async (fixtures) => {
  const { screen } = fixtures;
  await serveFrame(fixtures.browser);
  await openSkin(fixtures, "/channel/new?agent=ada");
  await expect(
    screen.getByRole("heading", "Ada", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("Ada helps.", { exact: true })).toBeVisible();
  await expect(screen.getByRole("link", /Edit Bot/)).toHaveAttribute(
    "href",
    "/bots/ada",
  );
  // Without a chosen Bot there is no one to introduce.
  await openSkin(fixtures, "/channel/new");
  await expect(screen.getByRole("link", /Edit Bot/)).toHaveCount(0);
});

test(`every OpenBot surface is reachable from the ${edition} frame`, async (fixtures) => {
  const { browser, screen } = fixtures;
  await serveFrame(browser);
  await openSkin(fixtures, "/");
  await expect(
    screen.getByText("Planning the Lisbon trip", { exact: true }),
  ).toBeVisible();
  const links = await hrefs(browser);
  for (const href of [
    "/", // home
    "/channel/new", // new chat
    "/channel/trip", // a conversation with one Bot
    "/group/standup", // a group conversation
    "/bots", // Bots, where approvals, responsibilities and Team Bots now live
    "/bots?new=true", // creating a Bot
    "/bots/ada", // each Bot's own pages
    "/bots/brook",
    "/bots/cass",
    "/s/routines", // routines
    ...(personal ? [] : ["/s/memories", "/capabilities"]), // memory, and skills and memory
    "/connections",
    "/settings", // the skin picker, approvals and reachability
  ]) {
    expect(links).toContain(href);
  }
  // Admin is offered only to the people the server lets in, and never in the personal edition.
  expect(links).not.toContain("/admin");
  if (personal) {
    // A single-person install has no session to end, so Sign out is never drawn.
    expect(
      await browser.evaluate(
        () => document.querySelector('[aria-label="Sign out"]') === null,
      ),
    ).toBe(true);
  } else {
    await screen.getByRole("button", "Account", { exact: true }).click();
    await expect(
      screen.getByRole("menuitem", "Sign out", { exact: true }),
    ).toBeVisible();
  }
});

test("on a phone the sidebar is a drawer, and every surface is in it", async (fixtures) => {
  const { browser, screen } = fixtures;
  await serveFrame(browser);
  await browser.setViewport({ width: 390, height: 844 });
  await openSkin(fixtures, "/");
  // The drawer is shut until asked for, so the page has the screen.
  await expect(browser.locator('aside[aria-label="Sidebar"]')).toHaveCount(0);
  await screen.getByRole("button", "Open navigation", { exact: true }).click();
  const drawer = screen.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByText("Planning the Lisbon trip", { exact: true }),
  ).toBeVisible();
  const links = await hrefs(browser, '[role="dialog"]');
  for (const href of [
    "/channel/new",
    "/channel/trip",
    "/bots",
    "/s/routines",
    ...(personal ? [] : ["/s/memories", "/capabilities"]),
    "/connections",
    "/settings",
  ]) {
    expect(links).toContain(href);
  }
  // A single-person install has no session to end, so Sign out is never in the drawer.
  const signOut = drawer.getByRole("button", "Sign out", { exact: true });
  if (personal) await expect(signOut).toHaveCount(0);
  else await expect(signOut).toBeVisible();
});

test("the frame's chrome is marked, so reduced motion can still it", async (fixtures) => {
  const { browser } = fixtures;
  await serveFrame(browser);
  await openSkin(fixtures, "/");
  await expect(
    browser.locator('nav[aria-label="Workspace navigation"]'),
  ).toBeVisible();
  const marked = await browser.evaluate(() =>
    [
      document.querySelector('nav[aria-label="Workspace navigation"]'),
      document.querySelector('aside[aria-label="Sidebar"]'),
      document.querySelector('nav[aria-label="Breadcrumb"]')?.closest("header"),
    ].map((element) => element?.hasAttribute("data-opendots-chrome") ?? false),
  );
  expect(marked).toEqual([true, true, true]);
});

for (const [who, role] of [
  ["a member", "user"],
  ["an admin", "admin"],
] as const) {
  test(`the rail and sidebar draw OpenBot's own navigation list for ${who}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const state = await serveFrame(browser);
    state.role = role;
    await openSkin(fixtures, "/");
    await expect(
      screen.getByRole("navigation", "Workspace navigation", { exact: true }),
    ).toBeVisible();
    const expected = railDestinations(role);
    // Every destination OpenBot's sidebar offers this person, under its own label, and no others.
    const navigation =
      "/bots /routines /capabilities /connections /admin /settings".split(" ");
    const rail = (
      await browser.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            'nav[aria-label="Workspace navigation"] a[href]',
          ),
          (link) => ({
            label:
              link.getAttribute("aria-label") ?? link.textContent?.trim() ?? "",
            href: link.getAttribute("href") ?? "",
          }),
        ),
      )
    ).filter((link) => navigation.includes(link.href));
    expect(rail).toEqual(expected);
    const sidebar = await hrefs(browser, 'aside[aria-label="Sidebar"]');
    for (const item of expected) expect(sidebar).toContain(item.href);
  });
}

for (const path of [
  "/",
  "/channel/trip",
  "/group/standup",
  "/bots/ada/setup",
  "/s/routines",
  "/connections",
]) {
  test(`Settings is reachable on ${path}, even when nothing else loads`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const state = await serveFrame(browser);
    state.agentsFail = true;
    state.channels = [];
    await openSkin(fixtures, path);
    // In the rail and in the sidebar, so collapsing the sidebar never hides it.
    await expect
      .poll(() =>
        browser.evaluate(
          () => document.querySelectorAll('a[href="/settings"]').length,
        ),
      )
      .toBe(2);
    await expect(
      screen
        .getByRole("navigation", "Workspace navigation", { exact: true })
        .getByRole("link", "Settings", { exact: true }),
    ).toHaveAttribute("href", "/settings");
  });
}

test("on a conversation, the computer toggle opens the conversation's own computer pane", async (fixtures) => {
  const { browser, screen } = fixtures;
  await serveFrame(browser);
  await serveComputer(browser, "brook", { status: "absent", frame: "absent" });
  await openSkin(fixtures, "/channel/trip");
  await screen.getByRole("button", "Show computer", { exact: true }).click();
  await expect(browser).toHaveURL("/channel/trip?watch=true");
  // No second screen: the frame's own pane stays shut where the page has one.
  await expect(
    browser.locator('[data-testid="opendots-computer-pane"]'),
  ).toHaveCount(0);
  await screen.getByRole("button", "Hide computer", { exact: true }).click();
  await expect(browser).toHaveURL("/channel/trip");
});

test("elsewhere, the computer toggle opens OpenBot's computer for the Bot on screen", async (fixtures) => {
  const { browser, screen } = fixtures;
  await serveFrame(browser);
  await serveComputer(browser, "cass", { status: "absent", frame: "absent" });
  await openSkin(fixtures, "/bots/cass");
  await expect(browser.locator('[data-testid="opendots-crumb"]')).toHaveText(
    "Cass",
  );
  await screen.getByRole("button", "Show computer", { exact: true }).click();
  const pane = screen.getByTestId("opendots-computer-pane");
  await expect(pane).toBeVisible();
  await expect(
    pane.getByText("Cass’s computer", { exact: true }),
  ).toBeVisible();
  // OpenBot's own panel, not a copy of it.
  await expect(
    pane.getByRole("region", "Computer sidebar", { exact: true }),
  ).toBeVisible();
  await pane.getByRole("button", "Close computer", { exact: true }).click();
  await expect(
    browser.locator('[data-testid="opendots-computer-pane"]'),
  ).toHaveCount(0);
});

test("the Bot on screen can be paused and resumed from the top bar", async (fixtures) => {
  const { browser, screen } = fixtures;
  const state = await serveFrame(browser);
  await openSkin(fixtures, "/channel/new?agent=ada");
  await screen.getByRole("button", "Pause Ada", { exact: true }).click();
  await expect
    .poll(() => [...state.lifecycleWrites])
    .toContain("POST /api/bots/ada/pause");
  await expect(
    screen.getByRole("button", "Resume Ada", { exact: true }),
  ).toBeVisible();
  // A page about no one Bot offers no pause, since there would be nothing to say it applies to.
  await openSkin(fixtures, "/connections");
  await expect(screen.getByRole("button", /^Pause /)).toHaveCount(0);
});

test("Routines is OpenBot's routines list under OpenDots' heading", async (fixtures) => {
  const { screen } = fixtures;
  await serveFrame(fixtures.browser);
  await openSkin(fixtures, "/s/routines");
  await expect(
    screen.getByRole("heading", "Routines", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("No routines yet", { exact: true }),
  ).toBeVisible();
});

if (!personal) {
  test("Memories is OpenBot's memory list under OpenDots' heading, with Remember a fact", async (fixtures) => {
    const { screen } = fixtures;
    await serveFrame(fixtures.browser);
    await openSkin(fixtures, "/s/memories");
    await expect(
      screen.getByRole("heading", "Memories", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText("No memories yet", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByRole("button", /Remember a fact/)).toBeVisible();
  });
} else {
  test("the personal edition has no Memories row", async (fixtures) => {
    const { browser, screen } = fixtures;
    const state = await serveFrame(browser);
    await openSkin(fixtures, "/");
    const workspace = screen.getByRole("navigation", "Workspace", {
      exact: true,
    });
    await expect(
      workspace.getByText("Routines", { exact: true }),
    ).toBeVisible();
    await expect(workspace.getByText("Memories", { exact: true })).toHaveCount(
      0,
    );
    expect(await hrefs(browser)).not.toContain("/s/memories");
    expect(state.memoryReads).toBe(0);
  });

  test("the personal edition sends the Memories screen home", async (fixtures) => {
    const { browser, screen } = fixtures;
    await serveFrame(browser);
    await openSkin(fixtures, "/s/memories");
    await expect(browser).toHaveURL("/");
    await expect(
      screen.getByRole("heading", "Memories", { exact: true }),
    ).toHaveCount(0);
  });
}

test("the frame names the product from brand.yaml and never says OpenDots or Dots", async (fixtures) => {
  const { browser, screen } = fixtures;
  await serveFrame(browser);
  await openSkin(fixtures, "/channel/new?agent=ada");
  await expect(
    screen.getByRole("navigation", "Your Bots", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("heading", "Ada", { exact: true }),
  ).toBeVisible();
  // The name as a brand mark: OpenBot's wordmark carries the trademark sign, as on open.bot.
  await expect(screen.getByTestId("opendots-wordmark")).toHaveText(
    `${productName}™`,
  );
  await expect(
    screen.getByRole("link", `${productName} home`, { exact: true }),
  ).toHaveCount(2);
  const read = await browser.evaluate(() =>
    [
      document.body.textContent ?? "",
      ...Array.from(
        document.querySelectorAll("[aria-label],[title],[alt]"),
        (element) =>
          [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("alt"),
          ].join(" "),
      ),
    ].join(" "),
  );
  expect(read).not.toContain("OpenDots");
  expect(read).not.toMatch(/\bDots?\b/);
  await expect(screen.getByText("BOTS", { exact: true })).toBeVisible();
  await expect(screen.getByText("Bots", { exact: true })).toBeVisible();
  // No plush, no monogram: nothing of OpenDots' own identity is drawn.
  expect(
    await browser.evaluate(
      () => document.querySelector('img[src*="/skins/"]') === null,
    ),
  ).toBe(true);
});

test("every Bot wears OpenBot's own avatar, drawn from its avatarSeed", async (fixtures) => {
  const { browser } = fixtures;
  const state = await serveFrame(browser);
  // Echo carries Ada's seed, so a row drawn from the id instead of the seed cannot match hers.
  state.bots = [
    bot("ada", "Ada"),
    bot("brook", "Brook", { pinned: true }),
    bot("echo", "Echo", { avatarSeed: "seed-ada", mine: false }),
  ];
  state.channels = [];
  await openSkin(fixtures, "/");
  await expect(browser.locator('[data-testid="opendots-bot"]')).toHaveCount(3);
  const rows = await botRows(browser);
  const byName = Object.fromEntries(
    rows.map((row) => [row.name, row] as const),
  );
  expect(rows.map((row) => row.name)).toEqual(["Brook", "Ada", "Echo"]);
  for (const row of rows) {
    expect(row.avatar).toBe(row.name);
    expect(row.drawing).toBeTruthy();
  }
  // Drawn from the seed, not the id: the id would be a different Bot's face.
  expect(byName.Echo?.drawing).toBe(byName.Ada?.drawing);
  expect(byName.Brook?.drawing).not.toBe(byName.Ada?.drawing);
  // The coworker home wears the same Bot's face, larger.
  await openSkin(fixtures, "/channel/new?agent=ada");
  expect(
    await browser.evaluate(
      () =>
        document.querySelector("[data-opendots-persona] [role='img'] svg") !==
        null,
    ),
  ).toBe(true);
});
