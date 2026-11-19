import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  chatEventStream,
  chatRunPath,
  configureChatStream,
  readChatRun,
} from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";
import { stageChatRun } from "./staged-chat-stream";

const initial = { id: "initial", role: "user", content: "Earlier question." };
const storedReply = {
  id: "stored-answer",
  role: "assistant",
  content: "Fresh stored reply.",
};
const unavailable =
  "Couldn't load earlier messages. You can keep using this conversation.";
const oneHole =
  "One earlier message couldn't be read, so it isn't shown. Everything else is here.";

for (const storedCount of [1, 2]) {
  const restoredCount =
    storedCount === 1 ? "one stored reply" : "two stored replies";
  test(`restoration preserves the readable gateway tool result while adding ${restoredCount}`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(browser, bot.id);
    const toolCall = {
      id: "tool-call",
      role: "assistant",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: { name: "inspect", arguments: "{}" },
        },
      ],
    };
    const toolResult = {
      id: "tool-result",
      role: "tool",
      toolCallId: "call",
      content: "Readable gateway tool output",
    };
    const latest = {
      id: "latest",
      role: "assistant",
      content: "Latest durable reply.",
    };
    const later = storedCount === 1 ? [storedReply] : [storedReply, latest];
    const snapshot = [initial, toolCall, toolResult];
    const archive = Promise.withResolvers<readonly object[]>();
    await configureChatStream(browser, snapshot, () => archive.promise);
    const runs: { threadId: string; messages: unknown[] }[] = [];
    using stream = await stageChatRun(
      browser,
      ({ runId, threadId, messages }) => {
        runs.push({ threadId, messages });
        return [{ type: "RUN_STARTED", runId, threadId }];
      },
      ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
    );

    try {
      const detailsResponse = browser.waitForResponse(
        new RegExp(`/api/channels/${RegExp.escape(channel)}$`),
      );
      await app.open(`/channel/${channel}`);
      const {
        channel: { threadId },
      } = await (await detailsResponse).json<{
        channel: { threadId: string };
      }>();
      const loading = screen.getByRole("status", "Loading this conversation", {
        exact: true,
      });
      await expect(loading).toBeVisible();
      const next = "Continue restored conversation.";
      await screen.getByRole("textbox", "Message", { exact: true }).fill(next);
      await screen.getByRole("button", "Send message", { exact: true }).tap();
      await expect(loading).toBeVisible();
      expect(runs).toHaveLength(0);

      archive.resolve([
        initial,
        toolCall,
        { ...toolResult, content: { unsupported: "stored result shape" } },
        ...later,
      ]);
      const messages = screen.getByRole("region", "Messages", { exact: true });
      await expect(
        messages.getByText(initial.content, { exact: true }),
      ).toHaveCount(1);
      for (const reply of later) {
        await expect(
          messages.getByText(reply.content, { exact: true }),
        ).toBeVisible();
      }
      await expect(screen.getByText(oneHole, { exact: true })).toBeVisible();
      await expect(screen.getByText(unavailable, { exact: true })).toHaveCount(
        0,
      );
      await expect.poll(() => runs.length).toBe(1);
      const [run] = runs;
      expect(run.threadId).toBe(threadId);
      expect(run.messages.slice(0, -1)).toEqual([...snapshot, ...later]);
      expect(run.messages.at(-1)).toMatchObject({
        role: "user",
        content: next,
      });
      stream.finish();
      await expect(
        browser.locator('[data-testid="composer-stop"]'),
      ).toBeHidden();
    } finally {
      archive.resolve([]);
    }
  });
}

test("a stalled archive shows a notice and the waiting send uses the gateway snapshot", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const archive = Promise.withResolvers<void>();
  await configureChatStream(browser, [initial]);
  await browser.route(
    /\/api\/copilotkit\/threads\/[^/]+\/messages\?/,
    async (route) => {
      await archive.promise;
      await route.fulfill({ json: { messages: [initial, storedReply] } });
    },
  );
  const runs: unknown[][] = [];
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId, messages }) => {
      runs.push(messages);
      return [{ type: "RUN_STARTED", runId, threadId }];
    },
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );

  try {
    await app.open(`/channel/${channel}`);
    const loading = screen.getByRole("status", "Loading this conversation", {
      exact: true,
    });
    await expect(loading).toBeVisible();
    const question = "Send while history stalls.";
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill(question);
    await screen.getByRole("button", "Send message", { exact: true }).tap();

    await expect(screen.getByText(unavailable, { exact: true })).toBeVisible();
    const messages = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      messages.getByText(initial.content, { exact: true }),
    ).toBeVisible();
    await expect(messages.getByText(question, { exact: true })).toBeVisible();
    await expect.poll(() => runs.length).toBe(1);
    expect(runs[0].slice(0, -1)).toEqual([initial]);
    expect(runs[0].at(-1)).toMatchObject({ role: "user", content: question });

    archive.resolve();
    stream.finish();
    await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
    await expect(
      messages.getByText(storedReply.content, { exact: true }),
    ).toHaveCount(0);
  } finally {
    archive.resolve();
  }
});

for (const snapshot of [[], [initial]]) {
  test(`a failed archive read remains disclosed after sending with a ${snapshot.length ? "partial" : "blank"} snapshot`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(browser, bot.id);
    await configureChatStream(browser, snapshot);
    await browser.route(
      /\/api\/copilotkit\/threads\/[^/]+\/messages\?/,
      (route) => route.fulfill({ status: 500 }),
    );
    const requests: unknown[][] = [];
    using stream = await stageChatRun(
      browser,
      ({ runId, threadId, messages }) => {
        requests.push(messages);
        return [{ type: "RUN_STARTED", runId, threadId }];
      },
      ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
    );

    await app.open(`/channel/${channel}`);
    const notice = screen.getByText(unavailable, { exact: true });
    await expect(notice).toBeVisible();
    const messages = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      messages.getByText(initial.content, { exact: true }),
    ).toHaveCount(snapshot.length);
    const next = "Continue with the messages available.";
    await screen.getByRole("textbox", "Message", { exact: true }).fill(next);
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].slice(0, -1)).toEqual(snapshot);
    expect(requests[0].at(-1)).toMatchObject({ role: "user", content: next });
    stream.finish();
    await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
    await expect(messages.getByText(next, { exact: true })).toBeVisible();
    await expect(notice).toBeVisible();
    await expect(screen.getByText(/different CopilotKit project/)).toHaveCount(
      0,
    );
  });
}

function tripForm(version: "1.0" | "v1.0") {
  const surfaceId = "trip";
  const catalogId = "openbot/ui@1";
  return {
    id: "trip-interface",
    role: "activity",
    activityType: "generative-ui-surface",
    content: {
      surfaceId,
      target: "chat",
      catalogId,
      status: "ready",
      rejected: [],
      operations: [
        {
          version,
          createSurface: {
            surfaceId,
            catalogId,
            dataModel: { destination: "Paris" },
          },
        },
        {
          version,
          updateComponents: {
            surfaceId,
            components: [
              {
                id: "root",
                component: "Column",
                children: ["destination", "confirm"],
              },
              {
                id: "destination",
                component: "TextField",
                label: "Destination",
                value: { "@path": "/destination" },
              },
              {
                id: "confirm",
                component: "Button",
                label: "Confirm trip",
                onClick: {
                  event: {
                    name: "confirm_trip",
                    context: { destination: { "@path": "/destination" } },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };
}

const versions: readonly ("1.0" | "v1.0")[] = ["1.0", "v1.0"];
for (const version of versions) {
  test(`a restored ${version} form sends its action on the conversation thread and remains visible`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(browser, bot.id);
    const activity = tripForm(version);
    await configureChatStream(browser, [activity], async () => [activity]);
    const runs: { threadId: string; messages: unknown[]; payload: unknown }[] =
      [];
    await browser.route(chatRunPath, (route) => {
      const { runId, threadId, messages } = readChatRun(route.request.postData);
      runs.push({
        threadId,
        messages,
        payload: JSON.parse(route.request.postData ?? "null"),
      });
      const body = [
        { type: "RUN_STARTED", threadId, runId },
        { type: "RUN_FINISHED", threadId, runId },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      return route.fulfill({ contentType: "text/event-stream", body });
    });
    const detailsResponse = browser.waitForResponse(
      new RegExp(`/api/channels/${RegExp.escape(channel)}$`),
    );
    await app.open(`/channel/${channel}`);
    const {
      channel: { threadId },
    } = await (await detailsResponse).json<{ channel: { threadId: string } }>();
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    const destination = transcript.getByRole("textbox", "Destination", {
      exact: true,
    });
    await expect(destination).toHaveValue("Paris");
    const value = version === "1.0" ? "Kyoto" : "Paris";
    if (value !== "Paris") await destination.fill(value);
    await transcript.getByRole("button", "Confirm trip", { exact: true }).tap();

    await expect.poll(() => runs.length).toBe(1);
    const [run] = runs;
    expect(run.threadId).toBe(threadId);
    expect(run.messages.at(-1)).toMatchObject({
      role: "user",
      content: `Confirm trip\n\ndestination: ${value}`,
    });
    expect(run.payload).toMatchObject({
      forwardedProps: {
        copilotkit: {
          ui: {
            metadata: {
              extensions: {
                copilotkit_transport: "tool",
                copilotkit_action: {
                  action: {
                    name: "confirm_trip",
                    surfaceId: "trip",
                    sourceComponentId: "confirm",
                    context: { destination: value },
                  },
                },
              },
            },
          },
        },
      },
    });
    await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
    await expect(destination).toBeVisible();
    await expect(destination).toHaveValue(value);
  });
}

const historyPath = /\/api\/copilotkit\/threads\/[^/]+\/messages\?/;
const local = {
  id: "local-only",
  role: "user",
  content: "A newer local-only question.",
};
const broken = {
  id: "invalid-stored-turn",
  role: "assistant",
  content: { unsupported: true },
};

async function announceActivity(
  browser: Browser,
  activity: { channelId: string; agentId: string; text: string; at: string },
) {
  const status = await browser.evaluate(async ({ channelId, ...body }) => {
    const response = await fetch(
      `/api/channels/${encodeURIComponent(channelId)}/activity`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return response.status;
  }, activity);
  expect(status).toBe(204);
}

test("a Bot activity already in the roster retries stale history when the conversation opens", async (fixtures) => {
  const { browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(
    browser,
    bot.id,
    "Previously active conversation",
  );
  await configureChatStream(browser, [initial]);
  const reads: string[] = [];
  await browser.route(historyPath, (route) => {
    reads.push(new URL(route.request.url).pathname);
    return route.fulfill({
      json: { messages: reads.length < 3 ? [initial] : [initial, storedReply] },
    });
  });
  await announceActivity(browser, {
    channelId,
    agentId: bot.id,
    at: new Date().toISOString(),
    text: "The Bot finished before opening.",
  });
  const link = screen.getByRole("link", /Previously active conversation/);
  await expect(link).toContainText(/\bnow\b/);
  const detailsResponse = browser.waitForResponse(
    new RegExp(`/api/channels/${RegExp.escape(channelId)}$`),
  );
  await link.tap();
  const {
    channel: { threadId },
  } = await (await detailsResponse).json<{ channel: { threadId: string } }>();
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    transcript.getByText(storedReply.content, { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText(initial.content, { exact: true }),
  ).toHaveCount(1);
  await expect(screen.getByText(unavailable, { exact: true })).toHaveCount(0);
  expect(reads).toEqual(
    Array.from(
      { length: 3 },
      () => `/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages`,
    ),
  );
});

test("Bot activity retries stale history and then replaces failed-read notices when storage recovers", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(browser, bot.id);
  await configureChatStream(browser, [initial, local]);
  let archive: () => {
    status: number;
    json: { messages: (typeof initial | typeof broken)[] };
  } = () => ({ status: 200, json: { messages: [initial] } });
  let reads = 0;
  await browser.route(historyPath, (route) => {
    reads++;
    return route.fulfill(archive());
  });

  await app.open(`/channel/${channelId}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    transcript.getByText(local.content, { exact: true }),
  ).toBeVisible();
  expect(reads).toBe(1);

  const now = Date.now();
  const announce = (text: string, sequence: number) =>
    announceActivity(browser, {
      channelId,
      agentId: bot.id,
      at: new Date(now + sequence).toISOString(),
      text,
    });
  archive = () => ({
    status: 200,
    json: {
      messages: reads === 2 ? [initial] : [initial, storedReply, broken],
    },
  });
  await announce("The Bot has a fresh reply.", 1);
  await expect(
    transcript.getByText(storedReply.content, { exact: true }),
  ).toBeVisible();
  const unreadable = screen.getByText(oneHole, { exact: true });
  const failure = screen.getByText(unavailable, { exact: true });
  await expect(unreadable).toBeVisible();
  await expect(failure).toHaveCount(0);
  expect(reads).toBe(3);

  archive = () => ({ status: 500, json: { messages: [] } });
  await announce("The archive is being repaired.", 2);
  await expect(failure).toBeVisible();
  await expect(unreadable).toHaveCount(0);
  expect(reads).toBe(6);

  archive = () => ({ status: 200, json: { messages: [initial, storedReply] } });
  await announce("The archive is readable again.", 3);
  await expect(failure).toHaveCount(0);
  await expect(unreadable).toHaveCount(0);
  for (const message of [initial, local, storedReply]) {
    await expect(
      transcript.getByText(message.content, { exact: true }),
    ).toHaveCount(1);
  }
});

for (const unreadableOnly of [false, true]) {
  test(`later unavailable retries preserve messages and the archive notice (unreadable-only=${unreadableOnly})`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channelId = await createConversation(browser, bot.id);
    await configureChatStream(browser, [initial, local]);
    let reads = 0;
    const lastRetry = Promise.withResolvers<void>();
    await browser.route(historyPath, async (route) => {
      reads++;
      if (reads === 4) await lastRetry.promise;
      if (reads > 2)
        return route.fulfill({ status: 500, json: { messages: [] } });
      return route.fulfill({
        json: {
          messages:
            reads === 1
              ? [initial]
              : unreadableOnly
                ? [broken]
                : [initial, broken],
        },
      });
    });
    await app.open(`/channel/${channelId}`);
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      transcript.getByText(local.content, { exact: true }),
    ).toBeVisible();
    expect(reads).toBe(1);
    try {
      await announceActivity(browser, {
        channelId,
        agentId: bot.id,
        at: new Date().toISOString(),
        text: "The Bot updated the conversation.",
      });
      await expect(screen.getByText(oneHole, { exact: true })).toBeVisible();
      await expect.poll(() => reads).toBe(4);
      const response = browser.waitForResponse(historyPath);
      lastRetry.resolve();
      expect(await (await response).json()).toEqual({ messages: [] });
    } finally {
      lastRetry.resolve();
    }
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("The retries have finished.");
    await expect(screen.getByText(unavailable, { exact: true })).toHaveCount(0);
    await expect(screen.getByText(oneHole, { exact: true })).toBeVisible();
    for (const message of [initial, local]) {
      await expect(
        transcript.getByText(message.content, { exact: true }),
      ).toHaveCount(1);
    }
  });
}

for (const prefixPresent of [false, true]) {
  test(`archive recovery restores order after sending (known prefix=${prefixPresent})`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channelId = await createConversation(browser, bot.id);
    await configureChatStream(browser, []);
    const runs: ReturnType<typeof readChatRun>[] = [];
    let recovered: unknown[] | undefined;
    await browser.route(historyPath, (route) =>
      route.fulfill(
        recovered || prefixPresent
          ? {
              contentType: "application/json",
              body: JSON.stringify({ messages: recovered ?? [initial] }),
            }
          : { status: 500, json: { messages: [] } },
      ),
    );
    await browser.route(chatRunPath, (route) => {
      const run = readChatRun(route.request.postData);
      runs.push(run);
      const { threadId, runId } = run;
      return route.fulfill(
        chatEventStream([
          { type: "RUN_STARTED", threadId, runId },
          { type: "RUN_FINISHED", threadId, runId },
        ]),
      );
    });
    await app.open(`/channel/${channelId}`);
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      screen.getByText(prefixPresent ? initial.content : unavailable, {
        exact: true,
      }),
    ).toBeVisible();
    const prompt = "Local turn after opening the conversation.";
    const editor = screen.getByRole("textbox", "Message", { exact: true });
    const send = screen.getByRole("button", "Send message", { exact: true });
    await editor.fill(prompt);
    await send.click();
    await expect.poll(() => runs.length).toBe(1);
    const sent = runs[0].messages.at(-1);
    expect(sent).toMatchObject({ role: "user", content: prompt });
    recovered = [initial, sent, storedReply];
    await announceActivity(browser, {
      channelId,
      agentId: bot.id,
      at: new Date().toISOString(),
      text: storedReply.content,
    });
    for (const content of [initial.content, prompt, storedReply.content]) {
      await expect(transcript.getByText(content, { exact: true })).toHaveCount(
        1,
      );
    }
    const text = await transcript.textContent();
    expect(text?.indexOf(initial.content)).toBeLessThan(
      text?.indexOf(prompt) ?? -1,
    );
    expect(text?.indexOf(prompt)).toBeLessThan(
      text?.indexOf(storedReply.content) ?? -1,
    );
    await expect(screen.getByText(unavailable, { exact: true })).toHaveCount(0);
    await editor.fill("Capture restored ordering.");
    await send.click();
    await expect.poll(() => runs.length).toBe(2);
    expect(runs[1].threadId).toBe(runs[0].threadId);
    expect(runs[1].messages.slice(0, 3)).toEqual(recovered);
  });
}

for (const phase of ["opening", "refresh"]) {
  for (const anchored of [true, false]) {
    test(`archive ${phase} preserves local messages with shared IDs=${anchored}`, async (fixtures) => {
      const { app, browser, screen } = fixtures;
      const bot = await createBot(fixtures);
      const channelId = await createConversation(browser, bot.id);
      const localReply = { ...storedReply, content: "Current local reply." };
      const prefix = {
        id: "missing-prefix",
        role: "assistant",
        content: "Recovered archive prefix.",
      };
      const tail = {
        id: "missing-tail",
        role: "assistant",
        content: "Recovered archive tail.",
      };
      const local = [initial, localReply];
      const stored = anchored
        ? [
            prefix,
            { ...initial, content: "Stale opening text." },
            { ...storedReply, content: "Stale answer text." },
            tail,
            tail,
          ]
        : [tail, tail];
      const expected = anchored ? [prefix, ...local, tail] : [...local, tail];
      let archive = phase === "opening" ? stored : [];
      await configureChatStream(browser, local, async () => archive);
      const runs: ReturnType<typeof readChatRun>[] = [];
      await browser.route(chatRunPath, (route) => {
        const run = readChatRun(route.request.postData);
        runs.push(run);
        const { threadId, runId } = run;
        return route.fulfill(
          chatEventStream([
            { type: "RUN_STARTED", threadId, runId },
            { type: "RUN_FINISHED", threadId, runId },
          ]),
        );
      });
      await app.open(`/channel/${channelId}`);
      const transcript = screen.getByRole("region", "Messages", {
        exact: true,
      });
      await expect(
        transcript.getByText(localReply.content, { exact: true }),
      ).toBeVisible();
      if (phase === "refresh") {
        archive = stored;
        await announceActivity(browser, {
          channelId,
          agentId: bot.id,
          text: tail.content,
          at: new Date().toISOString(),
        });
      }
      await expect(
        transcript.getByText(tail.content, { exact: true }),
      ).toBeVisible();
      for (const { content } of expected) {
        await expect(
          transcript.getByText(content, { exact: true }),
        ).toHaveCount(1);
      }
      await expect(transcript.getByText(/^Stale /)).toHaveCount(0);
      await screen
        .getByRole("textbox", "Message", { exact: true })
        .fill("Continue with the restored messages.");
      await screen.getByRole("button", "Send message", { exact: true }).tap();
      await expect.poll(() => runs.length).toBe(1);
      expect(runs[0].messages.slice(0, -1)).toEqual(expected);
    });
  }
}

test("an older in-flight history response cannot overwrite a newer notification", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(browser, bot.id);
  await configureChatStream(browser, [initial]);
  const obsolete = {
    id: "obsolete",
    role: "assistant",
    content: "A superseded stored reply.",
  };
  const releaseOld = Promise.withResolvers<void>();
  let reads = 0;
  await browser.route(historyPath, async (route) => {
    reads++;
    if (reads === 1) return route.fulfill({ json: { messages: [initial] } });
    if (reads === 2) {
      await releaseOld.promise;
      return route.fulfill({ json: { messages: [initial, obsolete] } });
    }
    await route.fulfill({ json: { messages: [initial, storedReply, broken] } });
  });

  try {
    await app.open(`/channel/${channelId}`);
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      transcript.getByText(initial.content, { exact: true }),
    ).toBeVisible();
    const now = Date.now();
    await announceActivity(browser, {
      channelId,
      agentId: bot.id,
      at: new Date(now).toISOString(),
      text: "First archive update.",
    });
    await expect.poll(() => reads).toBe(2);
    await announceActivity(browser, {
      channelId,
      agentId: bot.id,
      at: new Date(now + 1).toISOString(),
      text: "Second archive update.",
    });
    await expect(
      transcript.getByText(storedReply.content, { exact: true }),
    ).toBeVisible();
    const notice = screen.getByText(oneHole, { exact: true });
    await expect(notice).toBeVisible();

    const settled = browser.waitForResponse(historyPath);
    releaseOld.resolve();
    const reply = await settled;
    expect(await reply.json()).toEqual({ messages: [initial, obsolete] });
    const editor = screen.getByRole("textbox", "Message", { exact: true });
    await editor.fill("The old response has returned.");
    await expect(
      transcript.getByText(obsolete.content, { exact: true }),
    ).toHaveCount(0);
    await expect(
      transcript.getByText(storedReply.content, { exact: true }),
    ).toHaveCount(1);
    await expect(notice).toBeVisible();
    expect(reads).toBe(3);
  } finally {
    releaseOld.resolve();
  }
});

for (const outcome of ["unavailable", "unreadable", "readable"]) {
  test(`a delayed ${outcome} opening archive cannot replace a newer refresh`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channelId = await createConversation(browser, bot.id);
    await configureChatStream(browser, [initial]);
    const obsolete = {
      ...storedReply,
      id: "obsolete-opening",
      content: "Obsolete opening reply.",
    };
    const stale = {
      status: outcome === "unavailable" ? 500 : 200,
      json: {
        messages:
          outcome === "unreadable"
            ? [broken, { ...broken, id: "second-hole" }]
            : outcome === "readable"
              ? [initial, obsolete]
              : [],
      },
    };
    await browser.addInitScript(({ status, json }) => {
      const fetchLive = window.fetch.bind(window);
      const schedule = window.setTimeout.bind(window);
      let opening = true;
      let extendDeadline = false;
      Object.defineProperty(window, "fetch", {
        configurable: true,
        value: (input: RequestInfo | URL, init?: RequestInit) => {
          if (!opening || !String(input).includes("/messages?agentId=")) {
            return fetchLive(input, init);
          }
          opening = false;
          extendDeadline = true;
          return new Promise<Response>((resolve) => {
            document.documentElement.dataset.openingArchive = "pending";
            window.addEventListener(
              "release-opening-archive",
              () => {
                resolve(Response.json(json, { status }));
              },
              { once: true },
            );
          });
        },
      });
      Object.defineProperty(window, "setTimeout", {
        configurable: true,
        value: (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
          if (extendDeadline && delay === 1500) {
            extendDeadline = false;
            return schedule(handler, 60_000, ...args);
          }
          return schedule(handler, delay, ...args);
        },
      });
    }, stale);
    await browser.route(historyPath, (route) =>
      route.fulfill({
        json: { messages: [initial, storedReply, broken] },
      }),
    );
    await app.open(`/channel/${channelId}`);
    await expect(browser.locator("html")).toHaveAttribute(
      "data-opening-archive",
      "pending",
    );
    await announceActivity(browser, {
      channelId,
      agentId: bot.id,
      at: new Date().toISOString(),
      text: storedReply.content,
    });
    const transcript = screen.getByRole("region", "Messages", {
      exact: true,
    });
    const notice = screen.getByText(oneHole, { exact: true });
    const latest = transcript.getByText(storedReply.content, { exact: true });
    await expect(latest).toBeVisible();
    await expect(notice).toBeVisible();
    await browser.evaluate(
      () =>
        new Promise<null>((resolve) => {
          window.dispatchEvent(new Event("release-opening-archive"));
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(null)),
          );
        }),
    );
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("The opening read has returned.");
    await expect(notice).toBeVisible();
    await expect(latest).toHaveCount(1);
    await expect(
      transcript.getByText(obsolete.content, { exact: true }),
    ).toHaveCount(0);
    await expect(screen.getByText(unavailable, { exact: true })).toHaveCount(0);
  });
}

test("switching conversations keeps a late archive response out of the new transcript", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(
    browser,
    bot.id,
    "First conversation",
  );
  const otherId = await createConversation(
    browser,
    bot.id,
    "Second conversation",
  );
  const nextReply = {
    id: "other-reply",
    role: "assistant",
    content: "Reply in the second conversation.",
  };
  const obsolete = {
    id: "other-obsolete",
    role: "assistant",
    content: "Late response from the first conversation.",
  };
  await configureChatStream(browser, []);
  const releaseOld = Promise.withResolvers<void>();
  const oldStarted = Promise.withResolvers<string>();
  let firstPath: string | undefined;
  await browser.route(historyPath, async (route) => {
    const path = new URL(route.request.url).pathname;
    if (firstPath === undefined) {
      firstPath = path;
      return route.fulfill({ json: { messages: [initial] } });
    }
    if (path !== firstPath) {
      return route.fulfill({ json: { messages: [nextReply, broken] } });
    }
    oldStarted.resolve(path);
    await releaseOld.promise;
    await route.fulfill({ json: { messages: [initial, obsolete] } });
  });

  try {
    await app.open(`/channel/${channelId}`);
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      transcript.getByText(initial.content, { exact: true }),
    ).toBeVisible();
    await announceActivity(browser, {
      channelId,
      agentId: bot.id,
      at: new Date().toISOString(),
      text: "The first conversation has an update.",
    });
    const stalePath = await oldStarted.promise;
    await screen.getByRole("link", /Second conversation/).tap();
    await expect(browser).toHaveURL(
      new RegExp(`/channel/${RegExp.escape(otherId)}$`),
    );
    await expect(
      transcript.getByText(nextReply.content, { exact: true }),
    ).toBeVisible();
    const notice = screen.getByText(oneHole, { exact: true });
    await expect(notice).toBeVisible();

    const settled = browser.waitForResponse(
      new RegExp(`${RegExp.escape(stalePath)}\\?`),
    );
    releaseOld.resolve();
    expect(await (await settled).json()).toEqual({
      messages: [initial, obsolete],
    });
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("Continue here.");
    await expect(
      transcript.getByText(obsolete.content, { exact: true }),
    ).toHaveCount(0);
    await expect(
      transcript.getByText(initial.content, { exact: true }),
    ).toHaveCount(0);
    await expect(
      transcript.getByText(nextReply.content, { exact: true }),
    ).toHaveCount(1);
    await expect(notice).toBeVisible();
  } finally {
    releaseOld.resolve();
  }
});

test("a live answer is announced once and an empty follow-up does not report it or restore a stale copy", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(
    browser,
    bot.id,
    "Live answer conversation",
  );
  const full = "The live answer includes every detail.";
  const partial = "The live answer includes";
  const followUp = "Ask for the silent follow-up.";
  await configureChatStream(browser, [initial]);
  let reads = 0;
  await browser.route(historyPath, (route) => {
    reads++;
    return route.fulfill({
      json: {
        messages:
          reads === 1
            ? [initial]
            : [
                initial,
                { id: "stale-partial", role: "assistant", content: partial },
              ],
      },
    });
  });
  const reportedAnswers: unknown[] = [];
  await browser.route(
    new RegExp(`/api/channels/${RegExp.escape(channelId)}/activity$`),
    async (route) => {
      const response = await route.fetch();
      expect(response.status).toBe(204);
      const payload: unknown = JSON.parse(route.request.postData ?? "null");
      if (
        payload &&
        typeof payload === "object" &&
        "agentId" in payload &&
        payload.agentId !== null
      ) {
        reportedAnswers.push(payload);
      }
      await route.fulfill({ status: response.status });
    },
  );

  let runCount = 0;
  await browser.route(chatRunPath, (route) => {
    const { runId, threadId } = readChatRun(route.request.postData);
    const replyEvents =
      ++runCount === 1
        ? [
            {
              type: "TEXT_MESSAGE_START",
              messageId: "live-answer",
              role: "assistant",
            },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "live-answer",
              delta: full,
            },
            { type: "TEXT_MESSAGE_END", messageId: "live-answer" },
          ]
        : [];
    const events = [
      { type: "RUN_STARTED", threadId, runId },
      ...replyEvents,
      { type: "RUN_FINISHED", threadId, runId },
    ];
    return route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });

  await app.open(`/channel/${channelId}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    transcript.getByText(initial.content, { exact: true }),
  ).toBeVisible();
  const editor = screen.getByRole("textbox", "Message", { exact: true });
  const send = screen.getByRole("button", "Send message", { exact: true });
  await editor.fill("Ask for the live answer.");
  await send.tap();
  await expect(transcript.getByText(full, { exact: true })).toBeVisible();
  await expect
    .poll(() => reportedAnswers)
    .toMatchObject([{ agentId: bot.id, text: full }]);

  await editor.fill(followUp);
  await send.tap();
  await expect.poll(() => runCount).toBe(2);
  await expect(transcript.getByText(followUp, { exact: true })).toBeVisible();
  await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
  await expect(transcript.getByText(full, { exact: true })).toHaveCount(1);
  await expect(transcript.getByText(partial, { exact: true })).toHaveCount(0);
  expect(reportedAnswers).toHaveLength(1);
  expect(reads).toBe(1);
});

for (const variant of ["timestamp", "text", "bot", "bot and text"]) {
  test(`an activity with different ${variant} refreshes history after a live reply`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channelId = await createConversation(browser, bot.id);
    const reply = "The Bot answered live.";
    let reads = 0;
    let archive = [initial];
    await browser.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (new URL(this.url).pathname !== "/api/channels/events") return;
          window.addEventListener("openbot-e2e-roster-activity", (event) => {
            if (
              event instanceof CustomEvent &&
              this.readyState === NativeSocket.OPEN
            ) {
              this.dispatchEvent(
                new MessageEvent("message", {
                  data: JSON.stringify(event.detail),
                }),
              );
            }
          });
        }
      };
    });
    await configureChatStream(browser, [initial], async () => {
      reads++;
      return archive;
    });
    const reported = Promise.withResolvers<{
      agentId: string;
      text: string;
      at: string;
    }>();
    await browser.route(
      new RegExp(`/api/channels/${RegExp.escape(channelId)}/activity$`),
      async (route) => {
        const response = await route.fetch();
        const payload: unknown = JSON.parse(route.request.postData ?? "null");
        if (
          payload &&
          typeof payload === "object" &&
          "agentId" in payload &&
          payload.agentId === bot.id &&
          "text" in payload &&
          payload.text === reply &&
          "at" in payload &&
          typeof payload.at === "string"
        ) {
          expect(response.status).toBe(204);
          reported.resolve({ agentId: bot.id, text: reply, at: payload.at });
        }
        await route.fulfill({ status: response.status });
      },
    );
    await browser.route(chatRunPath, (route) => {
      const { runId, threadId } = readChatRun(route.request.postData);
      return route.fulfill(
        chatEventStream([
          { type: "RUN_STARTED", threadId, runId },
          {
            type: "TEXT_MESSAGE_START",
            messageId: "relay-live",
            role: "assistant",
          },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "relay-live",
            delta: reply,
          },
          { type: "TEXT_MESSAGE_END", messageId: "relay-live" },
          { type: "RUN_FINISHED", threadId, runId },
        ]),
      );
    });

    await app.open(`/channel/${channelId}`);
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      transcript.getByText(initial.content, { exact: true }),
    ).toBeVisible();
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("Ask before the relay.");
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await expect(transcript.getByText(reply, { exact: true })).toBeVisible();
    const self = await reported.promise;
    expect(reads).toBe(1);

    archive = [initial, storedReply];
    await browser.evaluate(
      (detail) => {
        window.dispatchEvent(
          new CustomEvent("openbot-e2e-roster-activity", { detail }),
        );
        return null;
      },
      {
        channelId,
        lastMessageAgentId: variant.includes("bot")
          ? "relay-bot"
          : self.agentId,
        lastMessage: variant.includes("text")
          ? "A different activity."
          : self.text,
        lastMessageAt:
          variant === "timestamp"
            ? new Date(Date.parse(self.at) + 1_000).toISOString()
            : self.at,
      },
    );
    await expect(
      transcript.getByText(storedReply.content, { exact: true }),
    ).toBeVisible();
    await expect(transcript.getByText(reply, { exact: true })).toHaveCount(1);
    expect(reads).toBe(2);
  });
}

test("the sidebar replaces the conversation time with Working until the Bot finishes", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(browser, bot.id, "Plan the trip");
  await configureChatStream(browser, [
    initial,
    { id: "plan-seed", role: "assistant", content: "An earlier itinerary." },
  ]);
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId }) => [{ type: "RUN_STARTED", runId, threadId }],
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );
  await app.open(`/channel/${channelId}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    transcript.getByText(initial.content, { exact: true }),
  ).toBeVisible();
  await announceActivity(browser, {
    channelId,
    agentId: bot.id,
    at: new Date(Date.now() - 120_000).toISOString(),
    text: "An earlier itinerary.",
  });

  const row = screen.getByRole("link", /Plan the trip/);
  await expect(row.getByText("2m", { exact: true })).toBeVisible();
  const update = "Update the itinerary.";
  await screen.getByRole("textbox", "Message", { exact: true }).fill(update);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect(transcript.getByText(update, { exact: true })).toBeVisible();
  await expect(row.getByText("Working", { exact: true })).toBeVisible();
  await expect(row.getByText(/^(2m|now)$/)).toHaveCount(0);

  stream.finish();
  await expect(row.getByText("Working", { exact: true })).toHaveCount(0);
  await expect(row.getByText("now", { exact: true })).toBeVisible();
});

for (const malformed of [false, true]) {
  test(`a ${malformed ? "malformed" : "valid empty"} archive for a previously used conversation ${malformed ? "shows a recovery notice" : "loads without a warning"}`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/");
    const channel = await createConversation(browser, "general-assistant");
    const detail = new RegExp(`/api/channels/${RegExp.escape(channel)}$`);
    await browser.route(detail, async (route) => {
      const response = await route.fetch();
      const { channel } = await response.json<{
        channel: Record<string, unknown>;
      }>();
      return route.fulfill({
        json: {
          channel: { ...channel, lastMessageAt: new Date().toISOString() },
        },
      });
    });
    await configureChatStream(browser, "");
    await browser.route(
      /\/api\/copilotkit\/threads\/[^/]+\/messages\?/,
      (route) =>
        route.fulfill({ json: { messages: malformed ? "not an array" : [] } }),
    );
    const archive = browser.waitForResponse(
      /\/api\/copilotkit\/threads\/[^/]+\/messages\?/,
    );
    await app.open(`/channel/${channel}`);
    await archive;
    await expect(
      screen.getByRole("region", "Messages", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("status", "Loading this conversation", { exact: true }),
    ).toHaveCount(0);
    const warning = screen.getByText(unavailable, { exact: true });
    if (malformed) await expect(warning).toBeVisible();
    else await expect(warning).toHaveCount(0);
    await expect(
      screen.getByText(/different CopilotKit project|fresh history/),
    ).toHaveCount(0);
  });
}
