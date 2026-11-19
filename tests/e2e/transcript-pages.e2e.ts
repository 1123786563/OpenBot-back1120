import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";
import { stageChatRun } from "./staged-chat-stream";

function history(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${prefix} message ${index + 1}.\n\nThis paragraph gives each history row enough height to measure its position clearly.`,
  }));
}

test("scrolling to the start of drawn history opens one older page without moving the reading position", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await browser.setViewport({ width: 1200, height: 680 });
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(browser, history("Archive", 100));
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId }) => [{ type: "RUN_STARTED", runId, threadId }],
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );
  await app.open(`/channel/${channel}`);
  const messages = screen.getByRole("region", "Messages", { exact: true });
  const rows = browser.locator(
    '[data-slot="message-scroller-content"] > [data-message-id]',
  );
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toHaveAttribute("data-message-id", "Archive-81");
  await expect(rows.last()).toHaveAttribute("data-message-id", "Archive-100");
  const pointer = await browser.evaluate(() => {
    const viewport = document.querySelector(
      '[data-slot="message-scroller-viewport"]',
    );
    if (!viewport) throw new Error("Messages viewport is missing");
    const rect = viewport.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await browser.mouse.move(pointer.x, pointer.y);
  await browser.mouse.wheel(0, -32);
  await expect(messages).toHaveAttribute("data-following", "false");
  await expect(rows).toHaveCount(20);

  const originalOffset = await browser.evaluate(() => {
    const viewport = document.querySelector(
      '[data-slot="message-scroller-viewport"]',
    );
    const anchor = document.querySelector<HTMLElement>(
      '[data-message-id="Archive-81"]',
    );
    if (!viewport || !anchor)
      throw new Error("The first drawn message is missing");
    anchor.dataset.e2eReadingAnchor = "true";
    const observer = new MutationObserver(() => {
      const earlier = [
        ...viewport.querySelectorAll<HTMLElement>("[data-message-id]"),
      ].filter((row) =>
        /^Archive-(6[1-9]|7[0-9]|80)$/.test(row.dataset.messageId ?? ""),
      );
      if (earlier.length !== 20) return;
      viewport.setAttribute(
        "data-e2e-prepended-without-animation",
        String(
          earlier.every((row) => {
            const arrival = row.querySelector<HTMLElement>(
              '[data-slot="message-arriving"]',
            );
            return (
              arrival !== null &&
              arrival.style.opacity !== "0" &&
              !row.classList.contains("history-arrive")
            );
          }),
        ),
      );
      observer.disconnect();
    });
    observer.observe(viewport, { childList: true, subtree: true });
    viewport.scrollTo({ top: 0, behavior: "instant" });
    return (
      anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    );
  });

  await expect(rows).toHaveCount(40);
  await expect(rows.first()).toHaveAttribute("data-message-id", "Archive-61");
  await expect(messages).toHaveAttribute(
    "data-e2e-prepended-without-animation",
    "true",
  );
  await expect
    .poll(() =>
      browser.evaluate((offset) => {
        const viewport = document.querySelector(
          '[data-slot="message-scroller-viewport"]',
        );
        const anchor = viewport?.querySelector(
          '[data-message-id="Archive-81"][data-e2e-reading-anchor]',
        );
        if (!viewport || !anchor)
          throw new Error("The reading anchor was remounted");
        return Math.abs(
          anchor.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            offset,
        );
      }, originalOffset),
    )
    .toBeLessThan(2);
  await expect(messages).toHaveAttribute("data-following", "false");

  const question = "A new question after paging.";
  await screen.getByRole("textbox", "Message", { exact: true }).fill(question);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect(rows).toHaveCount(41);
  await expect(rows.last()).toContainText(question);
  await expect(rows.last()).toHaveAttribute("data-scroll-anchor", "true");
  await expect(messages).toHaveAttribute("data-following", "true");
  stream.finish();
  await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
});

test("switching conversations resets the history window and a short conversation draws every row", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await browser.setViewport({ width: 1200, height: 680 });
  const bot = await createBot(fixtures);
  const source = await createConversation(
    browser,
    bot.id,
    "Original conversation",
  );
  const other = await createConversation(browser, bot.id, "Another archive");
  const short = await createConversation(browser, bot.id, "Short history");
  let archive = history("Original", 50);
  await configureChatStream(browser, [], async () => archive);
  await app.open(`/channel/${source}`);
  const rows = browser.locator(
    '[data-slot="message-scroller-content"] > [data-message-id]',
  );
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toHaveAttribute("data-message-id", "Original-31");
  await browser.evaluate(() => {
    const viewport = document.querySelector(
      '[data-slot="message-scroller-viewport"]',
    );
    if (!viewport) throw new Error("Messages viewport is missing");
    viewport.scrollTo({ top: 0, behavior: "instant" });
    return null;
  });
  await expect(rows).toHaveCount(40);

  archive = history("Switched", 50);
  await screen.getByRole("link", /Another archive/).tap();
  await expect(browser).toHaveURL(
    new RegExp(`/channel/${RegExp.escape(other)}$`),
  );
  await expect(rows.first()).toHaveAttribute("data-message-id", "Switched-31");
  await expect(rows).toHaveCount(20);

  archive = history("Short", 5);
  await screen.getByRole("link", /Short history/).tap();
  await expect(browser).toHaveURL(
    new RegExp(`/channel/${RegExp.escape(short)}$`),
  );
  await expect(rows.first()).toHaveAttribute("data-message-id", "Short-1");
  await expect(rows.last()).toHaveAttribute("data-message-id", "Short-5");
  await expect(rows).toHaveCount(5);
});
