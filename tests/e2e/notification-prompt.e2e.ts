import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { type BrowserNotices, captureNotices } from "./browser-notices";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

type Fixtures = Parameters<typeof createBot>[0];
const offer = "[data-notify-prompt]";
const message = "Sort my receipts by date.";
const offerKey = "openbot-notify-prompt-answered";
const visits = "notification-permission-requests";

async function conversationWithPermission(
  fixtures: Fixtures,
  permission: NotificationPermission | "unsupported",
  answer: NotificationPermission = "granted",
) {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id, "March receipts");
  await browser.addInitScript(
    ({ permission, answer, visits }) => {
      let current = permission;
      const notification =
        permission === "unsupported"
          ? undefined
          : {
              get permission() {
                return current;
              },
              async requestPermission() {
                const asked = Number(sessionStorage.getItem(visits) ?? 0);
                sessionStorage.setItem(visits, String(asked + 1));
                current = answer;
                return answer;
              },
            };
      Object.defineProperty(window, "Notification", {
        value: notification,
        configurable: true,
      });
    },
    { permission, answer, visits },
  );

  await configureChatStream(browser, [
    { id: "task-request", role: "user", content: message },
  ]);
  await app.open(`/channel/${channel}`);
  await expect(
    screen
      .getByRole("region", "Messages", { exact: true })
      .getByText(message, { exact: true }),
  ).toBeVisible();
}

function recordedPermission(browser: Browser) {
  return browser.evaluate(
    ({ offerKey, visits }) => ({
      requests: Number(sessionStorage.getItem(visits) ?? 0),
      answered: localStorage.getItem(offerKey) !== null,
    }),
    { offerKey, visits },
  );
}

for (const permission of ["granted", "denied", "unsupported"] as const) {
  test(`the conversation does not offer notifications when permission is ${permission}`, async (fixtures) => {
    const { browser } = fixtures;
    await conversationWithPermission(fixtures, permission);
    await expect(browser.locator(offer)).toHaveCount(0);
    expect(await recordedPermission(browser)).toEqual({
      requests: 0,
      answered: false,
    });
  });
}

for (const scenario of [
  { label: "Not now", answer: "default", requests: 0, outcome: "skipping" },
  {
    label: "Enable notifications",
    answer: "granted",
    requests: 1,
    outcome: "granting permission",
  },
  {
    label: "Enable notifications",
    answer: "default",
    requests: 1,
    outcome: "closing the system prompt without an answer",
  },
] as const) {
  test(`the conversation remembers ${scenario.outcome} across a reload`, async (fixtures) => {
    const { browser, screen } = fixtures;
    await conversationWithPermission(fixtures, "default", scenario.answer);
    const prompt = browser.locator(offer);
    await expect(prompt).toContainText(
      "Get notified when your Bot finishes or needs your approval.",
    );
    await expect(
      prompt.getByRole("button", "Not now", { exact: true }),
    ).toBeVisible();
    await expect(
      prompt.getByRole("button", "Enable notifications", { exact: true }),
    ).toBeVisible();
    expect(await recordedPermission(browser)).toEqual({
      requests: 0,
      answered: false,
    });
    await prompt.getByRole("button", scenario.label, { exact: true }).tap();
    await expect(prompt).toHaveCount(0);
    const remembered = { requests: scenario.requests, answered: true };
    expect(await recordedPermission(browser)).toEqual(remembered);

    await browser.reload();
    await expect(
      screen
        .getByRole("region", "Messages", { exact: true })
        .getByText(message, { exact: true }),
    ).toBeVisible();
    await expect(prompt).toHaveCount(0);
    expect(await recordedPermission(browser)).toEqual(remembered);
  });
}

test("an app inside the Desktop shell never offers browser permission, even on a fresh origin", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id, "March receipts");
  await captureNotices(browser, {
    desktop: "native",
    permission: "default",
    desktopPermission: "delayed",
  });
  await configureChatStream(browser, [
    { id: "task-request", role: "user", content: message },
  ]);
  const path = `/channel/${channel}`;
  const request = screen
    .getByRole("region", "Messages", { exact: true })
    .getByText(message, { exact: true });
  const prompt = browser.locator(offer);
  const expectCheckingWithoutOffer = async () => {
    await expect(request).toBeVisible();
    await expect
      .poll(() =>
        browser.evaluate(
          () =>
            (window as BrowserNotices).fixtureDesktopCalls?.some(
              ({ command }) =>
                command === "plugin:notification|is_permission_granted",
            ) ?? false,
        ),
      )
      .toBe(true);
    expect(await browser.evaluate(() => Notification.permission)).toBe(
      "default",
    );
    await expect(prompt).toHaveCount(0);
    expect(await recordedPermission(browser)).toEqual({
      requests: 0,
      answered: false,
    });
    await browser.evaluate(() => {
      const page = window as BrowserNotices;
      if (!page.fixtureReleaseDesktopPermission)
        throw new Error("Missing permission release");
      page.fixtureReleaseDesktopPermission();
      return null;
    });
    await expect
      .poll(() => browser.evaluate(() => Notification.permission))
      .toBe("granted");
    await expect(prompt).toHaveCount(0);
  };
  await app.open(path);
  await expectCheckingWithoutOffer();

  await browser.locator('a[href="/bots"]').first().tap();
  await expect(
    screen.getByRole("heading", "Bots", { exact: true }),
  ).toBeVisible();
  await browser.back();
  await expect(request).toBeVisible();
  await expect(prompt).toHaveCount(0);
  expect(await recordedPermission(browser)).toEqual({
    requests: 0,
    answered: false,
  });

  const origin = new URL(await browser.url());
  origin.hostname = origin.hostname === "localhost" ? "127.0.0.1" : "localhost";
  await browser.goto(origin.href);
  await expectCheckingWithoutOffer();
});
