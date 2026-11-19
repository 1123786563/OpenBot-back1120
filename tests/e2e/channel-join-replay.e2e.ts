import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { notRun } from "../../shared/approval-outcomes";
import {
  chatEventStream,
  chatRunPath,
  configureChatStream,
  readChatRun,
} from "./chat-stream";
import { createConversation, readThreadId } from "./conversations";
import {
  ASKED_SO_FAR,
  ASKED_TEXT,
  ASKING_TEXT,
  askPersonReplayEnd,
  askPersonReplayStart,
  askPersonStored,
} from "./fixtures/ask-person-replay";
import {
  ANSWER_TEXT,
  ANSWERED_EARLY,
  answerOf,
  LOOKUPS,
  lookupsReplayEnd,
  lookupsReplayStart,
  lookupsStored,
} from "./fixtures/parallel-lookups";
import { createBot } from "./signed-in";

type Send = (event: string, payload: unknown) => void;
type Frame = [string | null, string | null, string, string, unknown];

function replay(send: Send, events: readonly unknown[], offset = 0) {
  for (const [index, event] of events.entries()) {
    send("ag_ui_event", {
      ...(event as Record<string, unknown>),
      metadata: { cpki_event_id: `event-${offset + index}` },
    });
  }
  return { latestEventId: `event-${offset + events.length - 1}` };
}

async function startGateway(
  browser: Browser,
  threadId: string,
  read: () => unknown[],
  joined: (send: Send, join: number) => Promise<void>,
) {
  const topic = `thread:${threadId}`;
  let joins = 0;
  let reads = 0;
  const faults: string[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request, { data: undefined })
        ? undefined
        : new Response("Expected a WebSocket upgrade", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const [joinRef, ref, requestedTopic, event] = JSON.parse(
          String(message),
        ) as Frame;
        socket.send(
          JSON.stringify([
            joinRef,
            ref,
            requestedTopic,
            "phx_reply",
            { status: "ok", response: {} },
          ]),
        );
        if (event !== "phx_join" || requestedTopic !== topic) return;
        joins++;
        const send: Send = (name, payload) => {
          if (socket.readyState === 1)
            socket.send(JSON.stringify([joinRef, null, topic, name, payload]));
        };
        void joined(send, joins).catch((error) => faults.push(String(error)));
      },
    },
  });
  const socket = `ws://127.0.0.1:${gateway.port}/client`;
  try {
    await browser.route(/\/api\/copilotkit\/info$/, async (route) => {
      const data = await (await route.fetch()).json<Record<string, unknown>>();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...data,
          mode: "intelligence",
          intelligence: { wsUrl: socket },
          telemetryDisabled: true,
        }),
      });
    });
    await browser.route(
      /\/api\/copilotkit\/agent\/[^/]+\/connect$/,
      (route) => {
        const { threadId: requested } = readChatRun(route.request.postData);
        expect(requested).toBe(threadId);
        return route.fulfill({
          json: {
            threadId,
            runId: null,
            joinToken: "fixture-token",
            realtime: { clientUrl: socket, topic },
          },
        });
      },
    );
    await browser.route(
      new RegExp(
        `/api/copilotkit/threads/${RegExp.escape(threadId)}/messages\\?`,
      ),
      (route) => {
        reads++;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ messages: read() }),
        });
      },
    );
  } catch (error) {
    gateway.stop(true);
    throw error;
  }
  return {
    joins: () => joins,
    historyReads: () => reads,
    faults,
    [Symbol.dispose]() {
      gateway.stop(true);
    },
  };
}

async function postChannelSignal(
  browser: Browser,
  channelId: string,
  route: "activity" | "busy",
  value: Record<string, boolean | string>,
) {
  const status = await browser.evaluate(
    async ({ channelId, route, value }) =>
      (
        await fetch(`/api/channels/${encodeURIComponent(channelId)}/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value),
        })
      ).status,
    { channelId, route, value },
  );
  expect(status).toBe(204);
}

for (const when of [
  "during join",
  "while answering",
  "after returning",
] as const) {
  test(`Intelligence replays the Bot's reply once and whole ${when}`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(
      browser,
      bot.id,
      "Ask about apples",
    );
    const thread = await readThreadId(browser, channel);
    const start = askPersonReplayStart(thread);
    const end = askPersonReplayEnd(thread);
    const release = Promise.withResolvers<void>();
    const fullAtJoin = when === "during join";
    using gateway = await startGateway(
      browser,
      thread,
      () => askPersonStored("asked", fullAtJoin ? ASKED_TEXT : ASKED_SO_FAR),
      async (send, join) => {
        if (fullAtJoin) {
          await release.promise;
          const last = replay(send, [...start, ...end]);
          send("replay_complete", last);
          send("stream_idle", last);
          return;
        }
        send("replay_complete", replay(send, start));
        if (when === "after returning" && join === 1) return;
        // The live reply arrives after the app's bounded initial join wait.
        await Bun.sleep(1_700);
        await release.promise;
        send("stream_idle", replay(send, end, start.length));
      },
    );
    const announce = () =>
      postChannelSignal(browser, channel, "activity", {
        agentId: bot.id,
        text: "A question needs your answer: Which colour of apple do you prefer?",
        at: new Date().toISOString(),
      });

    const path = `/channel/${channel}`;
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    try {
      await app.open(path);
      await expect.poll(gateway.joins).toBe(1);
      if (when === "after returning") {
        await expect(
          transcript.getByText(ASKED_SO_FAR, { exact: true }),
        ).toBeVisible();
        await screen.getByRole("link", "OpenBot", { exact: true }).tap();
        await expect(browser).toHaveURL(new URL("/", app.baseUrl).href);
        await browser
          .locator(`[data-sidebar="content"] a[href="${path}"]`)
          .tap();
        await expect.poll(gateway.joins).toBe(2);
        await announce();
      } else if (fullAtJoin) {
        await announce();
      } else {
        await expect(
          transcript.getByText(ASKED_SO_FAR, { exact: true }),
        ).toBeVisible();
      }
      release.resolve();
      await expect(
        transcript.getByText(ASKED_TEXT, { exact: true }),
      ).toBeVisible();
      await expect(
        transcript.getByText(ASKED_TEXT, { exact: true }),
      ).toHaveCount(1);
      await expect(
        transcript.getByText(ASKING_TEXT, { exact: true }),
      ).toHaveCount(1);
      await expect(
        transcript.getByText(ASKED_SO_FAR, { exact: true }),
      ).toHaveCount(0);
      await expect.poll(gateway.historyReads).toBeGreaterThan(0);
      expect(gateway.faults).toEqual([]);
    } finally {
      release.resolve();
    }
  });
}

function lookupAnswers(messages: unknown[]) {
  return new Map(
    messages.flatMap((message) =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "tool" &&
      "toolCallId" in message &&
      typeof message.toolCallId === "string" &&
      "content" in message
        ? [[message.toolCallId, message.content] as const]
        : [],
    ),
  );
}

test("late join replay preserves all twenty lookup results in the next run", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(
    browser,
    bot.id,
    "Planning the cycle",
  );
  const thread = await readThreadId(browser, channel);
  let busy = true;
  await browser.route(/\/api\/channels(?:\?|$)/, async (route) => {
    const data = await (await route.fetch()).json<{
      channels: (Record<string, unknown> & { id: string })[];
    }>();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...data,
        channels: data.channels.map((row) =>
          row.id === channel ? { ...row, busy } : row,
        ),
      }),
    });
  });
  const start = lookupsReplayStart(thread);
  const end = lookupsReplayEnd(thread);
  using gateway = await startGateway(
    browser,
    thread,
    () => lookupsStored("asked", ANSWERED_EARLY),
    async (send) => {
      // The first admissible replay takes longer than the initial join wait.
      await Bun.sleep(2_000);
      send("replay_complete", replay(send, start));
      await Bun.sleep(500);
      send("stream_idle", replay(send, end, start.length));
    },
  );
  const runs: unknown[][] = [];
  await browser.route(chatRunPath, (route) => {
    const input = readChatRun(route.request.postData);
    expect(input.threadId).toBe(thread);
    runs.push(input.messages);
    return route.fulfill({
      status: 503,
      json: { error: "End of the replay fixture." },
    });
  });

  await app.open(`/channel/${channel}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(transcript.getByText(ANSWER_TEXT, { exact: true })).toHaveCount(
    1,
  );
  busy = false;
  await postChannelSignal(browser, channel, "busy", { busy: false });
  await screen
    .getByRole("textbox", "Message", { exact: true })
    .fill("Show the original lookup answers.");
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect.poll(() => runs.length).toBe(1);
  const results = lookupAnswers(runs[0] ?? []);
  expect(LOOKUPS.map(({ id }) => results.get(id))).toEqual(
    LOOKUPS.map((_, index) => answerOf(index)),
  );
  expect(gateway.faults).toEqual([]);
});

for (const stored of ["complete", "incomplete"] as const) {
  test(`sending with a lookup archive that is ${stored} uses saved answers before marking any as missing`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(browser, bot.id, "Cycle planning");
    const thread = await readThreadId(browser, channel);
    let available = ANSWERED_EARLY;
    await configureChatStream(
      browser,
      lookupsStored("asked", ANSWERED_EARLY),
      async () => lookupsStored("asked", available),
    );
    const requests: unknown[][] = [];
    await browser.route(chatRunPath, (route) => {
      const input = readChatRun(route.request.postData);
      expect(input.threadId).toBe(thread);
      requests.push(input.messages);
      return route.fulfill(
        chatEventStream([
          { type: "RUN_STARTED", threadId: thread, runId: input.runId },
          { type: "RUN_FINISHED", threadId: thread, runId: input.runId },
        ]),
      );
    });

    await app.open(`/channel/${channel}`);
    const message = screen.getByRole("textbox", "Message", { exact: true });
    const question = "Carry on with the lookup results.";
    await message.fill(question);
    if (stored === "complete") available = LOOKUPS.length;
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await expect.poll(() => requests.length).toBe(1);
    const sent = requests[0] ?? [];
    const results = lookupAnswers(sent);
    const missing = notRun(
      "no result came back for this call before the conversation moved on.",
    );
    expect(LOOKUPS.map(({ id }) => results.get(id))).toEqual(
      LOOKUPS.map((_, index) =>
        index < available ? answerOf(index) : missing,
      ),
    );
    const callsAt = sent.findIndex(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "role" in entry &&
        entry.role === "assistant" &&
        "toolCalls" in entry &&
        Array.isArray(entry.toolCalls) &&
        entry.toolCalls.length === LOOKUPS.length,
    );
    expect(callsAt).toBeGreaterThanOrEqual(0);
    const answers = sent.slice(callsAt + 1, callsAt + 1 + LOOKUPS.length);
    expect(lookupAnswers(answers).size).toBe(LOOKUPS.length);
    expect(sent.at(-1)).toMatchObject({ role: "user", content: question });
  });
}
