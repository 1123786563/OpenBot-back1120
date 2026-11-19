import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

async function currentUser(browser: Browser) {
  return browser.evaluate(async () => {
    const response = await fetch("/api/me");
    if (!response.ok)
      throw new Error(`Cannot read the signed-in user: ${response.status}`);
    const data: { user: { id: string; email: string; name: string } } =
      await response.json();
    return data.user;
  });
}

test("group creators see the current count and can add or remove people without closing the dialog", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const first = await createBot(fixtures);
  const second = await createBot(fixtures);
  const id = await createConversation(
    browser,
    [first.id, second.id],
    "Plan together",
  );
  const me = await currentUser(browser);
  const alex = {
    userId: "alex",
    email: "alex@example.test",
    name: "Alex",
    creator: false,
  };
  const sam = {
    userId: "sam",
    email: "sam@example.test",
    name: "Sam",
    creator: false,
  };
  let people = [
    { userId: me.id, email: me.email, name: me.name, creator: true },
    alex,
  ];
  const groupApi = `/api/groups/${id}`;
  const membersApi = `${groupApi}/members`;
  await browser.route(new RegExp(`${RegExp.escape(groupApi)}$`), (route) =>
    route.fulfill({ json: { bots: [first, second], people, messages: [] } }),
  );
  const writes: { method: string; path: string; body: unknown }[] = [];
  await browser.route(
    new RegExp(`${RegExp.escape(membersApi)}(?:/[^/?]+)?$`),
    (route) => {
      const path = new URL(route.request.url).pathname;
      const { method, postData } = route.request;
      const body = JSON.parse(postData ?? "null");
      writes.push({ method, path, body });
      if (method === "POST") people = [...people, sam];
      else
        people = people.filter(
          ({ userId }) => path !== `${membersApi}/${userId}`,
        );
      return route.fulfill({ json: { ok: true } });
    },
  );

  const path = `/group/${id}`;
  await app.open(path);
  const header = browser.locator('[data-slot="conversation-header"]');
  const count = (label: string) =>
    header.getByRole("button", label, { exact: true });
  await expect(count("2 people")).toBeVisible();
  await count("2 people").tap();
  const dialog = screen.getByRole("dialog", "People in this group", {
    exact: true,
  });
  await expect(dialog.getByText("Alex", { exact: true })).toBeVisible();
  await expect(dialog.getByText("You", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", "Leave this group", { exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", "Remove alex@example.test", { exact: true })
    .tap();
  await expect(dialog.getByText("Alex", { exact: true })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", "Close", { exact: true }).tap();
  await expect(count("1 person")).toBeVisible();

  await count("1 person").tap();
  const add = dialog.getByRole("button", "Add", { exact: true });
  await expect(add).toBeDisabled();
  const email = dialog.getByRole("textbox", "Their email", { exact: true });
  await email.fill(sam.email);
  await add.tap();
  await expect(dialog.getByText("Sam", { exact: true })).toBeVisible();
  await expect(email).toHaveValue("");
  await dialog.getByRole("button", "Close", { exact: true }).tap();
  await expect(count("2 people")).toBeVisible();
  expect(writes).toEqual([
    { method: "DELETE", path: `${membersApi}/alex`, body: null },
    { method: "POST", path: membersApi, body: { email: sam.email } },
  ]);
});

test("answering a Bot's question in its group clears the badge and shows the targeted reply", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const askingBot = await createBot(fixtures);
  const otherBot = await createBot(fixtures);
  const id = await createConversation(
    browser,
    [askingBot.id, otherBot.id],
    "Errand order",
  );
  const me = await currentUser(browser);
  const question = "Which errands are downtown versus in Riverside?";
  const why =
    "The best order depends on your starting point and where the errands are.";
  const answer =
    "From home. Dry cleaning is downtown, groceries are in Riverside.";
  const reply = "Do downtown first, then Riverside on the way home.";
  const line = (messageId: string, agentId: string | null, text: string) => ({
    id: messageId,
    channelId: id,
    ownerUserId: me.id,
    agentId,
    text,
    status: "completed",
    createdAt: "2026-11-08T05:16:39.000Z",
  });
  let open = true;
  let messages = [
    line("initial-message", null, "Which area should I do first on Saturday?"),
    line("initial-reply", askingBot.id, "I need the locations first."),
  ];
  const groupSends: unknown[] = [];
  await browser.route(
    new RegExp(`/api/groups/${RegExp.escape(id)}$`),
    (route) => {
      if (route.request.method === "POST") {
        groupSends.push(JSON.parse(route.request.postData ?? "null"));
        return route.fulfill({ status: 202, json: { queued: true } });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          bots: [askingBot, otherBot],
          people: [
            { userId: me.id, email: me.email, name: me.name, creator: true },
          ],
          messages,
        }),
      });
    },
  );
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({
      json: {
        enabled: true,
        requests: [],
        rules: [],
        teamRules: [],
        questions: open
          ? [
              {
                id: "group-question",
                botId: askingBot.id,
                conversationBotId: askingBot.id,
                channelId: id,
                threadId: "asking-bot-group-thread",
                question,
                why,
                createdAt: "2026-11-08T05:16:39.000Z",
              },
            ]
          : [],
      },
    }),
  );
  await browser.route(/\/api\/bots\/attention$/, (route) =>
    route.fulfill({
      json: {
        lastPingId: null,
        bots: [
          {
            agentId: askingBot.id,
            name: askingBot.name,
            questions: open ? 1 : 0,
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
    /\/api\/approvals\/questions\/group-question\/respond$/,
    (route) => {
      answers.push({
        method: route.request.method,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      open = false;
      messages = [
        ...messages,
        line("answered", null, answer),
        line("resumed", askingBot.id, reply),
      ];
      return route.fulfill({ json: { id: "group-question", queued: true } });
    },
  );

  await app.open(`/group/${id}`);
  const card = screen.getByRole(
    "region",
    `${askingBot.name} is waiting on your answer`,
    { exact: true },
  );
  const badge = browser.locator(
    'a[href="/bots"] [aria-label="1 thing needs you"]',
  );
  await expect(card.getByText(question, { exact: true })).toBeVisible();
  await expect(card.getByText(why, { exact: true })).toBeVisible();
  await expect(badge).toHaveText("1");
  await screen.getByRole("textbox", "Message", { exact: true }).fill(answer);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect(card).toHaveCount(0);
  await expect(badge).toHaveCount(0);
  await expect(screen.getByText(answer, { exact: true })).toHaveCount(1);
  await expect(screen.getByText(reply, { exact: true })).toBeVisible();
  expect(answers).toEqual([{ method: "POST", body: { response: answer } }]);
  expect(groupSends).toEqual([]);
});
