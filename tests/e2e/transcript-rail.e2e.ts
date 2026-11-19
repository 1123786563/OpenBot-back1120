import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

function history(turns: number) {
  return Array.from({ length: turns }, (_, index) => [
    {
      id: `question-${index + 1}`,
      role: "user",
      content: `Question ${index + 1}?`,
    },
    {
      id: `reply-${index + 1}`,
      role: "assistant",
      content: `Reply ${index + 1}.`,
    },
  ]).flat();
}

test("the turn rail opens an older page and marks the conversation turn being read", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await browser.setViewport({ width: 1440, height: 900 });
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(browser, history(50));
  await app.open(`/channel/${channel}`);

  const rail = screen.getByRole("navigation", "Turns", { exact: true });
  const marks = rail.getByRole("button");
  const newest = rail.getByRole("button", "Question 50?", { exact: true });
  const oldest = rail.getByRole("button", "Question 1?", { exact: true });
  const messages = screen.getByRole("region", "Messages", { exact: true });
  const question = messages.getByText("Question 1?", { exact: true });
  await expect(rail).toBeVisible();
  await expect(marks).toHaveCount(50);
  await expect(newest).toHaveAttribute("aria-current", "true");
  await expect(question).toHaveCount(0);
  await expect(messages).toHaveAttribute("data-following", "true");

  await oldest.tap();
  await expect(question).toBeVisible();
  await expect(messages).toHaveAttribute("data-following", "false");
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const viewport = document.querySelector(
          '[data-slot="message-scroller-viewport"]',
        );
        const target = document.querySelector('[data-message-id="question-1"]');
        if (!viewport || !target) return false;
        const view = viewport.getBoundingClientRect();
        const row = target.getBoundingClientRect();
        return row.top >= view.top - 4 && row.bottom <= view.bottom + 4;
      }),
    )
    .toBe(true);
  const current = browser.locator(
    '[data-slot="rail-mark"][aria-current="true"]',
  );
  await expect(current).toHaveCount(1);
  await expect(current).not.toHaveAttribute("aria-label", "Question 50?");
});

test("the latest mark keeps following when the turn is already at the end", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await browser.setViewport({ width: 1440, height: 900 });
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(browser, history(3));
  await app.open(`/channel/${channel}`);

  const rail = screen.getByRole("navigation", "Turns", { exact: true });
  const messages = screen.getByRole("region", "Messages", { exact: true });
  await expect(rail.getByRole("button")).toHaveCount(3);
  await expect(
    rail.getByRole("button", "Question 1?", { exact: true }),
  ).toBeVisible();
  await expect(
    rail.getByRole("button", "Question 2?", { exact: true }),
  ).toBeVisible();
  const latest = rail.getByRole("button", "Question 3?", { exact: true });
  await expect(latest).toHaveAttribute("aria-current", "true");
  await latest.tap();
  await expect(messages).toHaveAttribute("data-following", "true");
  await expect(latest).toHaveAttribute("aria-current", "true");
});

test("the turn rail stays clear of the transcript across its width threshold", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await browser.setViewport({ width: 1440, height: 800 });
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  let rows = history(1);
  await configureChatStream(browser, [], async () => rows);
  await app.open(`/channel/${channel}`);

  const messages = screen.getByRole("region", "Messages", { exact: true });
  const rail = screen.getByRole("navigation", "Turns", { exact: true });
  await expect(messages.getByText("Reply 1.", { exact: true })).toBeVisible();
  await expect(rail).toHaveCount(0);
  rows = history(3);
  await browser.reload();
  await expect(messages.getByText("Reply 3.", { exact: true })).toBeVisible();
  await expect(rail).toBeVisible();
  const outerWidth = await browser.evaluate(() => {
    const scroller = document.querySelector('[data-slot="message-scroller"]');
    if (!scroller) throw new Error("Conversation scroller is missing");
    return window.innerWidth - scroller.getBoundingClientRect().width;
  });

  const measure = () =>
    browser.evaluate(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const rail = document.querySelector('nav[aria-label="Turns"]');
      const content = document.querySelector(
        '[data-slot="message-scroller-content"]',
      );
      if (!rail || !content)
        throw new Error("Rail or message content is missing");
      if (getComputedStyle(rail).display === "none")
        return { shown: false, gap: null };
      const marks = [...rail.querySelectorAll('[data-slot="rail-mark"]')];
      const railRight = Math.max(
        ...marks.map((mark) => mark.getBoundingClientRect().right),
      );
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      const textLefts: number[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0) textLefts.push(rect.left);
        }
      }
      if (!marks.length || !textLefts.length)
        throw new Error("The rail or transcript has no rendered content");
      return {
        shown: true,
        gap: Math.round(Math.min(...textLefts) - railRight),
      };
    });

  const seen: number[] = [];
  const crowded: { width: number; gap: number }[] = [];
  const widths = Array.from({ length: 38 }, (_, index) => 740 + index * 8);
  for (const width of [...widths, 888, 896, 904, 1040, 1280]) {
    await browser.setViewport({
      width: Math.round(width + outerWidth),
      height: 800,
    });
    const { shown, gap } = await measure();
    if (!shown || gap === null) continue;
    seen.push(width);
    if (gap < 24) crowded.push({ width, gap });
  }
  expect(seen).toContain(1280);
  expect(seen).not.toContain(740);
  expect(crowded).toEqual([]);
});
