import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { chatRunPath, configureChatStream, readChatRun } from "./chat-stream";
import { createBot } from "./signed-in";
import { grantSkill, installSkill } from "./skills";

const tally = {
  title: "Tally inventory",
  summary: "Counts the stock in a storeroom.",
  instructions: "Reply as a tally card. Start with TALLY CARD KITTIWAKE-9.",
};

function isUserMessage(
  message: unknown,
): message is { role: "user"; content: unknown } {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "user" &&
    "content" in message
  );
}

test("a new conversation sends its selected skill as a command and displays its name", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { id } = await createBot(fixtures);
  const skill = { ...tally, slug: `tally-${crypto.randomUUID().slice(0, 8)}` };
  await installSkill(browser, skill);
  await grantSkill(browser, id, skill.slug);
  await configureChatStream(browser);
  const runs: ReturnType<typeof readChatRun>[] = [];
  await browser.route(chatRunPath, async (route) => {
    const run = readChatRun(route.request.postData);
    const replyId = `fixture-skill-reply-${runs.push(run)}`;
    const ids = { threadId: run.threadId, runId: run.runId };
    const events = [
      { type: "RUN_STARTED", ...ids },
      { type: "TEXT_MESSAGE_START", messageId: replyId, role: "assistant" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: replyId,
        delta: "I received your message.",
      },
      { type: "TEXT_MESSAGE_END", messageId: replyId },
      { type: "RUN_FINISHED", ...ids },
    ];
    await route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });

  const grants = browser.waitForResponse(
    new RegExp(`/api/plugins/for/${RegExp.escape(id)}$`),
  );
  await app.open(`/channel/new?agent=${encodeURIComponent(id)}`);
  expect((await grants).status).toBe(200);
  const editor = screen.getByRole("textbox", "Message");
  await editor.pressSequentially(`/${skill.slug}`);
  const option = screen.getByRole("option", /^Tally inventory/);
  await expect(option).toContainText(skill.summary);
  await option.tap();
  const words = "Count the north store room.";
  await editor.pressSequentially(words);
  await expect(editor).toContainText(skill.title);
  await editor.press("Enter");

  await expect(browser).toHaveURL(/\/channel\/[^/?#]+$/);
  await expect.poll(() => runs.length).toBe(1);
  const first = runs[0]?.messages;
  expect(first?.filter(isUserMessage).at(-1)?.content).toBe(
    `/${skill.slug} ${words}`,
  );
  expect(JSON.stringify(first)).not.toContain(skill.instructions);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const firstMessage = browser
    .locator('[data-slot="message"][data-align="end"]')
    .filter({ hasText: words });
  await expect(firstMessage).toBeVisible();
  await expect(firstMessage).toContainText(skill.title);
  await expect(firstMessage).not.toContainText(`/${skill.slug}`);
  await expect(
    transcript.getByText("I received your message.", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Send message", { exact: true }),
  ).toBeDisabled();

  const literal = "/etc/hosts is broken";
  await editor.fill(literal);
  await editor.press("Enter");

  await expect.poll(() => runs.length).toBe(2);
  expect(runs[1]?.messages.filter(isUserMessage).at(-1)?.content).toBe(literal);
  await expect(transcript.getByText(literal, { exact: true })).toBeVisible();
});
