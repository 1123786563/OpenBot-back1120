import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import { appConfig } from "../../app/src/lib/generated/application-config";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { stageChatRun } from "./staged-chat-stream";

/*
 * OpenDuet in a real Chromium: the registered Frame around OpenBot's real routes, its Tasks screen
 * at `/s/tasks`, and its orb over the real composer. Only API responses are fixed; the words and
 * requests the skin draws are OpenBot's own, driven the way the sidebar tests drive them (a fixed
 * `/api/me` for the role, fixed inbox and routine lists for Tasks). What `conversation-layout.e2e.ts`
 * already covers for this skin — the 430px reading column — is not repeated here.
 */

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const product = appConfig.brand.productName;
const at = "2026-10-27T10:00:00.000Z";
const kilnQuestion = "Which kiln should I book the repair for?";
const mugSuggestion = "Confirm Friday ship date for the 120 mugs";

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

/**
 * OpenDuet everywhere in this browser, before any page is opened: the account preference names the
 * skin, and the pre-paint cache `index.html` reads (`localStorage["openbot-skin"]`) draws it from
 * the first paint. Every test then asserts `<html data-skin="openduet">` before anything else.
 */
async function serveOpenDuetSkin(browser: Browser) {
  await browser.route(/\/api\/settings\/preferences$/, (route) =>
    route.fulfill({
      json: {
        preferences: {
          messageListEmphasis: "thread",
          selfHostBannerDismissed: true,
          narration: null,
          skin: "openduet",
          proactive: "on",
        },
      },
    }),
  );
  await browser.addInitScript(() => {
    if (window.top === window && /^https?:$/.test(location.protocol))
      localStorage.setItem("openbot-skin", "openduet");
  });
}

/** The frame's role differences come from `/api/me`, as the sidebar tests drive them. */
async function serveRole(browser: Browser, role: "admin" | "user") {
  await browser.route(/\/api\/me$/, (route) =>
    route.fulfill({
      json: {
        user: {
          id: "maya",
          name: "Maya Chen",
          email: "maya@example.test",
          role,
          onboarding: null,
        },
      },
    }),
  );
}

/** Everything else about the deployment stays real; only transcription is decided here. */
async function serveTranscription(browser: Browser, transcription: boolean) {
  await browser.route(/\/api\/capabilities$/, async (route) => {
    const real = await (await route.fetch()).json<Record<string, unknown>>();
    return route.fulfill({ json: { ...real, transcription } });
  });
}

/** A real Bot through the real API, as `NewBotSheet` creates one. */
async function createBot(browser: Browser, name: string) {
  return browser.evaluate(async (name) => {
    const response = await fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        title: "Helps with the OpenDuet tests",
        roleDescription: "Answers what it can.",
        visibility: "private",
        endpoint: "",
      }),
    });
    if (!response.ok)
      throw new Error(`Cannot create the test Bot: ${response.status}`);
    const data: { agent: { id: string } } = await response.json();
    return data.agent.id;
  }, name);
}

/** One conversation with a single Bot and one group, both named for the menu to draw. */
async function createConversations(browser: Browser) {
  const first = await createBot(browser, "Kiln Bot");
  const second = await createBot(browser, "Ops Bot");
  return {
    bot: first,
    single: await createConversation(
      browser,
      first,
      "Renewal for the studio policy",
    ),
    group: await createConversation(
      browser,
      [first, second],
      "Kiln repair plan",
    ),
  };
}

async function openMenu({ screen }: Pick<Fixtures, "screen">) {
  await screen.getByRole("button", "Menu", { exact: true }).click();
  const menu = screen.getByRole("navigation", "Menu", { exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/** Every address a link on screen goes to, the menu's included. */
function hrefs(browser: Browser) {
  return browser.evaluate(() =>
    Array.from(
      document.querySelectorAll("a[href]"),
      (link) => link.getAttribute("href") ?? "",
    ),
  );
}

/** A row's words: the ™ sign is not part of a name, and a badge's count trails it. */
function rowLabel(text: string | null) {
  return (text ?? "").replaceAll("™", "").trim().replace(/\d+$/, "");
}

/** What the frame says about the screen it holds. */
function frameColumn(browser: Browser) {
  return browser.locator("[data-openduet-column]");
}

/*
 * Tasks and its badge hold to OpenBot's own lists: one pending approval, one question, and a
 * decided approval that must not draw. The Bot and its conversation are real, so OpenBot's own
 * rows say their real names.
 */
async function serveTasks(
  browser: Browser,
  bot: string,
  channel: string,
  decided: boolean,
) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const request = (
    id: string,
    status: string,
    toolRef: string,
    scope: string,
    args: Record<string, string>,
  ) => ({
    id,
    status,
    createdAt: at,
    action: {
      botId: bot,
      toolRef,
      effect: "write",
      scope,
      threadId: "t-openduet",
      args,
      target: null,
      ...(status === "pending"
        ? {
            policy: {
              behaviour: "ask",
              source: "rule",
              reason: "Sending mail asks first.",
            },
          }
        : {}),
    },
  });
  const inbox = {
    enabled: true,
    rules: [],
    teamRules: [],
    requests: [
      request(
        "r-waiting",
        "pending",
        "mcp/gmail/send_email",
        "priya@example.com",
        {
          to: "priya@example.com",
          body: "Thursday at 10 works.",
        },
      ),
      ...(decided
        ? [
            request(
              "r-allowed",
              "allowed",
              "mcp/drive/share",
              "Quarterly plan",
              {},
            ),
            request("r-denied", "denied", "computer_run_command", "workspace", {
              command: "echo hello",
            }),
          ]
        : []),
    ],
    questions: [
      {
        id: "q-1",
        botId: bot,
        threadId: "t-openduet",
        question: kilnQuestion,
        createdAt: at,
      },
    ],
  };
  await browser.route(/\/api\/approvals(\/|$)/, async (route) => {
    const path = new URL(route.request.url).pathname;
    if (route.request.method === "GET" && path === "/api/approvals")
      return route.fulfill({ json: inbox });
    if (route.request.method === "POST") {
      sent.push({
        method: "POST",
        path,
        body: route.request.postData
          ? JSON.parse(route.request.postData)
          : null,
      });
      return route.fulfill({ json: true });
    }
    return route.continue();
  });
  await browser.route(/\/api\/responsibilities$/, (route) =>
    route.fulfill({
      json: {
        responsibilities: [
          {
            id: "resp-on",
            agentId: bot,
            channelId: channel,
            threadId: "t-openduet",
            title: "Keep the support inbox at zero",
            instruction: "Answer what you can, hand me the rest.",
            successCriteria: "",
            status: "active",
            progress: "Answered 4 of 6 this morning",
            lastResult: null,
            subscriptions: [],
            updatedAt: at,
          },
        ],
      },
    }),
  );
  await browser.route(/\/api\/routines$/, (route) =>
    route.fulfill({
      json: {
        routines: [
          {
            id: "rt-on",
            agentId: bot,
            schedule: "Every weekday at 9:00",
            timezone: "UTC",
            instruction: "Post the standup notes",
            channel: {
              id: channel,
              name: "Ops group",
              title: "Weekly ops review",
              gone: false,
            },
            enabled: true,
            nextRunAt: "2026-10-28T09:00:00.000Z",
            lastRun: null,
          },
        ],
        sweep: { lastSweptAt: at, working: true },
      },
    }),
  );
  await browser.route(/\/api\/tasks$/, (route) =>
    route.fulfill({ json: { tasks: [] } }),
  );
  await browser.route(/\/api\/proactive\/suggestions(\/|$)/, async (route) => {
    const path = new URL(route.request.url).pathname;
    if (route.request.method === "GET" && path === "/api/proactive/suggestions")
      return route.fulfill({
        json: {
          suggestions: [
            {
              id: "s-1",
              agentId: bot,
              title: mugSuggestion,
              detail: "Ana needs it confirmed by end of day.",
              sourceApp: "Gmail",
              sourceRef: "gmail/message",
              sourceLink: null,
              pingId: "ping-1",
              createdAt: at,
            },
          ],
        },
      });
    if (route.request.method === "POST") {
      sent.push({
        method: "POST",
        path,
        body: route.request.postData
          ? JSON.parse(route.request.postData)
          : null,
      });
      return route.fulfill({ json: true });
    }
    return route.continue();
  });
  return { sent };
}

test("the menu reaches Chat, each conversation, and every page the sidebar did", async (fixtures) => {
  const { app, browser } = fixtures;
  await serveOpenDuetSkin(browser);
  await serveRole(browser, "admin");
  await app.open("/");
  const { single, group } = await createConversations(browser);
  await app.open("/");
  await expect(browser.locator("html")).toHaveAttribute(
    "data-skin",
    "openduet",
  );
  const menu = await openMenu(fixtures);
  await expect(menu.getByText("Renewal for the studio policy")).toBeVisible();
  await menu.getByRole("button", /Manage/).click();
  const links = await hrefs(browser);
  for (const place of [
    "/",
    `/channel/${single}`,
    `/group/${group}`,
    "/channel/new",
    "/s/tasks",
    "/bots",
    "/settings",
    "/connections",
    ...(personal ? [] : ["/capabilities", "/admin"]),
  ])
    expect(links).toContain(place);
});

test("the menu's destinations are exactly OpenBot's one navigation list", async (fixtures) => {
  const { app, browser } = fixtures;
  for (const role of personal
    ? (["user"] as const)
    : (["user", "admin"] as const)) {
    await serveOpenDuetSkin(browser);
    await serveRole(browser, role);
    await app.open("/");
    await expect(browser.locator("html")).toHaveAttribute(
      "data-skin",
      "openduet",
    );
    const menu = await openMenu(fixtures);
    const manage = menu.getByRole("button", /Manage/);
    await manage.click();
    const drawn = await browser.evaluate(
      (id) =>
        Array.from(
          document.getElementById(id)?.querySelectorAll("a, button") ?? [],
          (row) => row.textContent ?? "",
        ),
      (await manage.getAttribute("aria-controls")) ?? "",
    );
    const settings = menu.getByRole("link", "Settings", { exact: true });
    expect([
      ...drawn.map(rowLabel),
      rowLabel(await settings.textContent()),
    ]).toEqual([
      ...(personal
        ? ["Bots", "Routines", "Connections", "OpenBot for Business"]
        : [
            "Bots",
            "Routines",
            "Capabilities",
            "Connections",
            ...(role === "admin" ? ["Admin"] : []),
          ]),
      "Settings",
    ]);
  }
});

test("Settings is on every tab without opening anything, and Admin only for administrators", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await serveRole(browser, "user");
  await app.open("/");
  await expect(browser.locator("html")).toHaveAttribute(
    "data-skin",
    "openduet",
  );
  const settings = screen.getByRole("link", "Your settings", { exact: true });
  await expect(settings).toHaveAttribute("href", "/settings");
  await openMenu(fixtures);
  const links = await hrefs(browser);
  expect(links.filter((href) => href === "/settings").length).toBe(2);
  expect(links).not.toContain("/admin");
  await app.open("/s/tasks");
  await expect(settings).toBeVisible();
});

/*
 * A page opened over the app: the chrome reads the page's own `page-title` and its back link,
 * writes to neither, hides the page's own bar (the rule is `:has()`, which only a real layout
 * engine can evaluate), and its one back disc goes where the page's own link goes.
 */
test("a page opened over the app keeps its own title and has one way back", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await app.open("/");
  const bot = await createBot(browser, "Page Bot");
  await app.open(`/bots/${bot}`);
  await expect(browser.locator("html")).toHaveAttribute(
    "data-skin",
    "openduet",
  );
  await expect(screen.getByRole("button", "Menu", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    screen.getByRole("navigation", "Main", { exact: true }),
  ).toHaveCount(0);
  const back = screen.getByRole("button", "Back to Bots", { exact: true });
  await expect(back).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          document.querySelector("[data-openduet-page] header p[aria-hidden]")
            ?.textContent ?? null,
      ),
    )
    .toBe("Page Bot");
  const page = await browser.evaluate(() => {
    const title = document.querySelector('[data-slot="page-title"]');
    const header = document.querySelector('[data-slot="page-header"]');
    const bar = header?.parentElement?.parentElement?.previousElementSibling;
    return {
      titleAttrs: title?.getAttributeNames().sort() ?? null,
      barTag: bar?.tagName ?? null,
      barLink: bar?.querySelector("a")?.getAttribute("href") ?? null,
      barDisplay: bar ? getComputedStyle(bar).display : null,
    };
  });
  expect(page).toEqual({
    titleAttrs: ["class", "data-slot"],
    barTag: "DIV",
    barLink: "/bots",
    barDisplay: "none",
  });
  await back.click();
  await expect(browser).toHaveURL("/bots");
});

test("Chat and Tasks are phone-shaped, other pages keep OpenBot's width, and an open computer gets the pane", async (fixtures) => {
  const { app, browser } = fixtures;
  await serveOpenDuetSkin(browser);
  await app.open("/");
  const bot = await createBot(browser, "Column Bot");
  const channel = await createConversation(browser, bot);
  for (const [path, tab, column] of [
    ["/", "chat", "phone"],
    ["/channel/new", "chat", "phone"],
    [`/channel/${channel}`, "chat", "phone"],
    [`/channel/${channel}?watch=true`, "chat", "pane"],
    ["/s/tasks", "tasks", "phone"],
    ["/bots", null, "page"],
  ] as const) {
    await app.open(path);
    await expect(browser.locator("html")).toHaveAttribute(
      "data-skin",
      "openduet",
    );
    const frame = frameColumn(browser);
    await expect(frame).toHaveAttribute("data-openduet-column", column);
    if (tab === null) {
      await expect(frame).not.toHaveAttribute("data-openduet-tab", /.+/);
      await expect(frame).toHaveAttribute("data-openduet-page", "");
    } else {
      await expect(frame).toHaveAttribute("data-openduet-tab", tab);
    }
  }
});

test("Active shows OpenBot's waiting list, responsibilities and routines, each under its own name", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await app.open("/");
  const bot = await createBot(browser, "Kiln Bot");
  const channel = await createConversation(browser, bot, "Kiln repair plan");
  await serveTasks(browser, bot, channel, true);
  await app.open("/s/tasks");
  await expect(browser.locator("html")).toHaveAttribute(
    "data-skin",
    "openduet",
  );
  await screen.getByRole("tab", "Active", { exact: true }).click();
  const needs = screen.getByRole("region", "Needs input", { exact: true });
  await expect(needs.getByText(/Kiln Bot wants to/)).toBeVisible();
  await expect(
    needs.getByText(`Kiln Bot asks: ${kilnQuestion}`, { exact: true }),
  ).toBeVisible();
  // OpenBot's list always shows what the action would send.
  await expect(needs.getByText(/Thursday at 10 works\./)).toBeVisible();
  await expect(needs.getByText(/drive\/share/)).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Keep the support inbox at zero Active", {
      exact: true,
    }),
  ).toBeVisible();
  const routines = screen.getByRole("region", "Routines", { exact: true });
  await expect(routines.getByText("Post the standup notes")).toBeVisible();
  const names = await browser.evaluate(() =>
    Array.from(
      document.querySelectorAll("#openduet-tasks-panel section[aria-label]"),
      (section) => section.getAttribute("aria-label"),
    ),
  );
  expect(new Set(names).size).toBe(names.length);
});

test("an approval is decided in OpenBot's own row", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await app.open("/");
  const bot = await createBot(browser, "Kiln Bot");
  const channel = await createConversation(browser, bot);
  const { sent } = await serveTasks(browser, bot, channel, false);
  await app.open("/s/tasks");
  await screen.getByRole("tab", "Active", { exact: true }).click();
  const needs = screen.getByRole("region", "Needs input", { exact: true });
  await needs.getByRole("button", "Allow once", { exact: true }).click();
  await expect
    .poll(() =>
      sent.find((call) => call.path === "/api/approvals/r-waiting/decision"),
    )
    .toMatchObject({ method: "POST", body: { decision: "allow_once" } });
});

test("a Bot's question is answered in OpenBot's own row", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await app.open("/");
  const bot = await createBot(browser, "Kiln Bot");
  const channel = await createConversation(browser, bot);
  const { sent } = await serveTasks(browser, bot, channel, false);
  await app.open("/s/tasks");
  await screen.getByRole("tab", "Active", { exact: true }).click();
  const needs = screen.getByRole("region", "Needs input", { exact: true });
  const send = needs.getByRole("button", "Send answer", { exact: true });
  await expect(send).toBeDisabled();
  await needs
    .getByRole("textbox", "Your answer", { exact: true })
    .fill("Kiln 2");
  await expect(send).toBeEnabled();
  await send.click();
  await expect
    .poll(() =>
      sent.find((call) => call.path === "/api/approvals/questions/q-1/respond"),
    )
    .toMatchObject({ method: "POST", body: { response: "Kiln 2" } });
});

test("Up next starts or hides a suggestion with OpenBot's own suggestion list", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await app.open("/");
  const bot = await createBot(browser, "Kiln Bot");
  const channel = await createConversation(browser, bot);
  const { sent } = await serveTasks(browser, bot, channel, false);
  await app.open("/s/tasks");
  await screen.getByRole("tab", "Up next", { exact: true }).click();
  await expect(screen.getByText(mugSuggestion, { exact: true })).toBeVisible();
  await screen.getByRole("button", "Work on it", { exact: true }).click();
  await expect
    .poll(() =>
      sent.find((call) => call.path === "/api/proactive/suggestions/s-1/start"),
    )
    .toMatchObject({ method: "POST", body: null });
  await screen
    .getByRole("button", `Dismiss ${mugSuggestion}`, { exact: true })
    .click();
  await expect
    .poll(() =>
      sent.find(
        (call) => call.path === "/api/proactive/suggestions/s-1/dismiss",
      ),
    )
    .toMatchObject({ method: "POST", body: null });
});

/*
 * The badge counts the way OpenBot's `WaitingForYou` filters, so it can never disagree with the
 * rows: one pending approval and one question wait, and the decided ones draw nowhere.
 */
test("the Tasks badge counts exactly what the Needs input list draws", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await app.open("/");
  const bot = await createBot(browser, "Kiln Bot");
  const channel = await createConversation(browser, bot);
  await serveTasks(browser, bot, channel, true);
  await app.open("/");
  await expect(browser.locator("html")).toHaveAttribute(
    "data-skin",
    "openduet",
  );
  await expect(
    screen.getByRole("link", "Tasks, 2 waiting", { exact: true }),
  ).toBeVisible();
  await app.open("/s/tasks");
  await screen.getByRole("tab", "Active", { exact: true }).click();
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          document.querySelectorAll(
            '#openduet-tasks-panel section[aria-label="Needs input"] [data-slot="item"]',
          ).length,
      ),
    )
    .toBe(2);
});

test("the menu and the orb name the deployment's product, and nothing says OpenDuet", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await serveTranscription(browser, true);
  await app.open("/");
  await expect(browser.locator("html")).toHaveAttribute(
    "data-skin",
    "openduet",
  );
  // OpenBot's own orb, as sign-in and onboarding draw it, and no drawing of OpenDuet's.
  const orb = screen.getByRole("button", `Talk to ${product}`, { exact: true });
  await expect(orb).toBeVisible();
  expect(
    await browser.evaluate((label) => {
      const button = document.querySelector(`button[aria-label="${label}"]`);
      return {
        own: button?.querySelector(".agent-orb") !== null,
        canvas: button?.querySelector("canvas") !== null,
      };
    }, `Talk to ${product}`),
  ).toEqual({ own: true, canvas: false });
  await openMenu(fixtures);
  await expect(screen.getByRole("heading", new RegExp(product))).toBeVisible();
  expect(await readable(browser)).not.toContain("OpenDuet");
});

test("Tasks names nothing as OpenDuet either", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await app.open("/");
  const bot = await createBot(browser, "Kiln Bot");
  const channel = await createConversation(browser, bot);
  await serveTasks(browser, bot, channel, false);
  await app.open("/s/tasks");
  await screen.getByRole("tab", "Active", { exact: true }).click();
  await expect(
    screen.getByRole("region", "Needs input", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("tab", "Up next", { exact: true }).click();
  await expect(
    screen.getByRole("button", "Work on it", { exact: true }),
  ).toBeVisible();
  expect(await readable(browser)).not.toContain("OpenDuet");
});

/** Every word a person can read: the text, and the names and titles on controls. */
function readable(browser: Browser) {
  return browser.evaluate(() => {
    const named = [...document.querySelectorAll("[aria-label], [title], [alt]")]
      .flatMap((node) => [
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        node.getAttribute("alt"),
      ])
      .filter(Boolean);
    return `${document.body.textContent ?? ""}\n${named.join("\n")}`;
  });
}

/*
 * The orb has no dictation of its own: it puts the caret in the composer's own editor, which it
 * finds by OpenBot's `composer-input` hook, and on a screen with no composer it takes the person
 * to Chat.
 */
test("where the composer cannot dictate, the orb presses nothing and puts the caret in its editor", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await serveTranscription(browser, false);
  await app.open("/");
  const bot = await createBot(browser, "Quiet Bot");
  const channel = await createConversation(browser, bot);
  await app.open(`/channel/${channel}`);
  await expect(browser.locator("html")).toHaveAttribute(
    "data-skin",
    "openduet",
  );
  await expect(
    screen.getByRole("textbox", "Message", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", "Chat", { exact: true }).click();
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const active = document.activeElement;
        return (
          active !== null &&
          active.closest('[data-slot="composer-input"]') !== null
        );
      }),
    )
    .toBe(true);
  await app.open("/s/tasks");
  await screen.getByRole("button", "Chat", { exact: true }).click();
  await expect(browser).toHaveURL("/");
  await expect(
    screen.getByRole("button", "Menu", { exact: true }),
  ).toBeVisible();
});

test("pressing the orb starts and stops the composer's own dictation", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await serveTranscription(browser, true);
  await configureChatStream(browser);
  await browser.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () =>
        new AudioContext().createMediaStreamDestination().stream,
    });
    class FixtureRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      readonly mimeType = "audio/webm;codecs=opus";
      state = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        queueMicrotask(() => {
          this.ondataavailable?.(
            new BlobEvent("dataavailable", {
              data: new Blob(["dictation fixture"], { type: this.mimeType }),
            }),
          );
          this.onstop?.();
        });
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FixtureRecorder });
  });
  await app.open("/");
  const bot = await createBot(browser, "Talkative Bot");
  const channel = await createConversation(browser, bot);
  await browser.route(/\/api\/audio\/transcriptions$/, (route) =>
    route.fulfill({ json: { text: "kiln two, thursday morning" } }),
  );
  await app.open(`/channel/${channel}`);
  // The composer's own control is what the orb presses; the orb itself carries no other.
  await expect(browser.locator('[data-slot="composer-dictate"]')).toBeVisible();
  const header = browser.locator("[data-openduet-frame] header");
  const orb = header.getByRole("button", `Talk to ${product}`, { exact: true });
  await browser
    .locator('[data-slot="composer-input"] [role="textbox"]')
    .fill("Book the kiln repair");
  await orb.click();
  const stop = screen.getByRole("button", "Stop and add to your message", {
    exact: true,
  });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(
    screen.getByRole("img", "Live audio waveform", { exact: true }),
  ).toBeVisible();
  await header
    .getByRole("button", "Stop and add to your message", { exact: true })
    .click();
  await expect(stop).toHaveCount(0);
  await expect(orb).toHaveAttribute("aria-pressed", "false");
  await expect(
    browser.locator('[data-slot="composer-input"] [role="textbox"]'),
  ).toContainText("kiln two, thursday morning");
});

/*
 * The orb reads the Bot as working for exactly as long as the composer offers to stop it: a run
 * held open keeps the composer's Stop control on screen, and the orb thinks; the run finishing
 * takes both away. Opening the conversation first shows the orb at rest, however briefly the
 * composer flashes its Stop while it checks for a turn already running.
 */
test("the orb thinks for exactly as long as the composer offers to stop the Bot", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await serveOpenDuetSkin(browser);
  await app.open("/");
  const bot = await createBot(browser, "Busy Bot");
  const channel = await createConversation(browser, bot);
  await configureChatStream(browser, []);
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId }) => [
      { type: "RUN_STARTED", runId, threadId },
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [{ id: "greeting", role: "assistant", content: "On it." }],
      },
    ],
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );
  await browser.addInitScript(() => {
    const recordThinking = () => {
      const pill = document.querySelector(
        '[data-openduet-frame] [aria-live="polite"] p[data-shown="true"]',
      );
      if (pill?.textContent === "Thinking") {
        document.documentElement.dataset.e2eOrbThought = "true";
      }
    };
    new MutationObserver(recordThinking).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-shown"],
    });
  });
  await app.open(`/channel/${channel}`);
  await expect(browser.locator("html")).toHaveAttribute(
    "data-skin",
    "openduet",
  );
  const pill = browser.locator('[data-openduet-frame] [aria-live="polite"] p');
  await expect(pill).toHaveAttribute("data-shown", "false");
  await expect(
    screen.getByRole("button", "Send message", { exact: true }),
  ).toBeVisible();
  expect(
    await browser.evaluate(
      () => document.documentElement.dataset.e2eOrbThought ?? null,
    ),
  ).toBeNull();
  await browser
    .locator('[data-slot="composer-input"] [role="textbox"]')
    .fill("Book the kiln repair");
  await screen.getByRole("button", "Send message", { exact: true }).click();
  await expect(browser.locator('[data-slot="composer-stop"]')).toBeVisible();
  await expect(pill).toHaveAttribute("data-shown", "true");
  await expect(pill).toHaveText("Thinking");
  stream.finish();
  await expect(browser.locator('[data-slot="composer-stop"]')).toHaveCount(0);
  await expect(pill).toHaveAttribute("data-shown", "false");
});
