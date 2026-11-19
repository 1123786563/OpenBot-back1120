import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { PUT_TO } from "../../app/src/lib/copilot/markers";
import {
  chatEventStream,
  chatRunPath,
  configureChatStream,
  readChatRun,
} from "./chat-stream";
import { createConversation, readThreadId } from "./conversations";
import { createBot } from "./signed-in";
import { stageChatRun } from "./staged-chat-stream";

const createdAt = "2026-10-09T10:00:00Z";
const checkout =
  "https://checkout.example/carts/0f8e2a4c-9b1d-4f6e-a3c7-5d2e8b1f9a04/pay";

function approval(
  id: string,
  botId: string,
  behaviour: "ask" | "hand_off" = "ask",
) {
  return {
    id,
    status: "pending",
    createdAt,
    action: {
      botId,
      toolRef: "computer_click",
      effect: "write",
      scope: checkout,
      threadId: "fixture-thread",
      args: { element: "Pay now" },
      target: {},
      policy: { behaviour, source: "rule", reason: "Paying is done by you." },
    },
  };
}

function question(id: string, botId: string, text: string) {
  return { id, botId, question: text, threadId: "fixture-thread", createdAt };
}

function suggestion(id: string, agentId: string, title: string) {
  return {
    id,
    agentId,
    title,
    createdAt,
    detail: "",
    sourceApp: null,
    sourceRef: null,
    sourceLink: null,
    pingId: null,
  };
}

async function serveInbox(
  browser: Browser,
  data: () => {
    requests?: ReturnType<typeof approval>[];
    questions?: ReturnType<typeof question>[];
    suggestions?: ReturnType<typeof suggestion>[];
  },
) {
  await browser.route(/\/api\/approvals$/, (route) => {
    const { requests = [], questions = [] } = data();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        requests,
        questions,
        rules: [],
        teamRules: [],
      }),
    });
  });
  await browser.route(/\/api\/proactive\/suggestions$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ suggestions: data().suggestions ?? [] }),
    }),
  );
}

test("Bot details show the whole approval target and send decisions and answers for that Bot", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const other = await createBot(fixtures);
  const bot = await createBot(fixtures);
  let requests = [
    approval("own-approval", bot.id),
    approval("other-approval", other.id),
  ];
  const ownQuestion = question("own-question", bot.id, "Which card?");
  const otherQuestion = question("other-question", other.id, "Which wiki?");
  let questions = [ownQuestion, otherQuestion];
  await serveInbox(browser, () => ({ requests, questions }));

  const decisions: unknown[] = [];
  await browser.route(/\/api\/approvals\/own-approval\/decision$/, (route) => {
    decisions.push({
      method: route.request.method,
      body: JSON.parse(route.request.postData ?? "null"),
    });
    requests = requests.filter(({ id }) => id !== "own-approval");
    return route.fulfill({ json: { ok: true } });
  });
  const answers: unknown[] = [];
  await browser.route(
    /\/api\/approvals\/questions\/own-question\/respond$/,
    (route) => {
      answers.push({
        method: route.request.method,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      questions = [otherQuestion];
      return route.fulfill({ json: { continueHere: false } });
    },
  );

  await app.open(`/bots/${bot.id}`);
  const needsYou = screen.getByRole("heading", "Needs you", { exact: true });
  const scope = screen.getByText(checkout, { exact: true });
  const allow = screen.getByRole("button", "Allow", { exact: true });
  await expect(needsYou).toHaveCount(1);
  await expect(scope).toBeVisible();
  await browser.setViewport({ width: 480, height: 800 });
  const targetFits = await browser.evaluate((target) => {
    const span = [...document.querySelectorAll("span")].find(
      (element) =>
        element.textContent === target && element.children.length === 0,
    );
    if (!span) return false;
    const bounds = span.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(span);
    const lines = [...range.getClientRects()];
    return (
      lines.length > 1 &&
      lines.every(
        (line) =>
          line.right <= bounds.right + 1 && line.bottom <= bounds.bottom + 1,
      )
    );
  }, checkout);
  expect(targetFits).toBe(true);
  await browser.setViewport({ width: 1280, height: 800 });
  await expect(
    screen.getByText(ownQuestion.question, { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(otherQuestion.question, { exact: true }),
  ).toHaveCount(0);
  await expect(allow).toHaveCount(1);
  await expect(
    screen.getByRole("button", "Deny", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", /^More for /).tap();
  await expect(
    screen.getByRole("menuitem", "Always allow here", { exact: true }),
  ).toBeVisible();
  await screen
    .getByRole("menuitem", "Always allow here", { exact: true })
    .press("Escape");
  await allow.tap();
  await expect(scope).toHaveCount(0);
  expect(decisions).toEqual([
    { method: "POST", body: { decision: "allow_once" } },
  ]);

  await screen.getByRole("button", "Answer", { exact: true }).tap();
  const dialog = screen.getByRole("dialog");
  await expect(
    dialog.getByText(ownQuestion.question, { exact: true }),
  ).toBeVisible();
  const send = dialog.getByRole("button", "Send answer", { exact: true });
  await expect(send).toBeDisabled();
  await dialog
    .getByRole("textbox", "Your answer", { exact: true })
    .fill("Use the travel card");
  await send.tap();
  await expect(dialog).toHaveCount(0);
  await expect(needsYou).toHaveCount(0);
  expect(answers).toEqual([
    { method: "POST", body: { response: "Use the travel card" } },
  ]);
});

test("a question with a conversation opens it and sends the person's answer there", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(browser, bot.id, "Card question");
  const threadId = await browser.evaluate(async (channelId) => {
    const response = await fetch(
      `/api/channels/${encodeURIComponent(channelId)}`,
    );
    if (!response.ok)
      throw new Error(`Cannot read the conversation: ${response.status}`);
    const data: { channel: { threadId: string } } = await response.json();
    return data.channel.threadId;
  }, channelId);
  const asked = {
    ...question("in-conversation", bot.id, "Which account?"),
    channelId,
    threadId,
  };
  let questions = [asked];
  await serveInbox(browser, () => ({ questions }));
  await configureChatStream(browser, []);
  const answers: unknown[] = [];
  await browser.route(
    /\/api\/approvals\/questions\/in-conversation\/respond$/,
    (route) => {
      answers.push({
        method: route.request.method,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      questions = [];
      return route.fulfill({ json: { continueHere: false } });
    },
  );

  await app.open(`/bots/${bot.id}`);
  await screen.getByRole("button", "Answer", { exact: true }).tap();
  await expect(browser).toHaveURL(
    new RegExp(`/channel/${RegExp.escape(channelId)}$`),
  );
  await expect(screen.getByRole("dialog")).toHaveCount(0);
  const notice = screen.getByRole(
    "region",
    `${bot.name} is waiting on your answer`,
    { exact: true },
  );
  await expect(notice.getByText(asked.question, { exact: true })).toBeVisible();
  const answer = "Use the expenses account";
  await screen.getByRole("textbox", "Message", { exact: true }).fill(answer);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect(notice).toHaveCount(0);
  await expect(
    screen
      .getByRole("region", "Messages", { exact: true })
      .getByText(answer, { exact: true }),
  ).toBeVisible();
  expect(answers).toEqual([
    { method: "POST", body: { response: answer, inConversation: true } },
  ]);
});

test("a person can mark a handed-off action done without authorizing it", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  let requests = [approval("handed-off", bot.id, "hand_off")];
  await serveInbox(browser, () => ({ requests }));
  const decisions: unknown[] = [];
  await browser.route(/\/api\/approvals\/handed-off\/decision$/, (route) => {
    decisions.push({
      method: route.request.method,
      body: JSON.parse(route.request.postData ?? "null"),
    });
    requests = [];
    return route.fulfill({ json: { ok: true } });
  });

  await app.open(`/bots/${bot.id}`);
  await expect(screen.getByText(/Handed to you: Paying/)).toBeVisible();
  await expect(screen.getByRole("button", /^Allow(?: once)?$/)).toHaveCount(0);
  await screen.getByRole("button", "I did it myself", { exact: true }).tap();
  await expect(
    screen.getByRole("heading", "Needs you", { exact: true }),
  ).toHaveCount(0);
  expect(decisions).toEqual([
    { method: "POST", body: { decision: "handled" } },
  ]);
});

test("a delegated question belongs to the conversation Bot and can be dismissed unanswered", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const owner = await createBot(fixtures);
  const helper = await createBot(fixtures);
  const delegated = {
    ...question("delegated", helper.id, "Which ledger?"),
    conversationBotId: owner.id,
  };
  const control = question("helper-question", helper.id, "Which wiki?");
  let questions = [delegated, control];
  await serveInbox(browser, () => ({ questions }));
  const questionWrites: string[] = [];
  await browser.route(
    /\/api\/approvals\/questions\/delegated\/(?:dismiss|respond)$/,
    (route) => {
      questionWrites.push(
        `${route.request.method} ${new URL(route.request.url).pathname}`,
      );
      questions = [control];
      return route.fulfill({ json: { ok: true } });
    },
  );

  await app.open(`/bots/${helper.id}`);
  await expect(
    screen.getByText(control.question, { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(delegated.question, { exact: true }),
  ).toHaveCount(0);

  await app.open(`/bots/${owner.id}`);
  const needsYou = screen.getByRole("heading", "Needs you", { exact: true });
  await expect(
    screen.getByText(delegated.question, { exact: true }),
  ).toBeVisible();
  await expect(needsYou).toHaveCount(1);
  await expect(
    screen.getByText("No actions need your approval.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByText("Waiting for you", { exact: true }),
  ).toHaveCount(0);
  await screen
    .getByRole("button", `Dismiss ${delegated.question}`, { exact: true })
    .tap();
  await expect(needsYou).toHaveCount(0);
  expect(questionWrites).toEqual([
    "POST /api/approvals/questions/delegated/dismiss",
  ]);
});

test("check-in suggestions and the empty Needs you state are scoped to the selected Bot", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const other = await createBot(fixtures);
  const bot = await createBot(fixtures);
  const own = suggestion("own-suggestion", bot.id, "Chase the March invoice");
  const others = suggestion("other-suggestion", other.id, "Archive old pages");
  let suggestions = [own, others];
  await serveInbox(browser, () => ({
    requests: [approval("other-approval", other.id)],
    suggestions,
  }));
  const path = `/bots/${bot.id}`;
  await app.open(path);
  await expect(screen.getByText(own.title, { exact: true })).toBeVisible();
  await expect(screen.getByText(others.title, { exact: true })).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Allow", { exact: true }),
  ).toHaveCount(0);

  suggestions = [others];
  const loaded = Promise.all([
    browser.waitForResponse(/\/api\/proactive\/suggestions$/),
    browser.waitForResponse(/\/api\/approvals$/),
  ]);
  await app.open(path);
  await loaded;
  await expect(
    screen.getByRole("heading", bot.name, { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("heading", "Needs you", { exact: true }),
  ).toHaveCount(0);
});

test("OpenFuse Ideas lists only the selected Bot's suggestions", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const other = await createBot(fixtures);
  const bot = await createBot(fixtures);
  const own = Array.from({ length: 5 }, (_, index) =>
    suggestion(`own-${index}`, bot.id, `Suggestion ${index + 1}`),
  );
  const others = suggestion("other-suggestion", other.id, "Archive old pages");
  await serveInbox(browser, () => ({ suggestions: [...own, others] }));
  await browser.route(/\/api\/settings\/preferences$/, async (route) => {
    const response = await route.fetch();
    const data = await response.json<{
      preferences: Record<string, unknown>;
    }>();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...data,
        preferences: { ...data.preferences, skin: "openmuse" },
      }),
    });
  });

  await app.open(`/bots/${bot.id}`);
  await screen.getByRole("link", "Ideas", { exact: true }).tap();
  await expect(browser).toHaveURL(/\/s\/ideas$/);
  await expect(
    screen.getByRole("heading", "Suggested next steps", { exact: true }),
  ).toBeVisible();
  const fourth = screen.getByText("Suggestion 4", { exact: true });
  const fifth = screen.getByText("Suggestion 5", { exact: true });
  const expand = screen.getByRole("button", "Show 2 more", { exact: true });
  await expect(screen.getByText("Suggestion 3", { exact: true })).toBeVisible();
  await expect(fourth).toHaveCount(0);
  await expect(fifth).toHaveCount(0);
  await expand.tap();
  await expect(fourth).toBeVisible();
  await expect(fifth).toBeVisible();
  await expect(expand).toHaveCount(0);
  await expect(screen.getByText(others.title, { exact: true })).toHaveCount(0);
});

for (const single of [false, true]) {
  test(`a Bot question submits exactly one answer for ${single ? "one decision" : "multiple decisions"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const agent = "general-assistant";
    await app.open("/");
    const channelId = await createConversation(
      browser,
      agent,
      "Launch decisions",
    );
    const threadId = await readThreadId(browser, channelId);
    const parts = single
      ? [
          {
            header: "Time zone",
            question: "Which time zone should the event use?",
            options: ["Europe/London", "America/New_York"],
          },
        ]
      : [
          {
            header: "Tier name",
            question: "Which paid-tier name?",
            options: ["Pro", "Plus"],
          },
          { header: "Thursday", question: "What is Thursday for?" },
        ];
    const asked = single ? parts[0].question : "Two launch decisions";
    const callId = "launch-question-call";
    const messages = [
      { id: "person", role: "user", content: "Plan the launch." },
      {
        id: "assistant",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: callId,
            type: "function",
            function: {
              name: "ask_person",
              arguments: JSON.stringify({ question: asked, parts }),
            },
          },
        ],
      },
      {
        id: "tool",
        role: "tool",
        toolCallId: callId,
        content: JSON.stringify(`${PUT_TO}the person in this conversation.`),
      },
    ];
    await configureChatStream(browser, messages, async () => messages);
    const prompt = {
      ...question("launch-decision", agent, asked),
      channelId,
      threadId,
      parts,
    };
    let open = true;
    await serveInbox(browser, () => ({ questions: open ? [prompt] : [] }));
    const answers: unknown[] = [];
    await browser.route(
      /\/api\/approvals\/questions\/launch-decision\/respond$/,
      (route) => {
        answers.push({
          method: route.request.method,
          body: JSON.parse(route.request.postData ?? "null"),
        });
        open = false;
        return route.fulfill({ json: { continueHere: false } });
      },
    );
    await app.open(`/channel/${channelId}`);
    const messagesRegion = screen.getByRole("region", "Messages", {
      exact: true,
    });
    const askedStep = messagesRegion.getByText("Asked you", { exact: true });
    await expect(askedStep).toBeVisible();
    await askedStep.click();
    const details = messagesRegion
      .getByRole("list")
      .filter({ hasText: parts[0].question });
    await expect(details.getByRole("listitem")).toHaveCount(parts.length);
    await expect(details.getByRole("listitem").first()).toHaveText(
      `${parts[0].header}: ${parts[0].question} (${parts[0].options?.join(", ")})`,
    );
    expect(
      await browser.evaluate((text) => {
        const list = [...document.querySelectorAll("ol")].find((candidate) =>
          candidate.textContent?.includes(text),
        );
        return list ? getComputedStyle(list).listStyleType : null;
      }, parts[0].question),
    ).toBe(single ? "none" : "decimal");
    await expect(messagesRegion.getByText(/Blocked/)).toHaveCount(0);
    const notice = screen.getByRole("region", /is waiting on your answer$/);
    if (single) {
      await expect(
        notice.getByText("Question 1 of 1", { exact: true }),
      ).toHaveCount(0);
      await expect(
        notice.getByRole("button", "Next", { exact: true }),
      ).toHaveCount(0);
      await expect(
        notice.getByRole("button", "Send answers", { exact: true }),
      ).toHaveCount(0);
      await notice.getByRole("radio", "Europe/London", { exact: true }).click();
    } else {
      await expect(
        notice.getByText("Question 1 of 2", { exact: true }),
      ).toBeVisible();
      await notice.getByRole("radio", "Pro", { exact: true }).click();
      await notice.getByRole("button", "Next", { exact: true }).click();
      await expect(
        notice.getByText("Question 2 of 2", { exact: true }),
      ).toBeVisible();
      expect(answers).toEqual([]);
      await notice
        .getByRole("textbox", "Thursday, in your own words", { exact: true })
        .fill("OpenBot 1.0 only");
    }
    await notice
      .getByRole("button", single ? "Send answer" : "Send answers", {
        exact: true,
      })
      .click();
    await expect(notice).toHaveCount(0);
    const response = single
      ? "Time zone: Europe/London"
      : "Tier name: Pro\nThursday: OpenBot 1.0 only";
    expect(answers).toEqual([
      { method: "POST", body: { response, inConversation: true } },
    ]);
    await expect(
      messagesRegion.getByText(single ? response : /OpenBot 1\.0 only/),
    ).toBeVisible();
  });
}

for (const newlyAsked of [false, true]) {
  test(`answering a ${newlyAsked ? "just-asked" : "restored"} question streams work in the conversation and closes it after Stop`, async ({
    app,
    browser,
    screen,
  }) => {
    const bot = "general-assistant";
    const inquiry = "Which city should I look for weekend plans in?";
    const request = "Find weekend plans";
    const update = "Looking up what's on in Chicago this weekend";
    const result = `${PUT_TO}the person in this conversation.`;
    const toolCallId = "weekend-question";
    const toolArgs = JSON.stringify({ question: inquiry });
    await app.open("/");
    const channelId = await createConversation(browser, bot, "Weekend plans");
    const threadId = await readThreadId(browser, channelId);
    const history = [
      { id: "person", role: "user", content: request },
      {
        id: "asks",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCallId,
            type: "function",
            function: { name: "ask_person", arguments: toolArgs },
          },
        ],
      },
      { id: "asked", role: "tool", toolCallId, content: result },
    ];
    let waiting = !newlyAsked;
    const prompt = {
      ...question("weekend", bot, inquiry),
      channelId,
      threadId,
      conversationBotId: bot,
    };
    await configureChatStream(
      browser,
      () => (waiting ? history : []),
      async () => (waiting ? history : []),
    );
    await serveInbox(browser, () => ({ questions: waiting ? [prompt] : [] }));
    await browser.route(/\/api\/bots\/attention$/, (route) =>
      route.fulfill({
        json: {
          bots: [
            {
              agentId: bot,
              name: "Personal Assistant",
              questions: waiting ? 1 : 0,
              approvals: 0,
              handoffs: 0,
              unread: 0,
              paused: false,
              notify: "none",
              items: 0,
              tasks: { needsInput: 0, ready: 0, failed: 0 },
            },
          ],
        },
      }),
    );
    const answers: unknown[] = [];
    await browser.route(
      /\/api\/approvals\/questions\/weekend\/respond$/,
      (route) => {
        answers.push(JSON.parse(route.request.postData ?? "null"));
        waiting = false;
        return route.fulfill({ json: { id: "weekend", continueHere: true } });
      },
    );
    const stop = screen.getByRole("button", "Stop the Bot", { exact: true });
    const message = screen.getByRole("textbox", "Message", { exact: true });
    const send = screen.getByRole("button", "Send message", { exact: true });
    const notice = screen.getByRole("region", /is waiting on your answer$/);
    const badge = screen.getByRole("img", "1 thing needs you", { exact: true });
    if (newlyAsked) {
      await browser.route(chatRunPath, (route) => {
        const { runId, threadId } = readChatRun(
          route.request.postData ?? undefined,
        );
        waiting = true;
        return route.fulfill(
          chatEventStream([
            { type: "RUN_STARTED", runId, threadId },
            {
              type: "TOOL_CALL_START",
              toolCallId,
              toolCallName: "ask_person",
              parentMessageId: "asks",
            },
            { type: "TOOL_CALL_ARGS", toolCallId, delta: toolArgs },
            { type: "TOOL_CALL_END", toolCallId },
            {
              type: "TOOL_CALL_RESULT",
              messageId: "asked",
              toolCallId,
              content: result,
              role: "tool",
            },
            { type: "RUN_FINISHED", runId, threadId },
          ]),
        );
      });
    }
    const url = `/channel/${channelId}`;
    await app.open(url);
    if (newlyAsked) {
      await message.fill(request);
      await send.click();
      await expect(
        screen.getByText("Asked you", { exact: true }),
      ).toBeVisible();
      await expect(stop).toHaveCount(0);
    } else {
      await expect(notice).toBeVisible();
      await expect(badge).toBeVisible();
    }
    const runs: ReturnType<typeof readChatRun>[] = [];
    using stream = await stageChatRun(
      browser,
      (run) => {
        runs.push(run);
        return [
          { type: "RUN_STARTED", runId: run.runId, threadId: run.threadId },
          {
            type: "TEXT_MESSAGE_START",
            messageId: "answer-in-progress",
            role: "assistant",
          },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "answer-in-progress",
            delta: update,
          },
        ];
      },
      (run) => [
        { type: "TEXT_MESSAGE_END", messageId: "answer-in-progress" },
        {
          type: "RUN_FINISHED",
          runId: run.runId,
          threadId: run.threadId,
          outcome: { type: "cancelled" },
        },
      ],
    );
    const stops: string[] = [];
    await browser.route(
      /\/api\/copilotkit\/agent\/[^/]+\/stop\/[^/]+$/,
      (route) => {
        stops.push(
          decodeURIComponent(
            new URL(route.request.url).pathname.split("/").at(-1) ?? "",
          ),
        );
        stream.finish();
        return route.fulfill({ json: { stopped: true } });
      },
    );
    await message.fill("Chicago");
    await send.click();
    await expect(screen.getByText(update, { exact: true })).toBeVisible();
    await expect(screen.getByText("Chicago", { exact: true })).toBeVisible();
    await expect(screen.getByText(/is reading your answer/)).toHaveCount(0);
    expect(answers).toEqual([{ response: "Chicago", inConversation: true }]);
    expect(runs).toHaveLength(1);
    expect(runs[0].threadId).toBe(threadId);
    expect(runs[0].messages.at(-1)).toEqual({
      id: "person-response:weekend",
      role: "user",
      content: `In response to your question: ${inquiry}\n\nChicago`,
    });
    await stop.click();
    await expect.poll(() => stops).toEqual([threadId]);
    await expect(stop).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    await expect(badge).toHaveCount(0);
    await browser.reload();
    await expect(message).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(badge).toHaveCount(0);
    expect(runs).toHaveLength(1);
  });
}
