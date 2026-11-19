import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { AppAccess } from "../../server/src/plugins/app-access";
import {
  type ConnectPrompt,
  connectAppRefusal,
  SHOW_APP_ACCESS_TOOL,
} from "../../shared/connect-prompt";
import {
  chatEventStream,
  chatRunPath,
  configureChatStream,
  readChatRun,
} from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const gmail = "composio-gmail";
const accountPath = `/connections/${gmail}`;
const accessPath = /\/api\/plugins\/for\/[^/]+\/apps\/composio-gmail$/;
const gmailTool = "mcp__composio-gmail__GMAIL_FETCH_EMAILS";
const refusalAt = "2026-10-20T12:00:00.000Z";
const stale = "2026-10-01T00:00:00.000Z";
const reason =
  "Gmail is switched off. Do not browse to its website or ask them to sign in there.";
const continuation = "Gmail is ready now. Please carry on.";
const reply = "I found your latest Gmail messages.";
const base: AppAccess = {
  key: gmail,
  displayName: "Gmail",
  logo: null,
  provider: "composio",
  account: "personal",
  connect: "consent",
  authScheme: "OAUTH2",
  accountMode: "personal",
  state: "ready",
  unavailable: null,
  accountHolder: "you",
  asksFirst: false,
  granted: true,
  ownerGrants: "any",
  givenByOwner: false,
  needsConnect: false,
  connectedAt: null,
  requestKind: null,
  request: null,
};

type Fixtures = Parameters<typeof createBot>[0];
type Replay =
  | { kind: "refusal" | "access" | "ordinary"; prompt?: Partial<ConnectPrompt> }
  | { kind: "unknown-app" }
  | { kind: "checking" };

async function showCard(
  fixtures: Fixtures,
  {
    live = {},
    replay = { kind: "refusal" },
    addressedTo,
    laterMessage,
    role = "member",
    appKey = gmail,
    title = "Gmail",
  }: {
    live?: Partial<AppAccess> | null | (() => Partial<AppAccess>);
    replay?: Replay;
    addressedTo?: string;
    laterMessage?: string;
    role?: "admin" | "member";
    appKey?: string;
    title?: string;
  } = {},
) {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id, "Gmail access");
  const reads: string[] = [];
  const runs: ReturnType<typeof readChatRun>[] = [];
  await browser.route(/\/api\/me$/, async (route) => {
    const current = await route.fetch();
    const account = await current.json<{ user: Record<string, unknown> }>();
    await route.fulfill({
      json: { ...account, user: { ...account.user, role } },
    });
  });
  const appPath = new RegExp(
    `/api/plugins/for/[^/]+/apps/${encodeURIComponent(appKey)}$`,
  );
  await browser.route(appPath, (route) => {
    reads.push(new URL(route.request.url).pathname);
    const response = typeof live === "function" ? live() : live;
    return response === null
      ? route.fulfill({
          status: 503,
          json: { error: "Gmail status unavailable." },
        })
      : route.fulfill({
          json: {
            app: { ...base, key: appKey, displayName: title, ...response },
          },
        });
  });
  await browser.route(/\/api\/plugins\/connections$/, (route) =>
    route.fulfill({ json: { connections: [] } }),
  );
  const prompt = connectAppRefusal({
    serverId: appKey,
    title,
    message: reason,
    agentId: addressedTo,
    ...("prompt" in replay ? replay.prompt : {}),
  });
  const toolCallId = `gmail-access-${channel}`;
  let tool = SHOW_APP_ACCESS_TOOL;
  let result = prompt;
  switch (replay.kind) {
    case "refusal":
      tool = gmailTool;
      result = `Refused. ${prompt}`;
      break;
    case "ordinary":
      tool = "run_command";
      break;
    case "unknown-app":
      result =
        "This deployment has no app called Gmial, so there is nothing to show. Say so plainly; do not browse to it instead.";
      break;
  }
  const messages = [
    {
      id: "question",
      role: "user",
      content: "Read the latest Gmail messages.",
    },
    {
      id: "assistant",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: toolCallId,
          type: "function",
          function: { name: tool, arguments: JSON.stringify({ app: appKey }) },
        },
      ],
    },
  ];
  await configureChatStream(
    browser,
    replay.kind === "checking"
      ? messages
      : [
          ...messages,
          { id: "tool", role: "tool", toolCallId, content: result },
          ...(laterMessage
            ? [{ id: "later", role: "user", content: laterMessage }]
            : []),
        ],
  );
  await browser.route(chatRunPath, (route) => {
    const run = readChatRun(route.request.postData);
    runs.push(run);
    const { runId, threadId } = run;
    const messageId = `gmail-fixture-${runId}`;
    return route.fulfill(
      chatEventStream([
        { type: "RUN_STARTED", threadId, runId },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: reply },
        { type: "TEXT_MESSAGE_END", messageId },
        { type: "RUN_FINISHED", threadId, runId },
      ]),
    );
  });
  const path = `/channel/${channel}`;
  await app.open(path);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  return {
    bot,
    card: browser.locator(`[data-app-access="${appKey}"]`),
    fallback: browser.locator(`[data-connect-app="${appKey}"]`),
    transcript,
    reads,
    runs,
    path,
  };
}

for (const addressedTo of ["agent_from_gmail_refusal", undefined]) {
  test(`the Gmail refusal checks the ${addressedTo ? "named" : "conversation"} Bot and offers Connect`, async (fixtures) => {
    const { bot, card, reads } = await showCard(fixtures, {
      live: { state: "not_connected" },
      addressedTo,
    });
    await expect(card).toHaveAttribute("data-state", "not_connected");
    await expect(card.getByText("Gmail", { exact: true })).toBeVisible();
    await expect(
      card.getByText("You haven't connected your Gmail account yet.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      card.getByRole("button", "Connect Gmail", { exact: true }),
    ).toBeVisible();
    expect(reads.length).toBeGreaterThan(0);
    expect([...new Set(reads)]).toEqual([
      `/api/plugins/for/${addressedTo ?? bot.id}/apps/${gmail}`,
    ]);
  });
}

for (const scenario of [
  {
    name: "the shared account is missing",
    live: {
      state: "shared_not_connected",
      account: "shared",
      accountMode: "shared",
      requestKind: "connect_shared",
    },
    reason: "shared",
    copy: /Your organisation's Gmail account isn't connected yet/,
    action: "Request access to Gmail",
  },
  {
    name: "the shared account needs reconnecting",
    live: { state: "ready", account: "shared", accountMode: "shared" },
    reason: "shared",
    copy: /Your organisation's Gmail account needs reconnecting\. Only an admin can reconnect it/,
  },
  {
    name: "the Bot's audience needs shared approval",
    live: {
      state: "shared_not_approved",
      account: "shared",
      accountMode: "shared",
    },
    reason: "access",
    copy: /Only an admin can approve it/,
  },
  {
    name: "the App is disabled",
    live: { state: "disabled", requestKind: "enable", granted: false },
    reason: "access",
    copy: /Gmail isn't turned on yet/,
    action: "Request access to Gmail",
  },
  {
    name: "the Bot has no grant",
    live: { state: "not_granted", requestKind: "grant", granted: false },
    reason: "access",
    copy: /This Bot hasn't been given Gmail/,
    action: "Request access to Gmail",
  },
  {
    name: "the App was already ready when checked",
    live: { state: "ready" },
    reason: "access",
    copy: /Ready to use\./,
  },
] as const) {
  test(`the Gmail access card explains when ${scenario.name}`, async (fixtures) => {
    const { card } = await showCard(fixtures, {
      live: scenario.live,
      replay: {
        kind: scenario.reason === "access" ? "access" : "refusal",
        prompt: { reason: scenario.reason },
      },
    });
    await expect(card.getByText(scenario.copy)).toBeVisible();
    if ("action" in scenario && scenario.action) {
      await expect(
        card.getByRole("button", scenario.action, { exact: true }),
      ).toBeVisible();
    } else {
      await expect(card.getByRole("button")).toHaveCount(0);
      await expect(card.getByRole("link")).toHaveCount(0);
    }
    await expect(card.getByText(/Do not browse/)).toHaveCount(0);
  });
}

for (const accountHolder of ["you", "owner"] as const) {
  test(`a withdrawn Gmail account shows the reconnect action for ${accountHolder}`, async (fixtures) => {
    const { card } = await showCard(fixtures, {
      live: { accountHolder, connectedAt: stale },
      replay: {
        kind: "refusal",
        prompt: { reason: "reconnect", at: refusalAt },
      },
    });
    await expect(card).toHaveAttribute("data-state", "reconnect");
    if (accountHolder === "you") {
      await expect(
        card.getByText(/Your Gmail connection needs reconnecting/),
      ).toBeVisible();
      await expect(
        card.getByRole("button", "Reconnect Gmail", { exact: true }),
      ).toHaveAttribute("href", accountPath);
    } else {
      await expect(
        card.getByText(/Only the Bot's owner can reconnect it/),
      ).toBeVisible();
      await expect(card.getByRole("link")).toHaveCount(0);
      await expect(card.getByRole("button")).toHaveCount(0);
    }
  });
}

test("a connection newer than the Gmail refusal clears the stale Reconnect action", async (fixtures) => {
  const { card } = await showCard(fixtures, {
    live: { connectedAt: "2026-10-20T12:05:00.000Z" },
    replay: { kind: "refusal", prompt: { reason: "reconnect", at: refusalAt } },
  });
  await expect(card).toHaveAttribute("data-state", "ready");
  await expect(card.getByText(/Gmail is ready now/)).toBeVisible();
  await expect(card.getByRole("button", "Reconnect Gmail")).toHaveCount(0);
  await expect(card.getByRole("button", "Connect Gmail")).toHaveCount(0);
});

test("a failed access read shows the card's own error message", async (fixtures) => {
  const { card, fallback } = await showCard(fixtures, {
    live: null,
    replay: { kind: "access", prompt: { reason: "access" } },
  });
  await expect(card.getByRole("alert")).toHaveText(
    "Gmail's status couldn't be loaded. Try again in a moment.",
  );
  await expect(card.getByText(/Do not browse/)).toHaveCount(0);
  await expect(fallback).toHaveCount(0);
});

test("an ordinary tool result does not create an App access card", async (fixtures) => {
  const { card, fallback, transcript, reads } = await showCard(fixtures, {
    replay: { kind: "ordinary" },
  });
  await expect(
    transcript.getByText("Read the latest Gmail messages.", { exact: true }),
  ).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(fallback).toHaveCount(0);
  expect(reads).toEqual([]);
});

for (const replay of [{ kind: "checking" }, { kind: "unknown-app" }] as const) {
  test(`the App access tool displays a readable ${replay.kind} state`, async (fixtures) => {
    const { browser } = fixtures;
    const { transcript, card } = await showCard(fixtures, { replay });
    await expect(
      transcript.getByText(
        replay.kind === "checking"
          ? "Checking app access"
          : "Checked app access",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(transcript.getByText(SHOW_APP_ACCESS_TOOL)).toHaveCount(0);
    await expect(transcript.getByText(/Say so plainly/)).toHaveCount(0);
    await expect(card).toHaveCount(0);
    if (replay.kind === "unknown-app")
      await expect(
        browser.locator("details").filter({ hasText: "Checked app access" }),
      ).toHaveCount(0);
  });
}

for (const latest of [true, false]) {
  test(`Gmail becoming ready ${latest ? "continues the latest task once" : "leaves a newer turn alone"}`, async (fixtures) => {
    const { browser } = fixtures;
    let state: AppAccess["state"] = "not_connected";
    const later = "Leave those messages and start a new task.";
    const { card, transcript, runs } = await showCard(fixtures, {
      live: () => ({ state }),
      laterMessage: latest ? undefined : later,
    });
    await expect(card).toHaveAttribute("data-state", "not_connected");
    if (!latest)
      await expect(transcript.getByText(later, { exact: true })).toBeVisible();
    state = "ready";
    const refresh = () =>
      browser.evaluate(async () => {
        const path = "/src/query-client.ts";
        const { queryClient }: typeof import("../../app/src/query-client") =
          await import(path);
        await queryClient.invalidateQueries({
          queryKey: ["plugins", "app-access"],
        });
        return null;
      });
    await refresh();
    await expect(card).toHaveAttribute("data-state", "ready");
    if (latest) {
      await expect(transcript.getByText(reply, { exact: true })).toBeVisible();
      await expect(
        transcript.getByText(continuation, { exact: true }),
      ).toHaveCount(1);
      expect(runs[0]?.messages.at(-1)).toMatchObject({
        role: "user",
        content: continuation,
      });
    } else {
      await expect(
        card.getByText(
          "Gmail is ready now. Ask again and the Bot can use it.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        transcript.getByText(continuation, { exact: true }),
      ).toHaveCount(0);
    }
    await refresh();
    await expect(
      card.getByRole("button", "Continue", { exact: true }),
    ).toHaveCount(0);
    expect(runs).toHaveLength(latest ? 1 : 0);
  });
}

for (const blocked of [true, false, undefined]) {
  test(`an already-ready Gmail status offers Continue only for a blocked task (${String(blocked)})`, async (fixtures) => {
    const { browser } = fixtures;
    const { card, transcript, runs } = await showCard(fixtures, {
      replay: { kind: "access", prompt: { reason: "access", blocked } },
    });
    await expect(card).toHaveAttribute("data-state", "ready");
    const proceed = card.getByRole("button", "Continue", { exact: true });
    expect(runs).toEqual([]);
    if (!blocked) {
      await expect(
        card.getByText("Ready to use.", { exact: true }),
      ).toBeVisible();
      await expect(proceed).toHaveCount(0);
      return;
    }
    await expect(proceed).toBeVisible();
    await proceed.click();
    await expect(transcript.getByText(reply, { exact: true })).toBeVisible();
    expect(runs[0]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: continuation,
    });
    await expect(proceed).toHaveCount(0);
    await browser.reload();
    await expect(card).toHaveAttribute("data-state", "ready");
    await expect(proceed).toHaveCount(0);
    expect(runs).toHaveLength(1);
  });
}

test("a failed connection read keeps the legacy Connect card available", async (fixtures) => {
  const { card, fallback } = await showCard(fixtures, { live: null });
  await expect(
    fallback.getByText("Connect Gmail", { exact: true }),
  ).toBeVisible();
  await expect(
    fallback.getByRole("button", "Connect", { exact: true }),
  ).toBeVisible();
  await expect(card).toHaveCount(0);
});

for (const mode of ["no-bot", "standalone"] as const) {
  test(`the mounted Gmail card supports a ${mode} surface`, async ({
    app,
    browser,
    screen,
  }) => {
    const reads: string[] = [];
    await browser.route(accessPath, (route) => {
      reads.push(new URL(route.request.url).pathname);
      return route.fulfill({ json: { app: base } });
    });
    await browser.route(/\/api\/plugins\/connections$/, (route) =>
      route.fulfill({ json: { connections: [] } }),
    );
    await app.open(`/tests/browser/connect-app-card.html?card=${mode}`);
    if (mode === "no-bot") {
      await expect(
        screen.getByText("Connect Gmail", { exact: true }),
      ).toBeVisible();
      await expect(
        screen.getByRole("button", "Connect", { exact: true }),
      ).toBeVisible();
      expect(reads).toEqual([]);
    } else {
      await expect(
        screen.getByText(
          "Gmail is ready now. Ask again and the Bot can use it.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        screen.getByRole("button", "Continue", { exact: true }),
      ).toHaveCount(0);
      expect(reads).toEqual([
        `/api/plugins/for/fixture-gmail-bot/apps/${gmail}`,
      ]);
    }
  });
}

const requestPath = "/api/plugins/access-requests";
const requestId = "fixture-request";
const requestFailure = "Gmail is ready to use.";

for (const [state, kind] of [
  ["disabled", "enable"],
  ["not_granted", "grant"],
  ["shared_not_connected", "connect_shared"],
] as const) {
  test(`a Gmail access request for ${state} can be sent and withdrawn with focus preserved`, async (fixtures) => {
    const { browser } = fixtures;
    let request: AppAccess["request"] = null;
    const writes: { method: string; path: string; body: unknown }[] = [];
    await browser.route(
      /\/api\/plugins\/access-requests(?:\/fixture-request)?$/,
      (route) => {
        const { pathname } = new URL(route.request.url);
        const method = route.request.method;
        writes.push({
          method,
          path: pathname,
          body: JSON.parse(route.request.postData ?? "null"),
        });
        if (method === "POST" && pathname === requestPath) {
          request = {
            id: requestId,
            kind,
            createdAt: "2026-10-20T10:00:00.000Z",
          };
          return route.fulfill({ json: { request, created: true } });
        }
        if (method === "DELETE" && pathname === `${requestPath}/${requestId}`) {
          const cancelled = { ...request, status: "cancelled" };
          request = null;
          return route.fulfill({ json: { request: cancelled } });
        }
        return route.fulfill({
          status: 405,
          json: { error: "Unexpected fixture request." },
        });
      },
    );
    const { bot, card, runs } = await showCard(fixtures, {
      live: () => ({
        state,
        requestKind: kind,
        request,
        granted: false,
        ...(kind === "connect_shared"
          ? { account: "shared", accountMode: "shared" }
          : {}),
      }),
    });
    const ask = card.getByRole("button", "Request access to Gmail", {
      exact: true,
    });
    const withdraw = card.getByRole("button", "Withdraw request for Gmail", {
      exact: true,
    });
    await ask.click();
    await expect(card.getByRole("status")).toHaveText("Requested");
    await expect(ask).toHaveCount(0);
    await expect(withdraw).toBeFocused();
    await browser.reload();
    await expect(card.getByRole("status")).toHaveText("Requested");
    await withdraw.click();
    await expect(ask).toBeFocused();
    await expect(card.getByRole("status")).toHaveCount(0);
    await expect(withdraw).toHaveCount(0);
    await browser.reload();
    await expect(ask).toBeVisible();
    await expect(withdraw).toHaveCount(0);
    expect(writes).toEqual([
      {
        method: "POST",
        path: requestPath,
        body: { agentId: bot.id, app: gmail },
      },
      { method: "DELETE", path: `${requestPath}/${requestId}`, body: null },
    ]);
    expect(runs).toEqual([]);
  });
}

test("a refused Gmail access request reports the error, restores focus, and can retry", async (fixtures) => {
  let attempts = 0;
  let request: AppAccess["request"] = null;
  await fixtures.browser.route(/\/api\/plugins\/access-requests$/, (route) => {
    if (++attempts === 1)
      return route.fulfill({ status: 409, json: { error: requestFailure } });
    request = {
      id: requestId,
      kind: "grant",
      createdAt: "2026-10-20T10:00:00.000Z",
    };
    return route.fulfill({ json: { request, created: true } });
  });
  const { card } = await showCard(fixtures, {
    live: () => ({
      state: "not_granted",
      requestKind: "grant",
      request,
      granted: false,
    }),
  });
  const ask = card.getByRole("button", "Request access to Gmail", {
    exact: true,
  });
  const error = card.getByRole("alert");
  await ask.click();
  await expect(error).toBeVisible();
  await expect(ask).toBeFocused();
  await error.getByRole("button", "Details", { exact: true }).click();
  await expect(error).toContainText(requestFailure);
  await expect(card.getByRole("status")).toHaveCount(0);
  await ask.click();
  await expect(card.getByRole("status")).toHaveText("Requested");
  await expect(error).toHaveCount(0);
  await expect(
    card.getByRole("button", "Withdraw request for Gmail"),
  ).toBeFocused();
  expect(attempts).toBe(2);
});

for (const initial of ["disabled", "not_granted"] as const) {
  test(`an administrator grants Gmail in one press when it is ${initial}`, async (fixtures) => {
    const writes: { method: string; path: string; body: string | null }[] = [];
    let granted = false;
    await fixtures.browser.route(
      /\/api\/plugins\/for\/[^/]+\/apps\/composio-gmail\/approve$/,
      (route) => {
        writes.push({
          method: route.request.method,
          path: new URL(route.request.url).pathname,
          body: route.request.postData ?? null,
        });
        granted = true;
        return route.fulfill({
          json: { enabled: true, granted: [`${gmail}/GMAIL_FETCH_EMAILS`] },
        });
      },
    );
    const { bot, card, transcript, runs } = await showCard(fixtures, {
      role: "admin",
      live: () =>
        granted
          ? { state: "ready" }
          : {
              state: initial,
              unavailable: initial === "disabled" ? "absent" : null,
              requestKind: initial === "disabled" ? "enable" : "grant",
              granted,
            },
    });
    const action =
      initial === "disabled"
        ? card.getByRole("button", `Turn on Gmail and give it to ${bot.name}`, {
            exact: true,
          })
        : card.getByRole("button", `Give Gmail to ${bot.name}`, {
            exact: true,
          });
    await expect(action).toHaveText(
      initial === "disabled"
        ? `Turn on and give it to ${bot.name}`
        : `Give it to ${bot.name}`,
    );
    await expect(
      card.getByRole("button", "Request access to Gmail"),
    ).toHaveCount(0);
    await action.click();
    await expect(card).toHaveAttribute("data-state", "ready");
    await expect(transcript.getByText(reply, { exact: true })).toBeVisible();
    expect(runs).toHaveLength(1);
    expect(writes).toEqual([
      {
        method: "POST",
        path: `/api/plugins/for/${bot.id}/apps/${gmail}/approve`,
        body: null,
      },
    ]);
  });
}

test("the administrator sees the grant refusal from the server", async (fixtures) => {
  const failure = "Gmail has no tools to give yet.";
  await fixtures.browser.route(
    /\/api\/plugins\/for\/[^/]+\/apps\/composio-gmail\/approve$/,
    (route) => route.fulfill({ status: 409, json: { error: failure } }),
  );
  const { bot, card, runs } = await showCard(fixtures, {
    live: { state: "not_granted", requestKind: "grant", granted: false },
    role: "admin",
  });
  const give = card.getByRole("button", `Give Gmail to ${bot.name}`, {
    exact: true,
  });
  await give.click();
  const error = card.getByRole("alert");
  await error.getByRole("button", "Details", { exact: true }).click();
  await expect(error).toContainText(failure);
  await expect(give).toBeEnabled();
  expect(runs).toEqual([]);
});

for (const scenario of [
  {
    live: {
      state: "shared_not_connected",
      account: "shared",
      accountMode: "shared",
      requestKind: "connect_shared",
    },
    label: "Connect the team Gmail account",
    href: "/admin/plugins/composio-gmail",
  },
  {
    live: {
      state: "disabled",
      unavailable: "token_missing",
      requestKind: "enable",
    },
    label: "Set up Gmail",
    href: "/admin/plugins/composio-gmail",
  },
  {
    live: {
      state: "disabled",
      unavailable: "composio_unconfigured",
      requestKind: "enable",
    },
    label: "Set up Gmail",
    href: "/admin/plugins/composio",
  },
] as const) {
  test(`the administrator can open Gmail setup for ${"unavailable" in scenario.live ? scenario.live.unavailable : "a missing shared account"}`, async (fixtures) => {
    const { card, runs } = await showCard(fixtures, {
      live: scenario.live,
      role: "admin",
    });
    const setup = card.getByRole("button", scenario.label, { exact: true });
    await expect(setup).toHaveAttribute("href", scenario.href);
    await expect(setup).toHaveAttribute("target", "_blank");
    expect(runs).toEqual([]);
  });
}

for (const needsConnect of [false, true]) {
  test(`the Bot owner grants Gmail ${needsConnect ? "only after consent completes" : "in one press"}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const vendor = "/fixture-owner-gmail-consent";
    let connected = !needsConnect;
    let granted = false;
    const writes: { method: string; path: string; body: string | null }[] = [];
    await browser.route(
      /\/api\/plugins\/(?:servers\/composio-gmail\/connect\?|for\/[^/]+\/apps\/composio-gmail\/give$)/,
      (route) => {
        const { pathname, search } = new URL(route.request.url);
        writes.push({
          method: route.request.method,
          path: pathname + search,
          body: route.request.postData ?? null,
        });
        if (pathname.endsWith("/connect")) {
          return route.fulfill({
            json: { authorizationUrl: new URL(vendor, route.request.url).href },
          });
        }
        if (!connected)
          return route.fulfill({
            status: 409,
            json: { error: "Connect Gmail before granting it." },
          });
        granted = true;
        return route.fulfill({
          json: { granted: [`${gmail}/GMAIL_FETCH_EMAILS`] },
        });
      },
    );
    await browser.route(/\/fixture-owner-gmail-consent$/, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><h1>Gmail sign-in</h1><a href="/fixture-owner-gmail-consent/accepted">Allow Gmail</a>',
      }),
    );
    await browser.route(/\/fixture-owner-gmail-consent\/accepted$/, (route) => {
      connected = true;
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><h1>Gmail consent saved</h1>",
      });
    });
    const { bot, card, transcript, runs, path } = await showCard(fixtures, {
      live: () => ({
        state: granted ? "ready" : "owner_grantable",
        granted,
        needsConnect: !connected,
      }),
    });
    const allow = card.getByRole(
      "button",
      `Let ${bot.name} use Gmail${needsConnect ? " after you connect it" : ""}`,
      { exact: true },
    );
    const give = {
      method: "POST",
      path: `/api/plugins/for/${bot.id}/apps/${gmail}/give`,
      body: null,
    };
    const connect = {
      method: "POST",
      path: `/api/plugins/servers/${gmail}/connect?returnTo=settings`,
      body: null,
    };
    if (needsConnect) {
      const [original] = browser.tabs();
      if (!original) throw new Error("Expected the conversation tab");
      const popup = await browser.waitForPopup(() => allow.click());
      await expect(browser).toHaveURL(vendor);
      await expect(screen.getByRole("heading", "Gmail sign-in")).toBeVisible();
      expect(writes).toEqual([connect]);
      expect(runs).toEqual([]);
      await screen.getByRole("link", "Allow Gmail").click();
      await expect(
        screen.getByRole("heading", "Gmail consent saved"),
      ).toBeVisible();
      await original.activate();
      await expect(browser).toHaveURL(path);
      await expect(card).toHaveAttribute("data-state", "ready");
      await popup.close();
    } else {
      await allow.click();
      await expect(card).toHaveAttribute("data-state", "ready");
    }
    await expect(transcript.getByText(reply, { exact: true })).toBeVisible();
    expect(runs).toHaveLength(1);
    expect(writes).toEqual(needsConnect ? [connect, give] : [give]);
  });
}

for (const scenario of [
  {
    appKey: gmail,
    state: "not_connected",
    connect: "key",
    provider: "composio",
    label: "Connect Gmail",
  },
  {
    appKey: gmail,
    state: "reconnect",
    connect: "consent",
    provider: "composio",
    label: "Reconnect Gmail",
  },
  {
    appKey: "arcade-Gmail",
    state: "reconnect",
    connect: "consent",
    provider: "arcade",
    label: "Reconnect Gmail",
  },
] as const) {
  test(`${scenario.provider} sends ${scenario.connect === "key" ? "typed-key Connect" : "Reconnect"} to its connection page`, async (fixtures) => {
    const { browser } = fixtures;
    const writes: string[] = [];
    await browser.route(
      /\/api\/plugins\/servers\/[^/]+\/connect\?/,
      (route) => {
        writes.push(route.request.method);
        return route.fulfill({
          status: 405,
          json: { error: "Use the App's connection page." },
        });
      },
    );
    const { card } = await showCard(fixtures, {
      appKey: scenario.appKey,
      live: {
        state: scenario.state,
        connect: scenario.connect,
        provider: scenario.provider,
      },
    });
    await expect(card).toHaveAttribute("data-state", scenario.state);
    const link = card.getByRole("button", scenario.label, { exact: true });
    await expect(link).toHaveAttribute(
      "href",
      `/connections/${scenario.appKey}`,
    );
    const tabs = browser.tabs().length;
    await link.click();
    await expect(browser).toHaveURL(`/connections/${scenario.appKey}`);
    expect(browser.tabs()).toHaveLength(tabs);
    expect(writes).toEqual([]);
  });
}

for (const scenario of [
  { live: { accountHolder: "owner" }, text: /owner's Gmail account/ },
  { live: { asksFirst: true }, text: /asked to allow it the first time/ },
  {
    live: {
      state: "shared_not_connected",
      account: "shared",
      requestKind: null,
    },
    text: /organisation's Gmail account/,
  },
] as const) {
  test(`the Gmail card has no access action when it says ${scenario.text.source}`, async (fixtures) => {
    const { card, runs } = await showCard(fixtures, {
      live: scenario.live,
      replay: { kind: "access", prompt: { reason: "access", blocked: false } },
    });
    await expect(card.getByText(scenario.text)).toBeVisible();
    await expect(card.getByRole("button")).toHaveCount(0);
    await expect(card.getByRole("link")).toHaveCount(0);
    expect(runs).toEqual([]);
  });
}

type ConsentFocusFixture = {
  checksAfterClosed: number;
  focused: boolean;
  severed: boolean;
};
type ConsentFixtureWindow = Window & {
  fixtureConsentFocus?: ConsentFocusFixture;
};

for (const mode of ["closed", "opener-severed", "deployment-oauth"] as const) {
  test(`the chat consent tab handles ${mode}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const ownOAuth = mode === "deployment-oauth";
    const key = ownOAuth ? "notion" : gmail;
    const title = ownOAuth ? "Notion" : "Gmail";
    const vendor = "/fixture-chat-consent-window";
    const writes: string[] = [];
    if (mode === "opener-severed") {
      await browser.addInitScript(() => {
        const page: ConsentFixtureWindow = window;
        const focus = { checksAfterClosed: 0, focused: false, severed: false };
        page.fixtureConsentFocus = focus;
        const open = window.open.bind(window);
        window.open = (...args) => {
          const tab = open(...args);
          if (!tab) return null;
          return new Proxy(tab, {
            get(target, property) {
              if (property === "closed") {
                if (focus.severed) focus.checksAfterClosed++;
                return focus.severed || tab.closed;
              }
              return Reflect.get(target, property, target);
            },
            set(target, property, value) {
              return Reflect.set(target, property, value, target);
            },
          });
        };
        document.hasFocus = () => focus.focused;
      });
    }
    await browser.route(
      /\/api\/plugins\/servers\/[^/]+\/connect\?/,
      (route) => {
        const url = new URL(route.request.url);
        writes.push(`${route.request.method} ${url.pathname}${url.search}`);
        return route.fulfill({
          json: { authorizationUrl: new URL(vendor, url).href },
        });
      },
    );
    await browser.route(/\/fixture-chat-consent-window$/, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><h1>Provider sign-in</h1>",
      }),
    );
    const { card, path, runs } = await showCard(fixtures, {
      appKey: key,
      title,
      live: ownOAuth
        ? { provider: "catalogue", connect: "oauth", state: "reconnect" }
        : { state: "not_connected" },
    });
    const button = card.getByRole(
      "button",
      `${ownOAuth ? "Reconnect" : "Connect"} ${title}`,
      { exact: true },
    );
    await expect(button).toBeVisible();
    const [original] = browser.tabs();
    if (!original) throw new Error("Expected the original conversation tab");
    const popup = await browser.waitForPopup(() => button.click());
    await expect(browser).toHaveURL(vendor);
    await expect(screen.getByRole("heading", "Provider sign-in")).toBeVisible();
    await original.activate();
    await expect(browser).toHaveURL(path);
    const waiting = card.getByRole("button", `Waiting for ${title}…`, {
      exact: true,
    });
    const note = card.getByText("Finish in the tab that opened.", {
      exact: true,
    });
    await expect(waiting).toBeVisible();
    await expect(note).toBeVisible();
    if (mode === "opener-severed") {
      await browser.evaluate(() => {
        const focus = (window as ConsentFixtureWindow).fixtureConsentFocus;
        if (focus) focus.severed = true;
        return null;
      });
      await expect
        .poll(() =>
          browser.evaluate(
            () =>
              (window as ConsentFixtureWindow).fixtureConsentFocus
                ?.checksAfterClosed ?? 0,
          ),
        )
        .toBeGreaterThan(0);
      await expect(waiting).toBeVisible();
      expect(browser.tabs()).toHaveLength(2);
      await browser.evaluate(() => {
        const focus = (window as ConsentFixtureWindow).fixtureConsentFocus;
        if (focus) focus.focused = true;
        window.dispatchEvent(new Event("focus"));
        return null;
      });
      await expect(button).toBeVisible();
      await popup.close();
    } else {
      await popup.close();
      await original.activate();
      await expect(button).toBeVisible();
    }
    await expect(waiting).toHaveCount(0);
    await expect(note).toHaveCount(0);
    const connectRequest = `POST /api/plugins/servers/${key}/connect?returnTo=settings`;
    expect(writes).toEqual([connectRequest]);
    if (mode === "closed") {
      const retry = await browser.waitForPopup(() => button.click());
      await expect(browser).toHaveURL(vendor);
      await expect(
        screen.getByRole("heading", "Provider sign-in"),
      ).toBeVisible();
      expect(writes).toEqual([connectRequest, connectRequest]);
      await retry.close();
      await original.activate();
      await expect(browser).toHaveURL(path);
    }
    expect(runs).toEqual([]);
  });
}
