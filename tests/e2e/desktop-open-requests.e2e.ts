import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

function openFromShell(browser: Browser, path: string, fallback: string) {
  return browser.evaluate(
    ({ path, fallback }) => {
      const event = new CustomEvent("openbot:open", {
        detail: { path },
        cancelable: true,
      });
      if (window.dispatchEvent(event)) window.location.assign(fallback);
      return event.defaultPrevented;
    },
    { path, fallback },
  );
}

test("a Desktop notification uses the existing app document to open a conversation", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const id = await createConversation(browser, bot.id, "Notice destination");
  await configureChatStream(browser);
  await app.open("/bots");
  await expect(
    screen.getByRole("heading", "Bots", { exact: true }),
  ).toBeVisible();
  const page = await browser.evaluate(() => {
    const marker = crypto.randomUUID();
    document.documentElement.dataset.desktopNoticeDocument = marker;
    return { marker, origin: window.location.origin };
  });
  const path = `/channel/${id}`;
  const handled = await openFromShell(browser, path, page.origin + path);
  expect(handled).toBe(true);
  await expect(browser).toHaveURL(page.origin + path);
  await expect(
    screen.getByRole("region", "Messages", { exact: true }),
  ).toBeVisible();
  await expect(browser.locator("html")).toHaveAttribute(
    "data-desktop-notice-document",
    page.marker,
  );
});

test("a Desktop notification loads the destination if the document cannot handle the event", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const id = await createConversation(browser, bot.id, "Notice destination");
  await configureChatStream(browser);
  await app.open("/bots");
  const origin = new URL(await browser.url()).origin;
  await browser.goto("about:blank");
  const path = `/channel/${id}`;
  await openFromShell(browser, path, origin + path);
  await expect(browser).toHaveURL(origin + path);
  await expect(
    screen.getByRole("region", "Messages", { exact: true }),
  ).toBeVisible();
});

test("the Desktop routing listener ignores external URLs and non-string paths", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/bots");
  await expect(
    screen.getByRole("heading", "Bots", { exact: true }),
  ).toBeVisible();
  const outcomes = await browser.evaluate(() =>
    ["//example.com/x", "https://example.com/", 7].map((path) => {
      const event = new CustomEvent("openbot:open", {
        detail: { path },
        cancelable: true,
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  expect(outcomes).toEqual([false, false, false]);
  await expect(browser).toHaveURL(/\/bots$/);
});
