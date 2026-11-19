import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { chatEventStream, chatRunPath, readChatRun } from "./chat-stream";
import {
  computerConversation,
  computerStep,
  type Fixtures,
} from "./computer-fixtures";

const question = "Help me review the order form.";
const reason = "Check whether the order shows one notebook.";
const nextStep = "Thanks. Next I will review the shipping options.";
const continuedReply = "I will review the order now.";
const callId = "order-help";
const toolName = "computer_request_help";
const requestId = "help-handoff";
const pageSnapshot = {
  ok: true,
  snapshotId: 7,
  url: "https://forms.example.test/order",
  title: "Order",
  elements: [{ ref: "e1", role: "button", name: "Review order" }],
};

function textReply(messageId: string, text: string) {
  return [
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
    { type: "TEXT_MESSAGE_END", messageId },
  ];
}

function isHelpAnswer(message: unknown): message is { content: string } {
  return (
    !!message &&
    typeof message === "object" &&
    "role" in message &&
    message.role === "tool" &&
    "toolCallId" in message &&
    message.toolCallId === callId &&
    "content" in message &&
    typeof message.content === "string"
  );
}

async function openHandoff(
  fixtures: Fixtures,
  mode: "reply" | "silent" | "leave",
) {
  const { browser, screen } = fixtures;
  let stored: object[] = [];
  const connected = browser.waitForResponse(
    /\/api\/copilotkit\/agent\/[^/]+\/connect$/,
  );
  const { bot, path, state } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { search: "", terminal: true, readHistory: () => stored },
  );
  const [call] = computerStep(callId, toolName, { reason }, {});
  const snapshots: string[] = [];
  await browser.route(
    new RegExp(`/api/computers/${RegExp.escape(bot.id)}/snapshot$`),
    (route) => {
      snapshots.push(route.request.method);
      return route.fulfill({ json: pageSnapshot });
    },
  );

  const runs: unknown[][] = [];
  const releaseReply = Promise.withResolvers<void>();
  await browser.route(chatRunPath, async (route) => {
    const { runId, threadId, messages } = readChatRun(
      route.request.postData ?? undefined,
    );
    const before = { type: "RUN_STARTED", runId, threadId };
    const after = { type: "RUN_FINISHED", runId, threadId };
    runs.push(messages);
    stored = messages.filter(
      (message): message is object => !!message && typeof message === "object",
    );
    if (runs.length === 1) {
      stored = [...stored, call];
      return route.fulfill(
        chatEventStream([
          before,
          {
            type: "TOOL_CALL_START",
            toolCallId: callId,
            toolCallName: toolName,
            parentMessageId: call.id,
          },
          {
            type: "TOOL_CALL_ARGS",
            toolCallId: callId,
            delta: JSON.stringify({ reason }),
          },
          { type: "TOOL_CALL_END", toolCallId: callId },
          after,
        ]),
      );
    }
    if (runs.length === 2 && mode === "leave") await releaseReply.promise;
    const text =
      runs.length > 2 ? continuedReply : mode === "silent" ? "" : nextStep;
    const id = `reply-${runId}`;
    if (text) stored = [...stored, { id, role: "assistant", content: text }];
    return route.fulfill(
      chatEventStream([before, ...(text ? textReply(id, text) : []), after]),
    );
  });

  const card = browser.locator(`[data-help-request="${callId}"]`);
  const composer = screen.getByRole("textbox", "Message", { exact: true });
  const send = screen.getByRole("button", "Send message", { exact: true });
  await connected;
  await composer.fill(question);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    screen
      .getByRole("region", "Messages", { exact: true })
      .getByText(question, { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => state.handoffs)
    .toEqual([{ action: "request", body: { reason, toolCallId: callId } }]);
  await expect(card).toContainText(reason);
  return { card, path, runs, snapshots, state, releaseReply };
}

for (const mode of ["reply", "silent", "leave"] as const) {
  test(`Browser Handoff resumes the original tool call with a ${mode === "silent" ? "silent continuation" : mode === "leave" ? "reply after leaving the conversation" : "spoken continuation"}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const { card, path, runs, snapshots, state, releaseReply } =
      await openHandoff(fixtures, mode);
    try {
      await card.getByRole("button", "Take control", { exact: true }).click();
      const dialog = screen.getByRole("dialog", "The Bot's screen", {
        exact: true,
      });
      await expect(
        dialog.getByRole("button", "Hand back", { exact: true }),
      ).toBeEnabled();
      await browser.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      if (mode === "leave") {
        await screen.getByRole("link", "Bots", { exact: true }).click();
        await expect(browser).toHaveURL(/\/bots(?:[/?#]|$)/);
        await expect(card).toHaveCount(0);
        await browser.back();
        await expect(browser).toHaveURL(new RegExp(RegExp.escape(path)));
        await expect(
          card.getByRole("button", "Hand back", { exact: true }),
        ).toBeEnabled();
      }

      const pane = screen.getByRole("region", "Computer sidebar", {
        exact: true,
      });
      await pane.getByRole("button", "Hand back", { exact: true }).click();
      await expect.poll(() => runs.length).toBe(2);
      expect(snapshots).toEqual(["POST"]);
      expect(state.handoffs).toEqual([
        { action: "request", body: { reason, toolCallId: callId } },
        { action: "take", body: { requestId } },
        { action: "release", body: { requestId } },
      ]);
      const answer = runs[1]?.find(isHelpAnswer);
      if (!answer)
        throw new Error(
          "The continuation did not carry the completed tool result",
        );
      const result: unknown = JSON.parse(answer.content);
      if (!result || typeof result !== "object")
        throw new Error("The continuation result was not an object");
      expect(Object.keys(result)[0]).toBe("result");
      expect(result).toEqual({
        ...pageSnapshot,
        requestId,
        handoffStatus: "completed",
        result: `A person took control to do what you asked: "${reason}" They have finished and handed control back to you, and the snapshot here is the page as they left it. Carry on with the task now. Start your reply by telling the person, in one short sentence, what you are doing next; if nothing is left to do, tell them it is done.`,
      });
      await expect(card).toContainText("Taken over and handed back");
      await expect(card).toContainText(reason);
      const carryOn = card.getByRole("button", "Carry on", { exact: true });
      const resume = screen.getByRole("button", "Resume task", { exact: true });
      const paused = screen.getByText(/A browser task is paused/);
      if (mode === "leave") {
        await expect(card).toContainText("The Bot is carrying on.");
        await expect(resume).toHaveCount(0);
        await expect(paused).toHaveCount(0);
        releaseReply.resolve();
      }

      const transcript = screen.getByRole("region", "Messages", {
        exact: true,
      });
      if (mode === "silent") {
        await expect(card).toContainText(
          "The Bot stopped here without saying what it does next.",
        );
        await carryOn.click();
        await expect(
          transcript.getByText(continuedReply, { exact: true }),
        ).toBeVisible();
        expect(runs[2]?.at(-1)).toEqual(
          expect.objectContaining({
            role: "user",
            content: "Please carry on.",
          }),
        );
        expect(runs).toHaveLength(3);
      } else {
        await expect(
          transcript.getByText(nextStep, { exact: true }),
        ).toBeVisible();
        await expect(carryOn).toHaveCount(0);
        expect(runs).toHaveLength(2);
      }
      await expect(resume).toHaveCount(0);
      await expect(paused).toHaveCount(0);
    } finally {
      releaseReply.resolve();
    }
  });
}
