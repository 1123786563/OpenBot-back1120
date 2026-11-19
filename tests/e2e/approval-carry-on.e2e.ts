import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { chatRunPath, configureChatStream } from "./chat-stream";
import { createConversation, readThreadId } from "./conversations";
import { createBot } from "./signed-in";

const inboxPath = /\/api\/approvals$/;
const reason = "You asked to be asked first.";
const reply =
  "Blue Bottle on Market St is the closest, a four minute walk, and it is open until six today.";
const searchResult = {
  id: "search-result",
  role: "tool",
  toolCallId: "call-search",
  content: '[{"name":"Blue Bottle","rating":4.6}]',
};

function mapsCall(
  kind: "search_places" | "directions",
  id: string,
  args: Record<string, string>,
) {
  return {
    id: `assistant-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: {
          name: `mcp__google-maps__maps_${kind}`,
          arguments: JSON.stringify(args),
        },
      },
    ],
  };
}

type Fixtures = Parameters<typeof createBot>[0];

async function openPendingApproval(fixtures: Fixtures) {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(
    browser,
    bot.id,
    "Coffee near the office",
  );
  const threadId = await readThreadId(browser, channelId);
  const initial = [
    { id: "ask", role: "user", content: "Find a coffee shop near the office." },
    mapsCall("search_places", "call-search", { query: "coffee" }),
  ];
  let archive: readonly object[] = [];
  let firstStatus: "pending" | "approved" | "consumed" | "completed" =
    "pending";
  let decidedAt: string | null = null;
  let asksAgain = false;
  const requests: { method: string; body: unknown }[] = [];
  const inboxReads: string[] = [];
  let browserRuns = 0;
  await configureChatStream(browser, initial, async () => archive);
  await browser.route(chatRunPath, (route) => {
    browserRuns++;
    return route.fulfill({
      status: 500,
      json: { error: "This turn belongs to the server." },
    });
  });
  const createdAt = new Date().toISOString();
  await browser.route(inboxPath, (route) => {
    inboxReads.push(firstStatus);
    const base = {
      botId: bot.id,
      effect: "read",
      scope: "google-maps",
      threadId,
      target: {},
      policy: { behaviour: "ask", source: "rule", reason },
    };
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        questions: [],
        rules: [],
        teamRules: [],
        requests: [
          {
            id: "maps-search",
            status: firstStatus,
            createdAt,
            decidedAt,
            action: {
              ...base,
              toolRef: "google-maps/maps_search_places",
              toolCallId: "call-search",
              args: { query: "coffee" },
            },
          },
          ...(asksAgain
            ? [
                {
                  id: "maps-directions",
                  status: "pending",
                  createdAt,
                  action: {
                    ...base,
                    toolRef: "google-maps/maps_directions",
                    toolCallId: "call-directions",
                    args: { destination: "Blue Bottle" },
                    policy: {
                      ...base.policy,
                      reason: "Review the directions request.",
                    },
                  },
                },
              ]
            : []),
        ],
      }),
    });
  });
  await browser.route(/\/api\/approvals\/maps-search\/decision$/, (route) => {
    requests.push({
      method: route.request.method,
      body: JSON.parse(route.request.postData ?? "null"),
    });
    firstStatus = "approved";
    decidedAt = new Date().toISOString();
    return route.fulfill({ json: { id: "maps-search", status: firstStatus } });
  });

  await app.open(`/channel/${channelId}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const card = transcript.getByRole("region", "Waiting for your approval", {
    exact: true,
  });
  const working = browser.locator(".tool-line-running");
  const stop = browser.locator('[data-testid="composer-stop"]');
  await expect(card.getByText(reason, { exact: true })).toBeVisible();
  await expect(working).toHaveCount(0);
  await card.getByRole("button", "Allow once", { exact: true }).tap();
  await expect(working).toBeVisible();
  await expect(stop).toHaveCount(0);
  expect(requests).toEqual([
    { method: "POST", body: { decision: "allow_once" } },
  ]);

  return {
    bot,
    channelId,
    transcript,
    card,
    working,
    stop,
    async consumed() {
      firstStatus = "consumed";
      await expect.poll(() => inboxReads.includes("consumed")).toBe(true);
      await expect(working).toBeVisible();
      await expect(stop).toHaveCount(0);
    },
    publishHistory(tail: object[]) {
      archive = [...initial, searchResult, ...tail];
    },
    complete(secondApproval = false) {
      asksAgain = secondApproval;
      firstStatus = "completed";
    },
    browserRuns: () => browserRuns,
  };
}

test("a completed server turn refreshes the open conversation without roster activity", async (fixtures) => {
  const continued = await openPendingApproval(fixtures);
  continued.publishHistory([
    { id: "reply-maps", role: "assistant", content: reply },
  ]);
  continued.complete();
  await expect(continued.working).toHaveCount(0);
  await expect(
    continued.transcript.getByText(reply, { exact: true }),
  ).toBeVisible();
  expect(continued.browserRuns()).toBe(0);
});

test("an approved server turn shows activity and merges partial history into the complete reply without reopening", async (fixtures) => {
  const { browser } = fixtures;
  const continued = await openPendingApproval(fixtures);
  await continued.consumed();

  const partial = reply.slice(0, reply.indexOf("walk") + 4);
  const message = (content: string) => ({
    id: "reply-maps",
    role: "assistant",
    content,
  });
  continued.publishHistory([message(partial)]);
  continued.complete();
  await expect(continued.working).toHaveCount(0);
  await expect(
    continued.transcript.getByText(partial, { exact: true }),
  ).toBeVisible();

  continued.publishHistory([message(reply)]);
  const status = await browser.evaluate(
    async ({ channelId, botId, text }) => {
      const response = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/activity`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            at: new Date().toISOString(),
            agentId: botId,
            text,
          }),
        },
      );
      return response.status;
    },
    { channelId: continued.channelId, botId: continued.bot.id, text: reply },
  );
  expect(status).toBe(204);
  await expect(
    continued.transcript.getByText(reply, { exact: true }),
  ).toHaveCount(1);
  await expect(
    continued.transcript.getByText(partial, { exact: true }),
  ).toHaveCount(0);
  expect(continued.browserRuns()).toBe(0);
});

test("a second approval reached by the resumed turn appears in the original conversation", async (fixtures) => {
  const continued = await openPendingApproval(fixtures);
  continued.publishHistory([
    mapsCall("directions", "call-directions", { destination: "Blue Bottle" }),
  ]);
  continued.complete(true);
  await expect(
    continued.card.getByText("Review the directions request.", { exact: true }),
  ).toBeVisible();
  await expect(continued.card.getByText(reason, { exact: true })).toHaveCount(
    0,
  );
  await expect(
    continued.card.getByRole("button", "Allow once", { exact: true }),
  ).toBeVisible();
  await expect(continued.working).toHaveCount(0);
  expect(continued.browserRuns()).toBe(0);
});
