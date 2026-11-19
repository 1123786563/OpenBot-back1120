import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { notRun } from "../../shared/approval-outcomes";
import {
  chatEventStream,
  chatRunPath,
  configureChatStream,
  readChatRun,
} from "./chat-stream";
import { createConversation, readThreadId } from "./conversations";
import { createBot } from "./signed-in";

const complete =
  "The form is complete. The customer name, telephone and size are all present.";
const outOfOrder = "The telephone and size are present.";
const recover = "I filled in the form.";
const notExecuted = notRun(
  "no result came back for this call before the conversation moved on.",
);

const calls = [
  { field: "Customer name", value: "Gina" },
  { field: "Telephone", value: "555-0101" },
  { field: "Size", value: "Small" },
].map((args, index) => ({
  id: `unfinished-call-${index + 1}`,
  type: "function",
  function: { name: "list_bots", arguments: JSON.stringify(args) },
}));
const [firstCall] = calls;

for (const breakAt of ["reply", "tools"] as const) {
  test(`the conversation recovers when the gateway breaks a ${breakAt} stream after a browser tool`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(
      browser,
      bot.id,
      "Recover interrupted stream",
    );
    const thread = await readThreadId(browser, channel);
    const inputs: unknown[][] = [];
    let archive: object[] = [];
    await configureChatStream(browser, [], async () => archive);
    await browser.route(chatRunPath, (route) => {
      const { threadId, runId, messages } = readChatRun(route.request.postData);
      expect(threadId).toBe(thread);
      inputs.push(messages);
      const start = { type: "RUN_STARTED", threadId, runId };
      const finish = { type: "RUN_FINISHED", threadId, runId };

      if (inputs.length === 1) {
        return route.fulfill(
          chatEventStream([
            start,
            {
              type: "TOOL_CALL_START",
              toolCallId: "list-bots",
              toolCallName: "list_bots",
              parentMessageId: "request-bots",
            },
            { type: "TOOL_CALL_ARGS", toolCallId: "list-bots", delta: "{}" },
            { type: "TOOL_CALL_END", toolCallId: "list-bots" },
            finish,
          ]),
        );
      }

      if (inputs.length === 2 && breakAt === "reply") {
        const messageId = "interrupted-reply";
        archive = [
          ...(messages as object[]),
          { id: messageId, role: "assistant", content: complete },
        ];
        return route.fulfill(
          chatEventStream([
            start,
            { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
            { type: "TEXT_MESSAGE_CONTENT", messageId, delta: outOfOrder },
            { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId,
              delta: complete.slice(0, 20),
            },
            { type: "TEXT_MESSAGE_END", messageId },
            finish,
          ]),
        );
      }

      if (inputs.length === 2) {
        const messageId = "interrupted-tools";
        archive = [
          ...(messages as object[]),
          { id: messageId, role: "assistant", toolCalls: calls },
        ];
        const args = firstCall.function.arguments;
        return route.fulfill(
          chatEventStream([
            start,
            {
              type: "TOOL_CALL_START",
              toolCallId: firstCall.id,
              toolCallName: firstCall.function.name,
              parentMessageId: messageId,
            },
            {
              type: "TOOL_CALL_ARGS",
              toolCallId: firstCall.id,
              delta: args.slice(0, 12),
            },
            { type: "TOOL_CALL_END", toolCallId: firstCall.id },
            {
              type: "TOOL_CALL_ARGS",
              toolCallId: firstCall.id,
              delta: args.slice(12),
            },
            finish,
          ]),
        );
      }

      if (breakAt !== "tools" || inputs.length !== 3)
        throw new Error(`Unexpected repair run ${inputs.length}`);
      return route.fulfill(
        chatEventStream([
          start,
          {
            type: "TEXT_MESSAGE_START",
            messageId: "repair-reply",
            role: "assistant",
          },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "repair-reply",
            delta: recover,
          },
          { type: "TEXT_MESSAGE_END", messageId: "repair-reply" },
          finish,
        ]),
      );
    });

    await app.open(`/channel/${channel}`);
    const question = "Read the form and tell me what it shows.";
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill(question);
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      transcript.getByText(breakAt === "reply" ? complete : recover, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(browser.locator('[data-testid="composer-stop"]')).toHaveCount(
      0,
    );
    await expect(
      browser.locator('[data-testid="transcript-stopped"]'),
    ).toHaveCount(0);
    expect(inputs[0]?.at(-1)).toMatchObject({
      role: "user",
      content: question,
    });
    expect(inputs[1]?.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "list-bots",
    });
    expect(JSON.stringify(inputs[1]?.at(-1))).toContain(bot.name);

    if (breakAt === "reply") {
      await expect(
        transcript.getByText(outOfOrder, { exact: true }),
      ).toHaveCount(0);
      await expect(transcript.getByText(complete, { exact: true })).toHaveCount(
        1,
      );
      expect(inputs).toHaveLength(2);
    } else {
      expect(inputs).toHaveLength(3);
      const resumed = inputs[2] ?? [];
      const requested = resumed.find(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "id" in message &&
          message.id === "interrupted-tools",
      );
      expect(requested).toMatchObject({ role: "assistant", toolCalls: calls });
      for (const { id } of calls) {
        const result = resumed.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "toolCallId" in message &&
            message.toolCallId === id,
        );
        expect(result).toEqual([
          expect.objectContaining({
            role: "tool",
            toolCallId: id,
            content: notExecuted,
          }),
        ]);
      }
    }
  });
}
