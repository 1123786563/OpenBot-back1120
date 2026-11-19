import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { chatEventStream, chatRunPath, readChatRun } from "./chat-stream";

const botId = "personal-assistant";
const first =
  "Use web search to find the top 10 stories on the Hacker News front page right now. Show me a bar chart of them by points, then list them with their points and links.";
const second =
  "Use Gmail to read my emails from the past 24 hours and tell me the top 2 that need my attention, and why. Don't mark anything as read or change anything. If Gmail isn't connected, help me connect it here, then continue this request.";

const isUserMessage = (message: unknown) =>
  typeof message === "object" &&
  message !== null &&
  "role" in message &&
  message.role === "user";

async function serveStarts(browser: Browser) {
  const state = {
    creates: [] as { agentIds: string[] }[],
    runs: [] as ReturnType<typeof readChatRun>[],
    runPaths: [] as string[],
    runModels: [] as (string | null)[],
    deleted: [] as string[],
    claimed: null as string | null,
    saved: { model: null as string | null, effort: null as string | null },
    failModel: false,
    failRun: false,
    modelGate: Promise.resolve(),
  };
  const bot = {
    id: botId,
    name: "Tour Bot",
    title: "Your helper",
    avatarSeed: botId,
    endpoint: null,
    builtIn: true,
    mine: true,
    canManage: true,
    visibility: "private",
    hidden: false,
    pinned: false,
    roleDescription: "Helps with starter tasks.",
    runsOnOpenBotModel: true,
  };
  const channels = new Map<
    string,
    Record<string, string | string[] | boolean | null>
  >();
  await browser.route(/\/api\/agents(?:\/personal-assistant)?$/, (route) =>
    route.fulfill({
      json: route.request.url.endsWith(`/agents/${botId}`)
        ? { agent: bot }
        : { agents: [bot] },
    }),
  );
  await browser.route(/\/api\/settings\/preferences$/, (route) =>
    route.fulfill({
      json: {
        preferences: {
          skin: "openbot",
          messageListEmphasis: "thread",
          selfHostBannerDismissed: true,
          narration: null,
          proactive: "on",
          ...(state.claimed === null
            ? {}
            : { starterTourChannelId: state.claimed }),
        },
      },
    }),
  );
  await browser.route(/\/api\/models$/, (route) =>
    route.fulfill({
      json: {
        provider: "openai",
        source: "openai",
        exposure: "all",
        default: "default-model",
        choosable: true,
        models: [
          { id: "default-model", label: "Default model", vendor: "openai" },
          { id: "alternate-model", label: "Alternate model", vendor: "openai" },
        ],
      },
    }),
  );
  await browser.route(/\/api\/route$/, (route) =>
    route.fulfill({
      json: {
        agentId: "other-bot",
        name: "Other Bot",
        reason: "Must not override an explicit recipient",
        fallback: false,
        viaMention: false,
      },
    }),
  );
  await browser.route(/\/api\/plugins\/for\/personal-assistant$/, (route) =>
    route.fulfill({ json: { tools: [], skills: [] } }),
  );
  await browser.route(
    /\/api\/components\/for-agent\/personal-assistant$/,
    (route) => route.fulfill({ json: { components: [] } }),
  );
  await browser.route(
    /\/api\/channels(?:\/(?!events)[^/?]+(?:\/(?:model|activity|busy|read))?)?(?:\?.*)?$/,
    async (route) => {
      const path = new URL(route.request.url);
      const id = path.pathname.split("/")[3];
      if (path.pathname.endsWith("/model")) {
        if (route.request.method === "PUT") {
          await state.modelGate;
          if (state.failModel)
            return route.fulfill({
              status: 503,
              json: { error: "Model save failed. Try again." },
            });
          state.saved = JSON.parse(route.request.postData ?? "null");
        }
        return route.fulfill({ json: state.saved });
      }
      if (!id && route.request.method === "POST") {
        const body = JSON.parse(route.request.postData ?? "null");
        state.creates.push(body);
        const next = `tour-channel-${state.creates.length}`;
        const channel = {
          id: next,
          name: "Tour Bot",
          agentIds: body.agentIds,
          threadId: `tour-thread-${state.creates.length}`,
          active: true,
          summary: null,
          lastMessage: null,
          lastMessageAgentId: null,
          lastMessageAt: null,
          createdAt: "2026-11-19T08:00:00Z",
          pinned: false,
          lastReadAt: null,
        };
        channels.set(next, channel);
        state.claimed ??= next;
        return route.fulfill({ status: 201, json: { channel } });
      }
      if (route.request.method === "DELETE") {
        state.deleted.push(id);
        channels.delete(id);
        if (
          path.searchParams.get("discardFailedStart") === "true" &&
          state.claimed === id
        )
          state.claimed = null;
        return route.fulfill({ status: 204 });
      }
      if (route.request.method !== "GET") return route.fulfill({ status: 204 });
      return route.fulfill({
        json: id
          ? { channel: channels.get(id) ?? null }
          : { channels: [...channels.values()], nextCursor: null },
      });
    },
  );
  await browser.route(/\/api\/copilotkit\/info$/, (route) =>
    route.fulfill({
      json: {
        version: "fixture",
        mode: "sse",
        agents: { [botId]: { description: "Tour Bot", capabilities: {} } },
        telemetryDisabled: true,
      },
    }),
  );
  await browser.route(
    /\/api\/copilotkit\/threads\/[^/]+\/messages(?:\?.*)?$/,
    (route) => route.fulfill({ json: { messages: [] } }),
  );
  await browser.route(/\/api\/copilotkit\/agent\/[^/]+\/connect$/, (route) => {
    const run = readChatRun(route.request.postData);
    return route.fulfill(
      chatEventStream([
        { type: "RUN_STARTED", threadId: run.threadId, runId: "join" },
        { type: "MESSAGES_SNAPSHOT", messages: [] },
        { type: "RUN_FINISHED", threadId: run.threadId, runId: "join" },
      ]),
    );
  });
  await browser.route(chatRunPath, (route) => {
    const run = readChatRun(route.request.postData);
    state.runs.push(run);
    state.runPaths.push(new URL(route.request.url).pathname);
    state.runModels.push(state.saved.model);
    const events = [
      { type: "RUN_STARTED", threadId: run.threadId, runId: run.runId },
    ];
    return route.fulfill(
      chatEventStream(
        state.failRun
          ? [
              ...events,
              {
                type: "RUN_ERROR",
                message: "Starter task failed once",
                code: "agent_error",
              },
            ]
          : [
              ...events,
              {
                type: "TEXT_MESSAGE_START",
                messageId: `reply-${run.runId}`,
                role: "assistant",
              },
              {
                type: "TEXT_MESSAGE_CONTENT",
                messageId: `reply-${run.runId}`,
                delta: "Starter result",
              },
              { type: "TEXT_MESSAGE_END", messageId: `reply-${run.runId}` },
              {
                type: "RUN_FINISHED",
                threadId: run.threadId,
                runId: run.runId,
              },
            ],
      ),
    );
  });
  return state;
}

for (const path of ["/", `/channel/new?agent=${botId}`]) {
  test(`${path} starts both tour tasks with the chosen Bot in one conversation`, async ({
    app,
    browser,
    screen,
  }) => {
    const state = await serveStarts(browser);
    await app.open(path);
    await screen
      .getByRole("button", "Chart Hacker News", { exact: true })
      .click();
    await expect.poll(() => state.runs.length).toBe(1);
    expect(state.creates).toEqual([{ agentIds: [botId] }]);
    expect(state.runs[0].messages.find(isUserMessage)).toMatchObject({
      content: first,
    });
    expect(state.runPaths[0]).toBe(`/api/copilotkit/agent/${botId}/run`);
    await expect(
      screen.getByRole("button", "Triage my inbox", { exact: true }),
    ).toBeEnabled();
    await screen
      .getByRole("button", "Triage my inbox", { exact: true })
      .click();
    await expect.poll(() => state.runs.length).toBe(2);
    expect(state.runs[1].threadId).toBe(state.runs[0].threadId);
    expect(state.runs[1].messages.filter(isUserMessage).at(-1)).toMatchObject({
      content: second,
    });
    expect(state.creates).toHaveLength(1);
    await app.open(`/channel/new?agent=${botId}`);
    await expect(
      screen.getByRole("region", "Starter tasks", { exact: true }),
    ).toHaveCount(0);
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("An ordinary later conversation.");
    await screen.getByRole("button", "Send message", { exact: true }).click();
    await expect.poll(() => state.runs.length).toBe(3);
    expect(state.creates).toHaveLength(2);
    expect(state.runs[2].threadId).not.toBe(state.runs[0].threadId);
  });
}

test("a failed model save discards a new starter claim and lets the task retry", async ({
  app,
  browser,
  screen,
}) => {
  const state = await serveStarts(browser);
  await app.open(`/channel/new?agent=${botId}`);
  await screen.getByRole("combobox", /Model: Default model/).click();
  await screen.getByRole("option", "Alternate model", { exact: true }).click();
  state.failModel = true;
  await screen
    .getByRole("button", "Chart Hacker News", { exact: true })
    .click();
  await expect(
    screen.getByText("Model save failed. Try again.", { exact: true }),
  ).toBeVisible();
  expect(state.deleted).toEqual(["tour-channel-1"]);
  expect(state.claimed).toBeNull();
  expect(state.runs).toEqual([]);
  state.failModel = false;
  await screen
    .getByRole("button", "Chart Hacker News", { exact: true })
    .click();
  await expect.poll(() => state.runs.length).toBe(1);
  expect(state.creates).toHaveLength(2);
  expect(state.claimed).toBe("tour-channel-2");
});

for (const failed of [false, true]) {
  test(`tour tasks wait for a pending in-conversation model save (failure=${failed})`, async ({
    app,
    browser,
    screen,
  }) => {
    const state = await serveStarts(browser);
    await app.open("/");
    await screen
      .getByRole("button", "Chart Hacker News", { exact: true })
      .click();
    await expect.poll(() => state.runs.length).toBe(1);
    const task = screen.getByRole("button", "Triage my inbox", { exact: true });
    await expect(task).toBeEnabled();
    const release = Promise.withResolvers<void>();
    state.modelGate = release.promise;
    state.failModel = failed;
    try {
      await screen.getByRole("combobox", /Model: Default model/).click();
      await screen
        .getByRole("option", "Alternate model", { exact: true })
        .click();
      await expect(task).toBeDisabled();
      expect(state.runs).toHaveLength(1);
      release.resolve();
      await expect(task).toBeEnabled();
      expect(state.runs).toHaveLength(1);
      if (!failed) {
        await task.click();
        await expect.poll(() => state.runs.length).toBe(2);
        expect(state.runModels[1]).toBe("alternate-model");
      } else expect(state.saved.model).toBeNull();
    } finally {
      release.resolve();
    }
  });
}

test("a failed in-conversation starter turn reports its error once in the transcript", async ({
  app,
  browser,
  screen,
}) => {
  const state = await serveStarts(browser);
  await app.open("/");
  await screen
    .getByRole("button", "Chart Hacker News", { exact: true })
    .click();
  await expect.poll(() => state.runs.length).toBe(1);
  const task = screen.getByRole("button", "Triage my inbox", { exact: true });
  await expect(task).toBeEnabled();
  state.failRun = true;
  await task.click();
  await expect(
    screen.getByText("Starter task failed once", { exact: true }),
  ).toHaveCount(1);
  await expect(task).toBeEnabled();
  await expect(
    screen
      .getByRole("region", "Starter tasks", { exact: true })
      .getByRole("alert"),
  ).toHaveCount(0);
});
