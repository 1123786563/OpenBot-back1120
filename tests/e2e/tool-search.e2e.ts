import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { chatRunPath, configureChatStream, readChatRun } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const SEARCH_ANSWER = [
  "Tools found: mcp__composio-gmail__GMAIL_SEND_EMAIL, mcp__composio-gmail__GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  'You can call them from your next step, for "send an email". What each one does, in its app\'s words:',
  "<untrusted>- mcp__composio-gmail__GMAIL_SEND_EMAIL: Sends an email.</untrusted>",
].join("\n");

test("a streamed tool search shows the Gmail Actions by their readable names", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { id } = await createBot(fixtures);
  const channel = await createConversation(browser, id);
  await configureChatStream(browser);
  let requests = 0;
  await browser.route(chatRunPath, (route) => {
    requests += 1;
    const { runId, threadId } = readChatRun(route.request.postData);
    const toolCallId = "fixture-search-tools";
    const events = [
      { type: "RUN_STARTED", runId, threadId },
      {
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: "search_tools",
        parentMessageId: "fixture-search-step",
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId,
        delta: JSON.stringify({ query: "send an email" }),
      },
      { type: "TOOL_CALL_END", toolCallId },
      {
        type: "TOOL_CALL_RESULT",
        toolCallId,
        messageId: "fixture-search-answer",
        role: "tool",
        content: SEARCH_ANSWER,
      },
      { type: "RUN_FINISHED", runId, threadId },
    ];
    return route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });
  await app.open(`/channel/${channel}`);
  const prompt = "List the Gmail actions for sending and reading email.";
  await screen.getByRole("textbox", "Message", { exact: true }).fill(prompt);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(transcript.getByText(prompt, { exact: true })).toBeVisible();
  const disclosure = transcript.getByText("Looked for a tool", { exact: true });
  await expect(disclosure).toBeVisible();
  await disclosure.tap();
  await expect(
    transcript.getByText("Send email on Gmail", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("Fetch thread messages on Gmail", { exact: true }),
  ).toBeVisible();
  await expect(transcript).not.toContainText(
    /mcp__|GMAIL_|composio|Tools found/,
  );
  expect(requests).toBe(1);
});
