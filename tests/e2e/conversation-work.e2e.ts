import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { answerMessageId } from "../../shared/handoff-markers";
import { OPENBOT_WAITING_METADATA } from "../../shared/waiting";
import { chatRunPath, configureChatStream, readChatRun } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

test("background work survives reload and clears when the server announces settlement", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const owner = await createBot(fixtures);
  const asked = await createBot(fixtures);
  const palette = (selector: string) =>
    browser.evaluate((selector) => {
      const avatar = document.querySelector(selector);
      if (!avatar) return [];
      const style = getComputedStyle(avatar);
      return ["--c1", "--c2", "--c3", "--c4"].map((token) =>
        style.getPropertyValue(token),
      );
    }, selector);
  await app.open("/bots");
  const rosterAvatar = `[role="img"][data-variant="static"][aria-label="${asked.name}"]`;
  await expect(browser.locator(rosterAvatar).first()).toBeVisible();
  const expectedPalette = await palette(rosterAvatar);
  expect(expectedPalette).toHaveLength(4);
  expect(expectedPalette.every((color) => color.length > 0)).toBe(true);
  const channelId = await createConversation(browser, owner.id);
  const since = new Date().toISOString();
  const work = [
    {
      kind: "handoff",
      key: "hop-known",
      botId: asked.id,
      botName: "An old name",
      since,
    },
    {
      kind: "handoff",
      key: "hop-unknown",
      botId: "unlisted-bot",
      botName: null,
      since,
    },
    {
      kind: "routine",
      key: "run-scheduled",
      routineId: "daily-routine",
      botId: owner.id,
      botName: "Old routine owner name",
      since,
    },
  ];
  const detailPath = new RegExp(`/api/channels/${RegExp.escape(channelId)}$`);
  let reads = 0;
  await browser.route(detailPath, async (route) => {
    const response = await route.fetch();
    expect(response.status).toBe(200);
    const data = await response.json<{ channel: Record<string, unknown> }>();
    reads++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...data, channel: { ...data.channel, work } }),
    });
  });
  await configureChatStream(browser, [
    {
      id: "prior-message",
      role: "user",
      content: "Check the background work.",
    },
  ]);

  await app.open(`/channel/${channelId}`);
  const messages = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    messages.getByText("Check the background work.", { exact: true }),
  ).toBeVisible();
  const block = browser.locator('[data-testid="channel-work"]');
  const rows = block.getByRole("status");
  const expected = [
    `Asking ${asked.name}…`,
    "Asking another Bot…",
    `${owner.name} is running a routine…`,
  ];
  const checkRows = async () => {
    await expect(rows).toHaveCount(3);
    for (const [index, label] of expected.entries()) {
      await expect(rows.nth(index)).toHaveText(label);
    }
    const historicalName = block.getByText("Asking An old name…", {
      exact: true,
    });
    await expect(historicalName).toHaveCount(0);
    const avatarSelector =
      '[data-testid="channel-work"] [role="status"] [aria-hidden="true"] [role="img"]';
    const avatar = browser.locator(avatarSelector).first();
    await expect(avatar).toHaveAttribute("aria-label", asked.name);
    await expect(avatar).toBeVisible();
    await expect.poll(() => palette(avatarSelector)).toEqual(expectedPalette);
  };
  await checkRows();

  const before = reads;
  await browser.reload();
  await expect(
    messages.getByText("Check the background work.", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await checkRows();

  const activityStatus = await browser.evaluate(async (id) => {
    const response = await fetch(
      `/api/channels/${encodeURIComponent(id)}/activity`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          at: new Date().toISOString(),
          text: "A note from another tab.",
          agentId: null,
        }),
      },
    );
    return response.status;
  }, channelId);
  expect(activityStatus).toBe(204);
  await checkRows();

  const settled = await browser.evaluate(async (id) => {
    const response = await fetch(
      `/api/channels/${encodeURIComponent(id)}/busy`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ busy: false }),
      },
    );
    return response.status;
  }, channelId);
  expect(settled).toBe(204);
  await expect(block).toHaveCount(0);
});

const waitingCases = [
  { name: "an already handled approval", approval: true },
  { name: "an unresolved agent interrupt", approval: false },
];

for (const { name, approval } of waitingCases) {
  test(`sending a follow-up after replaying ${name}`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channelId = await createConversation(browser, bot.id);
    const initial = "Reply to Sam about the spec.";
    const followUp = "Send Ana the spec too.";
    await configureChatStream(
      browser,
      [
        { id: "original-ask", role: "user", content: initial },
        {
          id: "original-tool",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-send",
              type: "function",
              function: {
                name: "mcp__notion__notion-create-comment",
                arguments: '{"text":"Friday works."}',
              },
            },
          ],
        },
      ],
      undefined,
      {
        type: "interrupt",
        interrupts: [
          {
            id: "call-send",
            reason: "human_input",
            message: approval
              ? "This action is waiting for your approval."
              : "Pick an option.",
            ...(approval
              ? {
                  metadata: {
                    [OPENBOT_WAITING_METADATA]: {
                      kind: "approval",
                      approvalId: "decided-approval",
                      requestId: "decided-approval",
                    },
                  },
                }
              : {}),
          },
        ],
      },
    );
    const runs: { threadId: string; messages: unknown[]; resumed: boolean }[] =
      [];
    await browser.route(chatRunPath, (route) => {
      const { runId, threadId, messages } = readChatRun(route.request.postData);
      const data: unknown = JSON.parse(route.request.postData ?? "null");
      runs.push({
        threadId,
        messages,
        resumed: data !== null && typeof data === "object" && "resume" in data,
      });
      const events = [
        { type: "RUN_STARTED", threadId, runId },
        { type: "RUN_FINISHED", threadId, runId },
      ];
      return route.fulfill({
        contentType: "text/event-stream",
        body: events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      });
    });
    const detail = browser.waitForResponse(
      new RegExp(`/api/channels/${RegExp.escape(channelId)}$`),
    );
    await app.open(`/channel/${channelId}`);
    const {
      channel: { threadId },
    } = await (await detail).json<{ channel: { threadId: string } }>();
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(transcript.getByText(initial, { exact: true })).toBeVisible();
    const editor = screen.getByRole("textbox", "Message", { exact: true });
    await editor.fill(followUp);
    await screen.getByRole("button", "Send message", { exact: true }).tap();

    if (approval) {
      await expect.poll(() => runs.length).toBe(1);
      expect(runs[0].threadId).toBe(threadId);
      expect(runs[0].resumed).toBe(false);
      expect(runs[0].messages.at(-1)).toMatchObject({
        role: "user",
        content: followUp,
      });
      await expect(
        transcript.getByText(followUp, { exact: true }),
      ).toBeVisible();
      await expect(
        browser.locator('[data-testid="composer-stop"]'),
      ).toBeHidden();
    } else {
      await expect(
        screen.getByText("Your message wasn't sent. Try again.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(editor).toHaveText(followUp);
      await expect(transcript.getByText(followUp, { exact: true })).toHaveCount(
        0,
      );
      expect(runs).toHaveLength(0);
    }
  });
}

test("a browser tool continuation reports the final reply without splitting the conversation's working state", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(
    browser,
    bot.id,
    "Browser tool conversation",
  );
  await configureChatStream(browser, []);
  const question = "Tell me which Bots are available.";
  const reply = "The workspace Bot list is ready.";
  const activity: unknown[] = [];
  const busy: unknown[] = [];
  const channelPattern = RegExp.escape(channelId);
  await browser.route(
    new RegExp(`/api/channels/${channelPattern}/(activity|busy)$`),
    async (route) => {
      const { pathname } = new URL(route.request.url);
      const response = await route.fetch();
      expect(response.status).toBe(204);
      const payload: unknown = JSON.parse(route.request.postData ?? "null");
      (pathname.endsWith("/busy") ? busy : activity).push(payload);
      await route.fulfill({ status: response.status });
    },
  );

  const runs: unknown[][] = [];
  await browser.route(chatRunPath, (route) => {
    const { threadId, runId, messages } = readChatRun(route.request.postData);
    runs.push(messages);
    const events = [{ type: "RUN_STARTED", threadId, runId }];
    const output =
      runs.length === 1
        ? [
            {
              type: "TOOL_CALL_START",
              toolCallId: "lookup-bots",
              toolCallName: "list_bots",
              parentMessageId: "list-request",
            },
            { type: "TOOL_CALL_ARGS", toolCallId: "lookup-bots", delta: "{}" },
            { type: "TOOL_CALL_END", toolCallId: "lookup-bots" },
          ]
        : [
            {
              type: "TEXT_MESSAGE_START",
              messageId: "final-answer",
              role: "assistant",
            },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "final-answer",
              delta: reply,
            },
            { type: "TEXT_MESSAGE_END", messageId: "final-answer" },
          ];
    return route.fulfill({
      contentType: "text/event-stream",
      body: [...events, ...output, { type: "RUN_FINISHED", threadId, runId }]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });

  await app.open(`/channel/${channelId}`);
  await screen.getByRole("textbox", "Message", { exact: true }).fill(question);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(transcript.getByText(reply, { exact: true })).toBeVisible();
  expect(runs).toHaveLength(2);
  expect(runs[0].at(-1)).toMatchObject({ role: "user", content: question });
  expect(runs[1].at(-1)).toMatchObject({
    role: "tool",
    toolCallId: "lookup-bots",
  });
  expect(JSON.stringify(runs[1].at(-1))).toContain(bot.name);
  await expect.poll(() => activity.length).toBe(2);
  expect(activity[0]).toMatchObject({ agentId: null, text: question });
  expect(activity[1]).toMatchObject({ agentId: bot.id, text: reply });
  await expect.poll(() => busy).toEqual([{ busy: true }, { busy: false }]);
});

test("a delegated answer names the Bot that supplied it while ordinary replies stay unlabelled", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const owner = await createBot(fixtures);
  const delegate = await createBot(fixtures);
  const id = await createConversation(
    browser,
    owner.id,
    "Ask about the handbook",
  );
  const direct = "I asked the other Bot to describe what it can do.";
  const answer =
    "I answer questions about company policy and cite the handbook.";
  await configureChatStream(browser, [
    { id: "ask", role: "user", content: "Ask the other Bot what it can do." },
    { id: "direct", role: "assistant", content: direct },
    {
      id: answerMessageId(delegate.id, "e2e-handoff"),
      role: "assistant",
      content: answer,
    },
  ]);

  await app.open(`/channel/${id}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const delegated = browser.locator(`[data-speaker="${delegate.id}"]`);
  const headers = browser.locator(
    `[data-speaker="${delegate.id}"] [data-slot="message-header"]`,
  );
  await expect(delegated.getByText(answer, { exact: true })).toBeVisible();
  await expect(headers).toHaveText(delegate.name);
  await expect(transcript.getByText(direct, { exact: true })).toBeVisible();
  await expect(browser.locator("[data-speaker]")).toHaveCount(1);
});
