import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

type Counts = {
  questions: number;
  approvals: number;
  handoffs: number;
  unread: number;
  items: number;
  tasks: { needsInput: number; ready: number; failed: number };
  waitingIn: string | null;
};

function attention(
  agentId: string,
  name: string,
  counts: Partial<Counts> = {},
) {
  return {
    agentId,
    name,
    questions: 0,
    approvals: 0,
    handoffs: 0,
    unread: 0,
    paused: false,
    notify: "all",
    items: 0,
    tasks: { needsInput: 0, ready: 0, failed: 0 },
    ...counts,
  };
}

function suggestion(
  id: string,
  agentId: string,
  title: string,
  pingId: string,
) {
  return {
    id,
    agentId,
    title,
    pingId,
    detail: "Why it was raised.",
    sourceApp: "Gmail",
    sourceRef: "gmail/message",
    sourceLink: null,
    createdAt: "2026-10-30T10:00:00Z",
  };
}

async function serveAttention(
  browser: Browser,
  read: () => {
    bots: ReturnType<typeof attention>[];
    lastPingId?: string | null;
    suggestions?: ReturnType<typeof suggestion>[];
  },
) {
  await browser.addInitScript(() => {
    // Keep the app's recurring poll and shorten the interval for Chromium.
    const setInterval = window.setInterval.bind(window);
    Object.defineProperty(window, "setInterval", {
      value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        setInterval(handler, timeout === 15_000 ? 500 : timeout, ...args),
    });

    document.hasFocus = () => false;
    const notices: {
      title: string;
      body?: string;
      tag?: string;
      path?: string;
    }[] = [];
    class TestNotification {
      static permission = "granted";
      constructor(
        title: string,
        options?: NotificationOptions & { extra?: { path?: string } },
      ) {
        notices.push({
          title,
          body: options?.body,
          tag: options?.tag,
          path: options?.extra?.path,
        });
      }
    }
    Object.defineProperty(window, "Notification", { value: TestNotification });
    Object.defineProperty(window, "openBotTestNotices", { value: notices });
  });
  await browser.route(/\/api\/bots\/attention$/, (route) => {
    const { bots, lastPingId = null } = read();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ bots, lastPingId }),
    });
  });
  await browser.route(/\/api\/proactive\/suggestions$/, (route) =>
    route.fulfill({ json: { suggestions: read().suggestions ?? [] } }),
  );
  return () =>
    browser.evaluate(() => {
      return (
        (window as Window & { openBotTestNotices?: Record<string, string>[] })
          .openBotTestNotices ?? null
      );
    });
}

const badgeSelector = 'a[href="/bots"] [role="img"]';

function sidebarBadge(browser: Browser, label: string) {
  return browser.locator(`${badgeSelector}[aria-label="${label}"]`);
}

test("the sidebar counts blocked work across Bots, shows dots for other news, and clears when quiet", async ({
  app,
  browser,
}) => {
  const expenses = (counts?: Partial<Counts>) =>
    attention("expenses", "Expenses", counts);
  const knowledge = (counts?: Partial<Counts>) =>
    attention("knowledge", "Knowledge", counts);
  let bots = [
    expenses({ questions: 1, approvals: 1 }),
    knowledge({ handoffs: 1, unread: 4 }),
  ];
  await serveAttention(browser, () => ({ bots }));
  await app.open("/");
  const badge = browser.locator(`${badgeSelector}[aria-label$=" you"]`);
  await expect(sidebarBadge(browser, "3 things need you")).toHaveText("3");

  bots = [
    expenses({
      approvals: 1,
      items: 2,
      tasks: { needsInput: 1, ready: 1, failed: 1 },
    }),
    knowledge({ items: 1 }),
  ];
  await expect(sidebarBadge(browser, "4 things need you")).toHaveText("4");

  bots = [expenses({ unread: 2 })];
  const unread = sidebarBadge(browser, "Unread messages");
  await expect(unread).toBeVisible();
  await expect(unread).toHaveText("");
  await expect(badge).toHaveCount(0);

  bots = [knowledge({ items: 2 })];
  const checkIns = sidebarBadge(browser, "Your check-ins found something");
  await expect(checkIns).toBeVisible();
  await expect(checkIns).toHaveText("");
  await expect(unread).toHaveCount(0);
  await expect(badge).toHaveCount(0);

  bots = [expenses(), knowledge()];
  await expect(checkIns).toHaveCount(0);
  await expect(badge).toHaveCount(0);
});

test("new tasks and questions send one notification to the corresponding Bot or conversation", async (fixtures) => {
  const { app, browser } = fixtures;
  const owner = await createBot(fixtures);
  const other = await createBot(fixtures);
  const channel = await createConversation(
    browser,
    other.id,
    "Approval planning",
  );
  const ownerState = (counts?: Partial<Counts>) =>
    attention(owner.id, owner.name, counts);
  const otherState = (counts?: Partial<Counts>) =>
    attention(other.id, other.name, counts);
  let bots = [ownerState({ unread: 1 }), otherState()];
  const notices = await serveAttention(browser, () => ({ bots }));
  await app.open("/");
  await expect(sidebarBadge(browser, "Unread messages")).toBeVisible();
  expect(await notices()).toEqual([]);

  const taskState = ownerState({
    tasks: { needsInput: 1, ready: 0, failed: 0 },
  });
  bots = [taskState, otherState()];
  const taskNotice = {
    title: `${owner.name} needs you`,
    body: "1 task waiting on you",
    tag: `openbot-attention-${owner.id}`,
    path: `/bots/${owner.id}`,
  };
  await expect.poll(notices).toEqual([taskNotice]);

  const withoutConversation = otherState({ questions: 1 });
  bots = [taskState, withoutConversation];
  const botQuestionNotice = {
    title: `${other.name} needs you`,
    body: "1 question",
    tag: `openbot-attention-${other.id}`,
    path: `/bots/${other.id}`,
  };
  await expect.poll(notices).toEqual([taskNotice, botQuestionNotice]);

  // The next ask rises while a conversation is waiting for the person.
  bots = [taskState, otherState({ questions: 2, waitingIn: channel })];
  await expect.poll(notices).toEqual([
    taskNotice,
    botQuestionNotice,
    {
      title: `${other.name} needs you`,
      body: "2 questions",
      tag: `openbot-${channel}`,
      path: `/channel/${channel}`,
    },
  ]);
  await expect(sidebarBadge(browser, "3 things need you")).toHaveText("3");
});

test("check-in pings notify once per new batch with Bot labels and duplicate titles folded", async ({
  app,
  browser,
}) => {
  const expenses = (counts?: Partial<Counts>) =>
    attention("expenses", "Expenses", counts);
  const knowledge = (counts?: Partial<Counts>) =>
    attention("knowledge", "Knowledge", counts);
  let bots = [expenses({ items: 1 }), knowledge()];
  let lastPingId = "already-sent";
  let suggestions = [
    suggestion("old", "expenses", "Already announced", lastPingId),
  ];
  const notices = await serveAttention(browser, () => ({
    bots,
    lastPingId,
    suggestions,
  }));
  await app.open("/");
  await expect(
    sidebarBadge(browser, "Your check-ins found something"),
  ).toBeVisible();
  expect(await notices()).toEqual([]);

  lastPingId = "invoice-ping";
  suggestions = [
    suggestion("invoice", "expenses", "Approve the March invoice", lastPingId),
    suggestion("reply", "expenses", "Reply to Dana", lastPingId),
    suggestion(
      "wiki",
      "knowledge",
      "Fix the stale onboarding page",
      lastPingId,
    ),
    suggestion("duplicate", "knowledge", "reply to Dana.", lastPingId),
  ];
  bots = [expenses({ items: 2 }), knowledge({ items: 2 })];
  const initial = {
    title: "3 things need you",
    body: [
      "Expenses: Approve the March invoice",
      "Expenses: Reply to Dana",
      "Knowledge: Fix the stale onboarding page",
    ].join("\n"),
    tag: "openbot-ping-invoice-ping",
    path: "/bots",
  };
  await expect.poll(notices).toEqual([initial]);

  suggestions = [
    ...suggestions,
    suggestion("venue", "expenses", "Book the venue", "venue-ping"),
  ];
  bots = [expenses({ unread: 1, items: 3 }), knowledge({ items: 2 })];
  await expect(sidebarBadge(browser, "Unread messages")).toBeVisible();
  expect(await notices()).toEqual([initial]);

  lastPingId = "venue-ping";
  await expect.poll(notices).toEqual([
    initial,
    {
      title: "One thing needs you",
      body: "Expenses: Book the venue",
      tag: "openbot-ping-venue-ping",
      path: "/bots",
    },
  ]);
});
