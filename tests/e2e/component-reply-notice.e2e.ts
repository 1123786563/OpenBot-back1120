import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { type BrowserNotices, captureNotices } from "./browser-notices";
import {
  chatEventStream,
  chatRunPath,
  configureChatStream,
  readChatRun,
} from "./chat-stream";
import { createConversation, readThreadId } from "./conversations";
import { ASK, BUDGET, RENDERED_BUDGET } from "./fixtures/component-notice";
import { createBot } from "./signed-in";

const record = {
  title: "Northwind Traders",
  subtitle: "Enterprise account",
  fields: [{ label: "Owner", value: "Priya Raman" }],
};
const drawings = {
  sandbox: {
    name: "generateSandboxedUi",
    args: BUDGET,
    headline: "Weekend trip budget",
  },
  catalog: {
    name: "render_ui",
    args: RENDERED_BUDGET,
    headline: "Weekend trip budget",
  },
  record: { name: "showRecord", args: record, headline: record.title },
};
const finalWords = "Change any cost and the total updates.";
type Drawing = keyof typeof drawings;

function drawingEvents(kind: Drawing, runId: string) {
  const call = drawings[kind];
  const toolCallId = "draw-fixture";
  const tool = [
    {
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: call.name,
      parentMessageId: `assistant-${runId}`,
    },
    { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify(call.args) },
    { type: "TOOL_CALL_END", toolCallId },
  ];
  if (kind === "catalog") {
    return [
      ...tool,
      {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "genui:budget",
        activityType: "generative-ui-surface",
        content: {
          surfaceId: "budget",
          target: "chat",
          catalogId: "openbot/ui@1",
          operations: RENDERED_BUDGET.operations,
          status: "ready",
          rejected: [],
        },
        replace: true,
      },
      {
        type: "TOOL_CALL_RESULT",
        messageId: `result-${runId}`,
        toolCallId,
        content: JSON.stringify({
          status: "rendered",
          applied: 2,
          calls: 0,
          rejected: [],
        }),
      },
    ];
  }
  if (kind === "record") return tool;
  return [
    tool[0],
    {
      type: "ACTIVITY_SNAPSHOT",
      messageId: "draw-fixture-activity",
      activityType: "open-generative-ui",
      content: {
        initialHeight: BUDGET.initialHeight,
        css: BUDGET.css,
        cssComplete: true,
        html: [BUDGET.html],
        htmlComplete: true,
        jsFunctions: BUDGET.jsFunctions,
        jsFunctionsComplete: true,
        generating: false,
      },
    },
    ...tool.slice(1),
  ];
}

type Activity = { agentId: string | null; text: string };

const scenarios: {
  description: string;
  drawing: Drawing;
  focused?: boolean;
  quiet?: boolean;
  textAfter?: boolean;
}[] = [
  {
    description: "a sandboxed reply announces its heading",
    drawing: "sandbox",
  },
  {
    description: "an A2UI-only reply announces its displayed heading",
    drawing: "catalog",
  },
  { description: "a Record card reply announces its title", drawing: "record" },
  {
    description:
      "a focused browser reports the reply without showing a notification",
    drawing: "sandbox",
    focused: true,
  },
  {
    description:
      "a Bot set to only when it needs input reports the reply without a notice",
    drawing: "sandbox",
    quiet: true,
  },
  {
    description: "a drawn reply followed by text announces only the last text",
    drawing: "sandbox",
    textAfter: true,
  },
];

for (const scenario of scenarios) {
  test(scenario.description, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(browser, bot.id, "Weekend away");
    const thread = await readThreadId(browser, channel);
    if (scenario.quiet) {
      expect(
        await browser.evaluate(async (id) => {
          const response = await fetch(
            `/api/bots/${encodeURIComponent(id)}/notifications`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ notify: "needs_input" }),
            },
          );
          return response.ok;
        }, bot.id),
      ).toBe(true);
    }
    const notices = await captureNotices(browser);
    const reported: Activity[] = [];
    const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await browser.route(
      new RegExp(`/api/channels/${escaped}/activity$`),
      async (route) => {
        const report = JSON.parse(route.request.postData ?? "null") as Activity;
        const response = await route.fetch();
        if (response.status !== 204)
          throw new Error(`Could not report activity: ${response.status}`);
        reported.push({ agentId: report.agentId, text: report.text });
        return route.fulfill({ status: response.status });
      },
    );
    if (scenario.drawing === "record") {
      await browser.route(/\/api\/components\/for-agent\//, (route) =>
        route.fulfill({
          json: {
            components: [
              { name: "showRecord", description: "Show one record." },
            ],
          },
        }),
      );
      await browser.route(/\/api\/components\/showRecord\/decision$/, (route) =>
        route.fulfill({ json: { allowed: true } }),
      );
    }
    await configureChatStream(browser);
    const answer = Promise.withResolvers<void>();
    let runs = 0;
    const expectedRuns = scenario.drawing === "catalog" ? 1 : 2;
    await browser.route(chatRunPath, async (route) => {
      const { threadId, runId, messages } = readChatRun(route.request.postData);
      expect(threadId).toBe(thread);
      runs += 1;
      const start = { type: "RUN_STARTED", threadId, runId };
      const finish = { type: "RUN_FINISHED", threadId, runId };
      if (runs === 1) {
        await answer.promise;
        return route.fulfill(
          chatEventStream([
            start,
            ...drawingEvents(scenario.drawing, runId),
            finish,
          ]),
        );
      }
      if (runs !== 2 || expectedRuns !== 2)
        throw new Error(`Unexpected fixture run ${runs}`);
      expect(messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "draw-fixture",
      });
      const messageId = `text-${runId}`;
      return route.fulfill(
        chatEventStream([
          start,
          ...(scenario.textAfter
            ? [
                { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
                { type: "TEXT_MESSAGE_CONTENT", messageId, delta: finalWords },
                { type: "TEXT_MESSAGE_END", messageId },
              ]
            : []),
          finish,
        ]),
      );
    });

    try {
      await app.open(`/channel/${channel}`);
      await screen.getByRole("textbox", "Message", { exact: true }).fill(ASK);
      await screen.getByRole("button", "Send message", { exact: true }).tap();
      await expect.poll(() => runs).toBe(1);
      expect(await notices()).toEqual([]);
      if (!scenario.focused) {
        await browser.evaluate(() => {
          (window as BrowserNotices).fixtureFocus = false;
          return null;
        });
      }
      answer.resolve();
      await expect.poll(() => runs).toBe(expectedRuns);
      await expect(
        browser.locator('[data-testid="composer-stop"]'),
      ).toBeHidden();
      const summary = scenario.textAfter
        ? finalWords
        : drawings[scenario.drawing].headline;
      const botReports = () =>
        reported.filter(({ agentId }) => agentId === bot.id);
      await expect
        .poll(() => botReports().at(-1))
        .toEqual({ agentId: bot.id, text: summary });
      if (!scenario.textAfter)
        expect(botReports()).toEqual([{ agentId: bot.id, text: summary }]);

      if (scenario.focused || scenario.quiet) {
        await browser.evaluate(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 2200));
          return null;
        });
        expect(await notices()).toEqual([]);
      } else {
        await expect.poll(notices).toEqual([
          {
            title: `${bot.name} replied`,
            body: summary,
            tag: `openbot-${channel}`,
            path: `/channel/${channel}`,
          },
        ]);
      }
    } finally {
      answer.resolve();
    }
  });
}

test("a background conversation announces only its last reply and opens when the notice is clicked", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id, "March receipts");
  const notices = await captureNotices(browser);
  await configureChatStream(browser);
  const headline = "Categorized three expenses.";
  const answer = `${headline}\nThe receipts are in Drive.`;
  await app.open("/bots");
  await expect(
    screen.getByRole("heading", "Bots", { exact: true }),
  ).toBeVisible();
  await browser.evaluate(() => {
    const page = window as BrowserNotices;
    page.fixtureVisibility = "hidden";
    page.fixtureFocus = false;
    return null;
  });

  const post = (
    kind: "activity" | "busy",
    body: { text?: string; busy?: boolean },
  ) =>
    browser.evaluate(
      async ({ channel, agentId, kind, body }) => {
        const response = await fetch(
          `/api/channels/${encodeURIComponent(channel)}/${kind}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              kind === "busy"
                ? body
                : { ...body, agentId, at: new Date().toISOString() },
            ),
          },
        );
        return response.status;
      },
      { channel, agentId: bot.id, kind, body },
    );
  const waitForNoticeWindow = () =>
    browser.evaluate(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      return null;
    });

  expect(await post("busy", { busy: true })).toBe(204);
  expect(await post("activity", { text: "I found the receipts." })).toBe(204);
  await waitForNoticeWindow();
  expect(await notices()).toEqual([]);
  expect(await post("activity", { text: answer })).toBe(204);
  expect(await post("busy", { busy: false })).toBe(204);
  const expected = [
    {
      title: `${bot.name} replied`,
      body: headline,
      tag: `openbot-${channel}`,
      path: `/channel/${channel}`,
    },
  ];
  await expect.poll(notices).toEqual(expected);

  expect(await post("busy", { busy: true })).toBe(204);
  expect(await post("activity", { text: answer })).toBe(204);
  expect(await post("busy", { busy: false })).toBe(204);
  await waitForNoticeWindow();
  expect(await notices()).toEqual(expected);
  const clicked = await browser.evaluate(() => {
    const actions = (window as BrowserNotices).fixtureNoticeActions?.[0];
    if (!actions) throw new Error("Missing the captured reply notice");
    let focused = 0;
    window.focus = () => {
      focused += 1;
    };
    actions.click();
    return { focused, closed: actions.closed() };
  });
  expect(clicked).toEqual({ focused: 1, closed: true });
  await expect(browser).toHaveURL(new RegExp(`/channel/${channel}$`));
  await expect(
    screen.getByRole("region", "Messages", { exact: true }),
  ).toBeVisible();
});
