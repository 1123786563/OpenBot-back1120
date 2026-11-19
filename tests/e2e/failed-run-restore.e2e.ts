import { test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import {
  chatEventStream,
  chatRunPath,
  configureChatStream,
  readChatRun,
} from "./chat-stream";
import { createConversation, readThreadId } from "./conversations";
import { createBot } from "./signed-in";
import { stageChatRun } from "./staged-chat-stream";

const question = "Summarise my inbox.";
const failure = "invalid x-api-key";
const answer = "Here is your inbox summary.";
const stoppedSelector = '[data-testid="transcript-stopped"]';

const textEvents = (messageId: string, delta: string) => [
  { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId, delta },
  { type: "TEXT_MESSAGE_END", messageId },
];

async function send(screen: TestFixtures["screen"], text: string) {
  await screen.getByRole("textbox", "Message", { exact: true }).fill(text);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
}

for (const action of ["reload", "return", "retry"] as const) {
  test(`the transcript restores only the last unresolved failure after ${action}`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(browser, bot.id, "Inbox summary");
    const other =
      action === "return"
        ? await createConversation(browser, bot.id, "Different conversation")
        : null;
    const thread = await readThreadId(browser, channel);
    const events: object[] = [];
    let archive: object[] = [];
    let runs = 0;
    await configureChatStream(browser, []);
    await browser.route(
      new RegExp(
        `/api/copilotkit/threads/${RegExp.escape(thread)}/messages\\?`,
      ),
      (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ messages: archive }),
        }),
    );
    await browser.route(
      /\/api\/copilotkit\/agent\/[^/]+\/connect$/,
      (route) => {
        const { threadId } = readChatRun(route.request.postData);
        return route.fulfill(
          chatEventStream(threadId === thread ? events : []),
        );
      },
    );
    await browser.route(chatRunPath, (route) => {
      const { threadId, runId, messages } = readChatRun(route.request.postData);
      expect(threadId).toBe(thread);
      runs++;
      const start = { type: "RUN_STARTED", threadId, runId };
      archive = messages.filter(
        (message): message is { role: "user" } =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          message.role === "user",
      );
      const result =
        runs === 1
          ? [
              start,
              { type: "RUN_ERROR", message: failure, code: "agent_error" },
            ]
          : [
              start,
              ...textEvents("new-reply", answer),
              { type: "RUN_FINISHED", threadId, runId },
            ];
      if (runs === 2)
        archive.push({ id: "new-reply", role: "assistant", content: answer });
      events.push(...result);
      return route.fulfill(chatEventStream(result));
    });

    const path = `/channel/${channel}`;
    await app.open(path);
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    const notice = browser.locator(stoppedSelector);
    const stop = browser.locator('[data-testid="composer-stop"]');
    await send(screen, question);
    await expect(notice).toHaveText(failure);
    const liveMarkup = await browser.evaluate(
      (selector) => document.querySelector(selector)?.outerHTML ?? null,
      stoppedSelector,
    );

    if (action === "return") {
      const different = browser.locator(
        `[data-sidebar="content"] a[href="/channel/${other}"]`,
      );
      await different.tap();
      await expect(browser).toHaveURL(`/channel/${other}`);
      await expect(
        transcript.getByRole("heading", bot.name, { exact: true }),
      ).toBeVisible();
      await expect(notice).toHaveCount(0);
      await browser.locator(`[data-sidebar="content"] a[href="${path}"]`).tap();
      await expect(browser).toHaveURL(path);
    } else {
      if (action === "retry") {
        await send(screen, "Try again.");
        await expect(
          transcript.getByText(answer, { exact: true }),
        ).toBeVisible();
        await expect(notice).toHaveCount(0);
      }
      await browser.reload();
    }

    await expect(transcript.getByText(question, { exact: true })).toBeVisible();
    await expect(stop).toHaveCount(0);
    if (action === "retry") {
      await expect(transcript.getByText(answer, { exact: true })).toHaveCount(
        1,
      );
      await expect(
        transcript.getByText("Try again.", { exact: true }),
      ).toBeVisible();
      await expect(notice).toHaveCount(0);
      expect(runs).toBe(2);
    } else {
      await expect(notice).toHaveText(failure);
      expect(
        await browser.evaluate(
          (selector) => document.querySelector(selector)?.outerHTML ?? null,
          stoppedSelector,
        ),
      ).toBe(liveMarkup);
      expect(runs).toBe(1);
    }
  });
}

test("a run the person stops keeps its partial reply without showing a failure after reload", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(
    browser,
    bot.id,
    "Stop an inbox summary",
  );
  const thread = await readThreadId(browser, channel);
  const partial = "Reading your inbox.";
  let archive: readonly object[] = [];
  await configureChatStream(browser, [], async () => archive);
  const starts: object[] = [];
  const ending: object[] = [];
  using staged = await stageChatRun(
    browser,
    ({ threadId, runId, messages }) => {
      archive = [
        ...(messages as object[]),
        { id: "stop-partial", role: "assistant", content: partial },
      ];
      const begun = [
        { type: "RUN_STARTED", threadId, runId },
        ...textEvents("stop-partial", partial).slice(0, 2),
      ];
      starts.push(...begun);
      ending.push(
        { type: "TEXT_MESSAGE_END", messageId: "stop-partial" },
        {
          type: "RUN_FINISHED",
          threadId,
          runId,
          outcome: { type: "cancelled" },
        },
      );
      return begun;
    },
    () => ending,
  );
  await browser.route(/\/api\/copilotkit\/agent\/[^/]+\/connect$/, (route) =>
    route.fulfill(chatEventStream(starts.length ? [...starts, ...ending] : [])),
  );
  const requests: string[] = [];
  await browser.route(
    /\/api\/copilotkit\/agent\/[^/]+\/stop\/[^/?]+$/,
    async (route) => {
      requests.push(
        `${route.request.method} ${decodeURIComponent(new URL(route.request.url).pathname.split("/").at(-1) ?? "")}`,
      );
      staged.finish();
      await route.fulfill({ json: { stopped: true } });
    },
  );
  await app.open(`/channel/${channel}`);
  await send(screen, question);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(transcript.getByText(partial, { exact: true })).toBeVisible();
  const stop = screen.getByRole("button", "Stop the Bot", { exact: true });
  const notice = browser.locator(stoppedSelector);
  await stop.tap();
  await expect(stop).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  expect(requests).toEqual([`POST ${thread}`]);
  await browser.reload();
  await expect(transcript.getByText(question, { exact: true })).toBeVisible();
  await expect(transcript.getByText(partial, { exact: true })).toHaveCount(1);
  await expect(stop).toHaveCount(0);
  await expect(notice).toHaveCount(0);
});

test("a failure after browser tool steps surfaces the agent error", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(
    browser,
    bot.id,
    "Browser tool failure",
  );
  const error = "The Claude query timed out after 300s.";
  await configureChatStream(browser, []);
  const inputs: unknown[][] = [];
  await browser.route(chatRunPath, (route) => {
    const { threadId, runId, messages } = readChatRun(route.request.postData);
    inputs.push(messages);
    const started = { type: "RUN_STARTED", threadId, runId };
    const count = inputs.length;
    if (count > 2)
      return route.fulfill(
        chatEventStream([
          started,
          { type: "RUN_ERROR", message: error, code: "agent_error" },
        ]),
      );
    const toolCallId = `list-${count}`;
    return route.fulfill(
      chatEventStream([
        started,
        {
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: "list_bots",
          parentMessageId: `asked-${count}`,
        },
        { type: "TOOL_CALL_ARGS", toolCallId, delta: "{}" },
        { type: "TOOL_CALL_END", toolCallId },
        { type: "RUN_FINISHED", threadId, runId },
      ]),
    );
  });
  await app.open(`/channel/${channel}`);
  await send(screen, "Find two Bots and describe what they do.");
  await expect(browser.locator(stoppedSelector)).toHaveText(error);
  await expect(browser.locator('[data-testid="composer-stop"]')).toHaveCount(0);
  expect(inputs).toHaveLength(3);
  for (const [index, input] of inputs.slice(1).entries()) {
    const result = input.at(-1);
    expect(result).toMatchObject({
      role: "tool",
      toolCallId: `list-${index + 1}`,
    });
    expect(JSON.stringify(result)).toContain(bot.name);
  }
});
