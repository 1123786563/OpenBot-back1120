import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { type BrowserNotices, captureNotices } from "./browser-notices";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

type Fixtures = Parameters<typeof createBot>[0];
type NoticeOptions = Parameters<typeof captureNotices>[1];
type Notify = "all" | "needs_input" | "none";

const headline = "Categorized three expenses.";
const reply = `${headline}\nThe receipts are in Drive.`;
const nativeCommand = "plugin:openbot-desktop|notify";
const pluginCommand = "plugin:notification|notify";

function receiveChannelEvent(
  browser: Browser,
  channelId: string,
  expected: Record<string, string | boolean | null>,
) {
  return expect
    .poll(() =>
      browser.evaluate(
        ({ channelId, expected }) =>
          (window as BrowserNotices).fixtureRosterEvents?.some(
            (event) =>
              event.channelId === channelId &&
              Object.entries(expected).every(
                ([key, value]) => event[key] === value,
              ),
          ) ?? false,
        { channelId, expected },
      ),
    )
    .toBe(true);
}

function noticeWindow(browser: Browser) {
  return browser.evaluate(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 1950));
    return null;
  });
}

async function channelFixture(
  fixtures: Fixtures,
  options: {
    notices?: NoticeOptions;
    notify?: Notify;
    attention?: "listed" | "unlisted" | "question";
    questionInConversation?: boolean;
  } = {},
) {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id, "March receipts");
  const notify = options.notify ?? "all";
  if (notify !== "all") {
    const status = await browser.evaluate(
      async ({ id, notify }) => {
        const response = await fetch(
          `/api/bots/${encodeURIComponent(id)}/notifications`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notify }),
          },
        );
        return response.status;
      },
      { id: bot.id, notify },
    );
    expect(status).toBe(200);
  }

  const notices = await captureNotices(browser, {
    focus: false,
    observeRoster: true,
    ...options.notices,
  });
  let questions = 0;
  let attentionReads = 0;
  if (options.attention) {
    await browser.route(/\/api\/bots\/attention$/, (route) => {
      attentionReads++;
      return route.fulfill({
        json: {
          bots:
            options.attention === "unlisted"
              ? []
              : [
                  {
                    agentId: bot.id,
                    name: bot.name,
                    questions,
                    approvals: 0,
                    handoffs: 0,
                    unread: 0,
                    paused: false,
                    notify,
                    items: 0,
                    tasks: { needsInput: 0, ready: 0, failed: 0 },
                    ...(questions && options.questionInConversation !== false
                      ? { waitingIn: channel }
                      : {}),
                  },
                ],
          lastPingId: null,
        },
      });
    });
  }
  if (options.attention === "question") {
    await browser.addInitScript(() => {
      const setInterval = window.setInterval.bind(window);
      Object.defineProperty(window, "setInterval", {
        value: (handler: TimerHandler, duration?: number, ...args: unknown[]) =>
          setInterval(handler, duration === 15_000 ? 250 : duration, ...args),
      });
    });
  }
  await app.open("/bots");
  await expect(
    screen.getByRole("heading", "Bots", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(
        () => (window as BrowserNotices).fixtureRosterReady === true,
      ),
    )
    .toBe(true);
  if (options.attention)
    await expect.poll(() => attentionReads).toBeGreaterThan(0);

  const write = (
    kind: string,
    method: "PUT" | "POST",
    body: Record<string, string | boolean | null>,
  ) =>
    browser.evaluate(
      async ({ channel, kind, method, body }) => {
        const result = await fetch(
          `/api/channels/${encodeURIComponent(channel)}/${kind}`,
          {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              kind === "activity"
                ? { ...body, at: new Date().toISOString() }
                : body,
            ),
          },
        );
        return result.status;
      },
      { channel, kind, method, body },
    );
  const speak = async (text: string, agentId: string | null = bot.id) => {
    expect(await write("activity", "POST", { text, agentId })).toBe(204);
    await receiveChannelEvent(browser, channel, {
      lastMessageAgentId: agentId,
      lastMessage: text.replace(/\s+/g, " "),
    });
  };
  const busy = async (busy: boolean) => {
    expect(await write("busy", "POST", { busy })).toBe(204);
    await receiveChannelEvent(browser, channel, { busy });
  };
  const notification = {
    title: `${bot.name} replied`,
    body: headline,
    tag: `openbot-${channel}`,
    path: `/channel/${channel}`,
  };
  return {
    channel,
    bot,
    write,
    speak,
    busy,
    notices,
    notification,
    needsAnswer: () => {
      questions = 1;
    },
  };
}

test("a person's message, rename, pin, and working indicators update the roster without notifying", async (fixtures) => {
  const { browser } = fixtures;
  const { channel, write, speak, busy, notices } =
    await channelFixture(fixtures);
  await speak("Sort my receipts", null);
  expect(
    await write("title", "PUT", { title: "Receipts archive" }),
  ).toBeLessThan(300);
  await receiveChannelEvent(browser, channel, { summary: "Receipts archive" });
  expect(await write("pin", "PUT", { pinned: true })).toBeLessThan(300);
  await receiveChannelEvent(browser, channel, { pinned: true });
  await busy(true);
  await busy(false);
  await noticeWindow(browser);
  expect(await notices()).toEqual([]);
});

for (const scenario of [
  { description: "while the browser is focused", notices: { focus: true } },
  {
    description: "when browser permission is denied",
    notices: { permission: "denied" as const },
  },
  {
    description: "when the listed Bot only notifies for input",
    notify: "needs_input",
    attention: "listed",
  },
  {
    description: "when the listed Bot has notifications off",
    notify: "none",
    attention: "listed",
  },
  {
    description: "when an unlisted Bot only notifies for input",
    notify: "needs_input",
    attention: "unlisted",
  },
] as const) {
  test(`a delivered reply stays silent ${scenario.description}`, async (fixtures) => {
    const settings = await channelFixture(fixtures, scenario);
    await settings.busy(true);
    await settings.speak(reply);
    await settings.busy(false);
    await noticeWindow(fixtures.browser);
    expect(await settings.notices()).toEqual([]);
  });
}

test("an unlisted Bot's notification takes its name from the roster", async (fixtures) => {
  const { notices, notification, speak } = await channelFixture(fixtures, {
    attention: "unlisted",
  });
  await speak(reply);
  await expect.poll(notices).toEqual([notification]);
});

for (const desktop of ["native", "plugin"] as const) {
  test(`Desktop sends complete notification details through the ${desktop} command`, async (fixtures) => {
    const { notices, notification, speak } = await channelFixture(fixtures, {
      notices: { desktop, permission: "default" },
    });
    await speak(reply);
    await expect.poll(notices).toEqual([notification]);
    const commands = await fixtures.browser.evaluate(
      ({ nativeCommand, pluginCommand }) =>
        ((window as BrowserNotices).fixtureDesktopCalls ?? [])
          .map(({ command }) => command)
          .filter(
            (command) => command === nativeCommand || command === pluginCommand,
          ),
      { nativeCommand, pluginCommand },
    );
    expect(commands).toEqual(
      desktop === "native" ? [nativeCommand] : [nativeCommand, pluginCommand],
    );
  });
}

test("Desktop keeps the system notification quiet when focused", async (fixtures) => {
  const { notices, speak } = await channelFixture(fixtures, {
    notices: { desktop: "native", focus: true, permission: "default" },
  });
  await speak(reply);
  await noticeWindow(fixtures.browser);
  expect(await notices()).toEqual([]);
  expect(
    await fixtures.browser.evaluate(
      (command) =>
        (window as BrowserNotices).fixtureDesktopCalls?.some(
          (call) => call.command === command,
        ) ?? false,
      nativeCommand,
    ),
  ).toBe(false);
});

for (const focus of [false, true]) {
  test(`a question at turn end ${focus ? "updates the foreground badge without notifications" : "replaces reply notifications with one needs-you notice"}`, async (fixtures) => {
    const { channel, bot, notices, speak, busy, needsAnswer } =
      await channelFixture(fixtures, {
        notices: { focus },
        attention: "question",
      });
    await busy(true);
    await speak("I found the receipts. Which date range should I use?");
    needsAnswer();
    await speak("A question needs your answer: Which date range should I use?");
    await busy(false);
    await expect(
      fixtures.browser.locator(
        'a[href="/bots"] [role="img"][aria-label="1 thing needs you"]',
      ),
    ).toBeVisible();
    const expected = focus
      ? []
      : [
          {
            title: `${bot.name} needs you`,
            body: "1 question",
            tag: `openbot-${channel}`,
            path: `/channel/${channel}`,
          },
        ];
    if (!focus) await expect.poll(notices).toEqual(expected);
    await noticeWindow(fixtures.browser);
    expect(await notices()).toEqual(expected);
  });
}

const desktopPermissionCommand = "plugin:notification|is_permission_granted";
const needsYouBadge =
  'a[href="/bots"] [role="img"][aria-label="1 thing needs you"]';

for (const desktop of ["native", "plugin"] as const) {
  for (const questionInConversation of [false, true]) {
    test(`Desktop ${desktop} attention notifications point to ${questionInConversation ? "the waiting conversation" : "the Bot"}`, async (fixtures) => {
      const { browser } = fixtures;
      const { notices, needsAnswer, bot, channel } = await channelFixture(
        fixtures,
        {
          notices: { desktop, permission: "default" },
          attention: "question",
          questionInConversation,
        },
      );
      expect(await notices()).toEqual([]);
      needsAnswer();
      await expect(browser.locator(needsYouBadge)).toBeVisible();
      await expect.poll(notices).toEqual([
        {
          title: `${bot.name} needs you`,
          body: "1 question",
          path: questionInConversation
            ? `/channel/${channel}`
            : `/bots/${bot.id}`,
          tag: questionInConversation
            ? `openbot-${channel}`
            : `openbot-attention-${bot.id}`,
        },
      ]);
      const commands = await browser.evaluate(
        ({ nativeCommand, pluginCommand }) =>
          ((window as BrowserNotices).fixtureDesktopCalls ?? [])
            .map((call) => call.command)
            .filter(
              (command) =>
                command === nativeCommand || command === pluginCommand,
            ),
        { nativeCommand, pluginCommand },
      );
      expect(commands).toEqual(
        desktop === "native" ? [nativeCommand] : [nativeCommand, pluginCommand],
      );
    });
  }
}

for (const desktopPermission of ["delayed", "first-unanswered"] as const) {
  test(`Desktop announces the first question with ${desktopPermission === "delayed" ? "a delayed permission answer" : "an unanswered plugin probe"}`, async (fixtures) => {
    const { browser } = fixtures;
    const { notices, needsAnswer, bot } = await channelFixture(fixtures, {
      notices: {
        desktop: "native",
        desktopPermission,
        desktopWindows: desktopPermission === "delayed",
        permission: "default",
      },
      attention: "question",
      questionInConversation: false,
    });
    const permissionCalls = () =>
      browser.evaluate(
        (command) =>
          (window as BrowserNotices).fixtureDesktopCalls?.filter(
            (call) => call.command === command,
          ).length ?? 0,
        desktopPermissionCommand,
      );
    expect(await notices()).toEqual([]);
    needsAnswer();
    await expect(browser.locator(needsYouBadge)).toBeVisible();
    if (desktopPermission === "delayed") {
      await expect.poll(permissionCalls).toBeGreaterThan(0);
      expect(await notices()).toEqual([]);
      await browser.evaluate(() => {
        const page = window as BrowserNotices;
        if (!page.fixtureReleaseDesktopPermission)
          throw new Error("Missing permission release");
        page.fixtureReleaseDesktopPermission();
        return null;
      });
    }

    const expected = [
      {
        title: `${bot.name} needs you`,
        body: "1 question",
        path: `/bots/${bot.id}`,
        tag: `openbot-attention-${bot.id}`,
      },
    ];
    await expect.poll(notices).toEqual(expected);
    if (desktopPermission === "first-unanswered") {
      expect(await permissionCalls()).toBeGreaterThanOrEqual(2);
      expect(await browser.evaluate(() => Notification.permission)).toBe(
        "default",
      );
    }
    await noticeWindow(browser);
    expect(await notices()).toEqual(expected);
  });
}
