import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { connectAppRefusal } from "../../shared/connect-prompt";
import {
  chatEventStream,
  chatRunPath,
  configureChatStream,
  readChatRun,
} from "./chat-stream";
import { createConversation, readThreadId } from "./conversations";
import { createBot } from "./signed-in";

const serverId = "srv_notion";
const question = "Find the latest notes in Notion.";
const explanation =
  "You have not connected your Notion account. Connect it and ask again.";
const refusal = "That account could not be connected.";
const consent = "/test-notion-chat-consent";
const settings = `/connections/${serverId}`;
const continuation = "Notion is ready now. Please carry on.";
const reply = "I found the latest Notion notes.";

type Fixtures = Parameters<typeof createBot>[0];
type AccountRow = {
  serverId: string;
  holder: "person" | "deployment";
  revoked?: boolean;
};
type ConnectAnswer = "consent" | "fields" | "failure" | "connected";

type ConnectionFixture = {
  accounts?: AccountRow[];
  answer?: (attempt: number) => ConnectAnswer | Promise<ConnectAnswer>;
  blockPopup?: boolean;
};

async function serveConnection(browser: Browser, options: ConnectionFixture) {
  let accounts = options.accounts ?? [];
  const writes: string[] = [];

  if (options.blockPopup) {
    await browser.addInitScript(() => {
      window.open = () => null;
    });
  }
  await browser.route(/\/api\/plugins\/connections$/, (route) =>
    route.fulfill({ json: { connections: accounts } }),
  );
  await browser.route(
    /\/api\/plugins\/servers\/srv_notion\/connect\?/,
    async (route) => {
      const { pathname, search } = new URL(route.request.url);
      writes.push(`${route.request.method} ${pathname}${search}`);
      const next = (await options.answer?.(writes.length)) ?? "consent";
      switch (next) {
        case "fields":
          return route.fulfill({
            json: { fields: [{ name: "api_key", type: "string" }] },
          });
        case "failure":
          return route.fulfill({ status: 502, json: { error: refusal } });
        case "connected":
          accounts = [{ serverId, holder: "person" }];
          return route.fulfill({ json: { connected: true } });
        case "consent":
          return route.fulfill({
            json: {
              authorizationUrl: new URL(consent, route.request.url).href,
            },
          });
      }
    },
  );
  await browser.route(/\/test-notion-chat-consent$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Notion consent</title><h1>Notion consent</h1><a href="/test-notion-chat-consent/accepted">Allow Notion</a>',
    }),
  );
  await browser.route(/\/test-notion-chat-consent\/accepted$/, (route) => {
    accounts = [{ serverId, holder: "person" }];
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><h1>Notion consent saved</h1>",
    });
  });
  return writes;
}

async function openCard(fixtures: Fixtures, options: ConnectionFixture = {}) {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(browser, bot.id, "Notion notes");
  const path = `/channel/${channelId}`;
  const expectedThread = await readThreadId(browser, channelId);
  const toolCallId = `connect-notion-${channelId}`;
  const originalMessages = [
    { id: "request", role: "user", content: question },
    {
      id: "notion-assistant",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: toolCallId,
          type: "function",
          function: { name: "mcp__notion__search", arguments: "{}" },
        },
      ],
    },
    {
      id: "notion-refusal",
      role: "tool",
      toolCallId,
      content: `Refused. ${connectAppRefusal({ serverId, title: "Notion", message: explanation, agentId: bot.id })}`,
    },
  ];
  await browser.route(
    /\/api\/plugins\/for\/[^/]+\/apps\/srv_notion$/,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Bot App status temporarily unavailable." },
      }),
  );
  const writes = await serveConnection(browser, options);
  const runs: ReturnType<typeof readChatRun>[] = [];
  let archive: object[] = [];
  let completedRuns = 0;
  await configureChatStream(browser, originalMessages, async () => archive);
  await browser.route(chatRunPath, async (route) => {
    const run = readChatRun(route.request.postData);
    runs.push(run);
    const { threadId, runId, messages } = run;
    const messageId = `notion-reply-${runId}`;
    const sent = messages.at(-1);
    if (typeof sent === "object" && sent !== null) {
      archive = [
        ...originalMessages,
        sent,
        { id: messageId, role: "assistant", content: reply },
      ];
    }
    await route.fulfill(
      chatEventStream([
        { type: "RUN_STARTED", threadId, runId },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: reply },
        { type: "TEXT_MESSAGE_END", messageId },
        { type: "RUN_FINISHED", threadId, runId },
      ]),
    );
    completedRuns++;
  });

  await app.open(path);
  const card = browser.locator(`[data-connect-app="${serverId}"]`);
  await expect(card.getByText("Connect Notion", { exact: true })).toBeVisible();
  await expect(card.getByText(explanation, { exact: true })).toBeVisible();
  const [original] = browser.tabs();
  if (!original) throw new Error("Expected the conversation tab");
  return {
    card,
    connect: card.getByRole("button", "Connect", { exact: true }),
    original,
    path,
    writes,
    runs,
    expectedThread,
    completedRuns: () => completedRuns,
    reply: screen.getByText(reply, { exact: true }),
  };
}

const expectedConnect = `POST /api/plugins/servers/${serverId}/connect?returnTo=settings`;

test("chat claims the Notion consent tab before the request completes and continues only after the account appears", async (fixtures) => {
  const { browser, screen } = fixtures;
  const delayed = Promise.withResolvers<ConnectAnswer>();
  const {
    card,
    connect,
    original,
    path,
    writes,
    runs,
    reply,
    expectedThread,
    completedRuns,
  } = await openCard(fixtures, { answer: () => delayed.promise });
  const popup = await browser.waitForPopup(() => connect.click());
  try {
    await expect.poll(() => writes.slice()).toEqual([expectedConnect]);
    await expect(browser).toHaveURL("about:blank");
    expect(runs).toEqual([]);
  } finally {
    delayed.resolve("consent");
  }
  await expect(browser).toHaveURL(consent);
  await expect(screen.getByRole("heading", "Notion consent")).toBeVisible();
  expect(await browser.evaluate(() => window.opener === null)).toBe(true);
  await original.activate();
  await expect(browser).toHaveURL(path);
  await expect(card.getByRole("status")).toHaveText(
    "Finish in the tab that opened, then come back here.",
  );
  await expect(card.getByRole("button", "Waiting for Notion…")).toBeVisible();
  expect(runs).toEqual([]);
  await popup.activate();
  await screen.getByRole("link", "Allow Notion").click();
  await expect(
    screen.getByRole("heading", "Notion consent saved"),
  ).toBeVisible();
  await original.activate();
  await expect(card.getByRole("status")).toHaveText("Notion is connected.");
  await expect(reply).toBeVisible();
  await expect(screen.getByText(continuation, { exact: true })).toHaveCount(1);
  await expect.poll(completedRuns).toBe(1);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.threadId).toBe(expectedThread);
  expect(
    runs[0]?.messages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "user" &&
        "content" in message &&
        message.content === question,
    ),
  ).toBe(true);
  expect(runs[0]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: continuation,
  });
  await popup.close();
  await expect(browser).toHaveURL(path);
  await browser.reload();
  await expect(reply).toBeVisible();
  await expect(screen.getByText(continuation, { exact: true })).toHaveCount(1);
  await expect(card.getByRole("button", "Continue")).toHaveCount(0);
  expect(runs).toHaveLength(1);
});

test("a blocked popup leaves an ordinary sign-in link in the conversation", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { card, connect, original, path, writes, runs } = await openCard(
    fixtures,
    { blockPopup: true },
  );
  await connect.click();
  const link = card.getByRole("link", "Open Notion's sign-in");
  await expect(link).toHaveAttribute("href", /\/test-notion-chat-consent$/);
  await expect(link).toHaveAttribute("target", "_blank");
  expect(browser.tabs()).toHaveLength(1);
  const popup = await browser.waitForPopup(() => link.click());
  await expect(browser).toHaveURL(consent);
  await expect(screen.getByRole("heading", "Notion consent")).toBeVisible();
  await popup.close();
  await original.activate();
  await expect(browser).toHaveURL(path);
  expect(writes).toEqual([expectedConnect]);
  expect(runs).toEqual([]);
});

for (const outcome of ["fields", "failure", "connected"] as const) {
  test(`chat closes the claimed blank tab after a Notion ${outcome} response`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const delayed = Promise.withResolvers<ConnectAnswer>();
    const {
      card,
      connect,
      original,
      path,
      writes,
      runs,
      reply,
      expectedThread,
    } = await openCard(fixtures, {
      answer: (attempt) => (attempt === 1 ? delayed.promise : "consent"),
    });
    await browser.waitForPopup(() => connect.click());
    try {
      await expect.poll(() => writes.slice()).toEqual([expectedConnect]);
      await expect(browser).toHaveURL("about:blank");
    } finally {
      delayed.resolve(outcome);
    }
    await expect.poll(() => browser.tabs().length).toBe(1);
    await original.activate();
    await expect(browser).toHaveURL(path);
    if (outcome === "fields") {
      await expect(
        card.getByRole("link", "Enter it on Notion's page"),
      ).toHaveAttribute("href", settings);
      expect(runs).toEqual([]);
    } else if (outcome === "failure") {
      await expect(card.getByRole("status")).toHaveText(refusal);
      await expect(connect).toBeEnabled();
      const retry = await browser.waitForPopup(() => connect.click());
      await expect(browser).toHaveURL(consent);
      await expect(screen.getByRole("heading", "Notion consent")).toBeVisible();
      await original.activate();
      await expect(browser).toHaveURL(path);
      await expect(card.getByText(refusal, { exact: true })).toHaveCount(0);
      await expect(
        card.getByRole("button", "Waiting for Notion…"),
      ).toBeVisible();
      expect(writes).toEqual([expectedConnect, expectedConnect]);
      expect(runs).toEqual([]);
      await retry.close();
    } else {
      await expect(card.getByRole("status")).toHaveText("Notion is connected.");
      await expect(card.getByText(/needs a key from you/)).toHaveCount(0);
      const resume = card.getByRole("button", "Continue", { exact: true });
      await expect(resume).toBeVisible();
      expect(runs).toEqual([]);
      await resume.click();
      await expect(reply).toBeVisible();
      await expect(screen.getByText(continuation, { exact: true })).toHaveCount(
        1,
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]?.threadId).toBe(expectedThread);
      expect(runs[0]?.messages.at(-1)).toMatchObject({
        role: "user",
        content: continuation,
      });
    }
  });
}

for (const scenario of [
  {
    name: "a connected personal",
    row: { serverId, holder: "person" },
    connected: true,
  },
  {
    name: "a withdrawn personal",
    row: { serverId, holder: "person", revoked: true },
    connected: false,
  },
  {
    name: "a Shared",
    row: { serverId, holder: "deployment" },
    connected: false,
  },
] as const) {
  test(`the chat card reads ${scenario.name} account from the connection list`, async (fixtures) => {
    const { card, connect, writes, runs } = await openCard(fixtures, {
      accounts: [scenario.row],
    });
    const status = card
      .getByRole("status")
      .filter({ hasText: /Notion is connected/ });
    if (scenario.connected) {
      await expect(status).toBeVisible();
      await expect(connect).toHaveCount(0);
      await expect(card.getByRole("button", "Continue")).toBeVisible();
    } else {
      await expect(connect).toBeVisible();
      await expect(status).toHaveCount(0);
    }
    expect(writes).toEqual([]);
    expect(runs).toEqual([]);
  });
}

test("the mounted connection card automatically sends exactly one continuation when the existing account is recorded", async ({
  app,
  browser,
  screen,
}) => {
  const fixture = "/tests/browser/connect-app-card.html";
  const delayed = Promise.withResolvers<ConnectAnswer>();
  const writes = await serveConnection(browser, {
    answer: () => delayed.promise,
  });
  await app.open(fixture);
  const [original] = browser.tabs();
  if (!original) throw new Error("Expected the fixture tab");
  const card = browser.locator(`[data-connect-app="${serverId}"]`);
  const connect = card.getByRole("button", "Connect", { exact: true });
  const sent = screen.getByTestId("sent-messages");
  try {
    await expect(connect).toBeVisible();
    await expect(sent).toHaveText("");
    await browser.waitForPopup(() => connect.click());
    await expect.poll(() => writes.slice()).toEqual([expectedConnect]);
  } finally {
    delayed.resolve("connected");
  }
  await expect.poll(() => browser.tabs().length).toBe(1);
  await original.activate();
  await expect(card.getByRole("status")).toHaveText("Notion is connected.");
  await expect(sent).toHaveText(continuation);
  const toggle = screen.getByRole("button", "Toggle latest message");
  await toggle.click();
  await toggle.click();
  await expect(sent).toHaveText(continuation);
  await browser.reload();
  await expect(card.getByRole("status")).toHaveText("Notion is connected.");
  await expect(card.getByRole("button", "Continue")).toHaveCount(0);
  await expect(sent).toHaveText("");
  expect(writes).toEqual([expectedConnect]);
});
