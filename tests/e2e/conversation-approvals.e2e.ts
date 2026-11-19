import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation, readThreadId } from "./conversations";
import { createBot } from "./signed-in";

test("only this conversation's allowances appear and a failed revoke can be retried", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id, "Travel policy");
  const other = await createConversation(browser, bot.id, "Office policy");
  const threadId = await readThreadId(browser, channel);
  const otherThread = await readThreadId(browser, other);
  const slack = {
    id: "slack-grant",
    threadId,
    botId: bot.id,
    toolRef: "composio-slack/SLACK_SEND_MESSAGE",
    effect: "write",
    scope: "composio-slack",
    kind: "sending",
    createdAt: "2026-11-09T10:00:00.000Z",
  };
  let grants = [
    slack,
    {
      ...slack,
      id: "website-grant",
      toolRef: "computer_click",
      scope: "chat.example.com",
    },
    {
      ...slack,
      id: "other-grant",
      threadId: otherThread,
      toolRef: "computer_click",
      scope: "other.example.com",
    },
  ];
  await configureChatStream(browser, []);
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({
      json: {
        enabled: false,
        requests: [],
        questions: [],
        rules: [],
        teamRules: [],
        conversationGrants: grants,
      },
    }),
  );
  const requests: string[] = [];
  await browser.route(
    /\/api\/approvals\/conversation-grants\/[^/?]+$/,
    (route) => {
      const path = new URL(route.request.url).pathname;
      const id = path.split("/").at(-1);
      requests.push(`${route.request.method} ${id}`);
      if (requests.length === 1)
        return route.fulfill({
          status: 500,
          json: { error: "Temporary revoke failure." },
        });
      grants = grants.filter((grant) => grant.id !== id);
      return route.fulfill({ json: { revoked: true } });
    },
  );

  const allowed = screen.getByRole("region", "Allowed in this conversation", {
    exact: true,
  });
  const slackLine = allowed.getByText(
    "Send message on Slack is allowed in this conversation.",
    { exact: true },
  );
  const websiteLine = allowed.getByText(
    "Sending to other people on chat.example.com is allowed in this conversation.",
    { exact: true },
  );
  const otherLine = allowed.getByText(/other\.example\.com/);
  await app.open(`/channel/${channel}`);
  await expect(slackLine).toBeVisible();
  await expect(websiteLine).toBeVisible();
  await expect(otherLine).toHaveCount(0);

  const turnOff = allowed.getByRole(
    "button",
    "Turn off: Send message on Slack",
    { exact: true },
  );
  await turnOff.tap();
  await expect(allowed.getByRole("alert")).toBeVisible();
  await expect(slackLine).toBeVisible();
  await turnOff.tap();
  await expect(slackLine).toHaveCount(0);
  await expect(allowed.getByRole("alert")).toHaveCount(0);
  await expect(websiteLine).toBeVisible();

  await allowed
    .getByRole(
      "button",
      "Turn off: Sending to other people on chat.example.com",
      { exact: true },
    )
    .tap();
  await expect(allowed).toHaveCount(0);
  await browser.reload();
  await expect(
    screen
      .getByRole("region", "Messages", { exact: true })
      .getByRole("heading", bot.name, { exact: true }),
  ).toBeVisible();
  await expect(allowed).toHaveCount(0);
  await app.open(`/channel/${other}`);
  await expect(otherLine).toBeVisible();
  expect(requests).toEqual([
    "DELETE slack-grant",
    "DELETE slack-grant",
    "DELETE website-grant",
  ]);
});

test("a connector's pending tool call offers only the approval choices allowed by policy", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(
    browser,
    bot.id,
    "Calendar approval",
  );
  const threadId = await readThreadId(browser, channel);
  const call = "call-invite";
  const toolRef = "arcade-GoogleCalendar/CreateEvent";
  await configureChatStream(browser, [
    {
      id: "ask",
      role: "user",
      content: "Invite sam@example.test to Spec review.",
    },
    {
      id: "invite",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: call,
          type: "function",
          function: {
            name: "mcp__arcade-GoogleCalendar__CreateEvent",
            arguments: JSON.stringify({
              summary: "Spec review",
              attendee_emails: ["sam@example.test"],
            }),
          },
        },
      ],
    },
  ]);
  let pending = true;
  let closed = false;
  let granted = false;
  const reason = "Sending something to other people asks you first.";
  const adminReason =
    "Sending something to other people asks you every time. Your admin set this.";
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({
      json: {
        enabled: false,
        questions: [],
        rules: [],
        teamRules: [],
        requests: pending
          ? [
              {
                id: "calendar-approval",
                status: "pending",
                createdAt: "2026-11-05T10:00:00.000Z",
                action: {
                  botId: bot.id,
                  toolRef,
                  effect: "write",
                  scope: "arcade-GoogleCalendar",
                  threadId,
                  toolCallId: call,
                  args: { summary: "Spec review" },
                  target: {},
                  policy: {
                    behaviour: "ask",
                    source: "safety",
                    reason: closed ? adminReason : reason,
                    kind: "sending",
                    closed,
                  },
                },
              },
            ]
          : [],
        conversationGrants: granted
          ? [
              {
                id: "calendar-grant",
                botId: bot.id,
                toolRef,
                effect: "write",
                scope: "arcade-GoogleCalendar",
                threadId,
                kind: "sending",
                createdAt: "2026-11-05T10:00:00.000Z",
              },
            ]
          : [],
      },
    }),
  );
  const submitted: unknown[] = [];
  await browser.route(
    /\/api\/approvals\/calendar-approval\/decision$/,
    (route) => {
      submitted.push({
        method: route.request.method,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      pending = false;
      granted = true;
      return route.fulfill({ json: { ok: true } });
    },
  );

  const path = `/channel/${channel}`;
  const card = screen.getByRole("region", "Waiting for your approval", {
    exact: true,
  });
  const option = (name: string) =>
    card.getByRole("radio", name, { exact: true });
  closed = true;
  await app.open(path);
  await expect(card.getByText(adminReason, { exact: true })).toBeVisible();
  await expect(option("Allow once")).toBeVisible();
  await expect(option("Deny")).toBeVisible();
  await expect(option("Allow for this conversation")).toHaveCount(0);
  await expect(option("Always allow here")).toHaveCount(0);

  closed = false;
  await browser.reload();
  await expect(card.getByText(reason, { exact: true })).toBeVisible();
  for (const label of [
    "Allow once",
    "Allow for this conversation",
    "Always allow here",
    "Deny",
  ]) {
    await expect(option(label)).toBeVisible();
  }
  await option("Allow for this conversation").tap();
  await card
    .getByRole("button", "Allow for this conversation", { exact: true })
    .tap();
  await expect(card).toHaveCount(0);
  await expect(
    screen.getByRole("region", "Allowed in this conversation", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("Create event", { exact: true })).toBeVisible();
  expect(submitted).toEqual([
    { method: "POST", body: { decision: "allow_conversation" } },
  ]);
});

test("the Computer sheet exposes the covered approval on narrow windows", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(
    browser,
    bot.id,
    "Review a browser change",
  );
  const threadId = await readThreadId(browser, channel);
  const call = "delete-click";
  const reason = "Deleting something asks you first.";
  await configureChatStream(browser, [
    { id: "ask-delete", role: "user", content: "Remove the draft entry." },
    {
      id: "delete-step",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: call,
          type: "function",
          function: {
            name: "computer_click",
            arguments: JSON.stringify({ ref: "e12" }),
          },
        },
      ],
    },
  ]);
  const request = {
    id: "browser-approval",
    status: "pending",
    createdAt: "2026-11-06T10:00:00Z",
    action: {
      botId: bot.id,
      toolRef: "computer_click",
      effect: "write",
      scope: "browser",
      threadId,
      toolCallId: call,
      args: { ref: "e12" },
      target: { url: "https://records.example.test/drafts" },
      policy: { behaviour: "ask", source: "safety", reason },
    },
  };
  let pending = true;
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({
      json: {
        enabled: true,
        rules: [],
        teamRules: [],
        questions: [],
        requests: [
          ...(pending ? [request] : []),
          {
            ...request,
            id: "another-approval",
            action: {
              ...request.action,
              toolCallId: "another-call",
              threadId: "another-thread",
              policy: {
                ...request.action.policy,
                reason: "An approval in another conversation.",
              },
            },
          },
        ],
      },
    }),
  );
  const decisions: unknown[] = [];
  await browser.route(
    /\/api\/approvals\/browser-approval\/decision$/,
    (route) => {
      decisions.push({
        method: route.request.method,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      pending = false;
      return route.fulfill({ json: { ok: true } });
    },
  );

  await browser.setViewport({ width: 1500, height: 850 });
  await app.open(`/channel/${channel}?watch=true`);
  const sheet = screen.getByRole("dialog", "Computer", { exact: true });
  const sidebar = screen.getByRole("region", "Computer sidebar", {
    exact: true,
  });
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const allCards = screen.getByRole("region", "Waiting for your approval", {
    exact: true,
  });
  await expect(
    transcript.getByRole("region", "Waiting for your approval", {
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    sidebar.getByRole("tab", "Screen", { exact: true }),
  ).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await expect(allCards).toHaveCount(1);

  await browser.setViewport({ width: 620, height: 850 });
  const card = sheet.getByRole("region", "Waiting for your approval", {
    exact: true,
  });
  await expect(card).toHaveCount(1);
  await expect(card.getByText(reason, { exact: true })).toBeVisible();
  await expect(
    sheet.getByText("An approval in another conversation.", { exact: true }),
  ).toHaveCount(0);
  await expect(sheet.getByRole("tab", "Screen", { exact: true })).toBeVisible();
  const labels = [
    "Allow once",
    "Allow for this conversation",
    "Always allow here",
    "Deny",
  ];
  await expect(card.getByRole("radio")).toHaveCount(labels.length);
  for (const label of labels) {
    await expect(card.getByRole("radio", label, { exact: true })).toBeVisible();
  }
  await card.getByRole("radio", "Allow once", { exact: true }).tap();
  await card.getByRole("button", "Allow once", { exact: true }).tap();
  await expect(card).toHaveCount(0);
  expect(decisions).toEqual([
    { method: "POST", body: { decision: "allow_once" } },
  ]);
});

test("a handoff belongs to the pending browser step and accepts a handled decision", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id, "Review checkout");
  const threadId = await readThreadId(browser, channel);
  const site = "shop.example.test";
  const url = `https://${site}/checkout`;
  await configureChatStream(browser, [
    { id: "ask-checkout", role: "user", content: "Show me the checkout." },
    {
      id: "checkout-steps",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "nav-call",
          type: "function",
          function: {
            name: "computer_navigate",
            arguments: JSON.stringify({ url }),
          },
        },
        {
          id: "pay-call",
          type: "function",
          function: {
            name: "computer_click",
            arguments: JSON.stringify({ ref: "e7", snapshotId: 3 }),
          },
        },
      ],
    },
    {
      id: "opened-checkout",
      role: "tool",
      toolCallId: "nav-call",
      content: JSON.stringify({ ok: true, url, title: "Checkout preview" }),
    },
  ]);
  const decisions: unknown[] = [];
  let pending = true;
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({
      json: {
        enabled: false,
        questions: [],
        rules: [],
        teamRules: [],
        requests: pending
          ? [
              {
                id: "checkout-handoff",
                status: "pending",
                createdAt: "2026-11-05T10:00:00.000Z",
                action: {
                  botId: bot.id,
                  threadId,
                  toolCallId: "pay-call",
                  toolRef: "computer_click",
                  effect: "write",
                  scope: site,
                  args: { element: "Pay now" },
                  target: {},
                  policy: {
                    behaviour: "hand_off",
                    source: "safety",
                    reason:
                      "Paying, purchasing or moving money is always done by the person.",
                  },
                },
              },
            ]
          : [],
      },
    }),
  );
  await browser.route(
    /\/api\/approvals\/checkout-handoff\/decision$/,
    (route) => {
      decisions.push({
        method: route.request.method,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      pending = false;
      return route.fulfill({ json: { ok: true } });
    },
  );
  await app.open(`/channel/${channel}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const card = transcript.getByRole("region", "Waiting for your approval", {
    exact: true,
  });
  await expect(card).toHaveCount(1);
  await expect(
    card.getByText(`Click on ${site}`, { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByText(
      "Paying, purchasing or moving money is always done by the person.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    card.getByRole("radio", "Allow once", { exact: true }),
  ).toHaveCount(0);
  const group = transcript.getByText(`Browsed ${site}`, { exact: true });
  await expect(group).toBeVisible();
  await group.click();
  await expect(
    transcript.getByText("Opened page", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("Checkout preview", { exact: true }),
  ).toBeVisible();
  await expect(card).toHaveCount(1);
  await card.getByRole("button", "I did it myself", { exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(
    transcript.getByText("Checkout preview", { exact: true }),
  ).toBeVisible();
  expect(decisions).toEqual([
    { method: "POST", body: { decision: "handled" } },
  ]);
});
