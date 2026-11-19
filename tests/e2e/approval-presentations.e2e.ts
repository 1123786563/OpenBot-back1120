import { type Browser, test } from "@e2e-dev/web";
import { expect, type JsonValue } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation, readThreadId } from "./conversations";
import { createBot } from "./signed-in";

const taskReason = "Tasks started from a check-in ask before every change.";
const onceChoices = ["Allow once", "Deny"];
const standingChoices = [
  "Allow once",
  "Allow for this conversation",
  "Always allow here",
  "Deny",
];

type FixtureAction = {
  id: string;
  toolRef: string;
  scope: string;
  args: Record<string, JsonValue>;
  target?: Record<string, JsonValue>;
  source?: "task" | "personal_rule";
  title: string;
};

const appActions: FixtureAction[] = [
  {
    id: "mcp",
    toolRef: "requests/get_request",
    scope: "requests",
    args: { id: "r-expense" },
    title: "Get request on Requests",
  },
  {
    id: "brokered",
    toolRef: "composio-gmail/GMAIL_SEND_EMAIL",
    scope: "composio-gmail",
    args: { to: "sam@example.test" },
    title: "Send email on Gmail",
  },
  {
    id: "computer",
    toolRef: "computer_click",
    scope: "example.com",
    args: { ref: "e12" },
    title: "Click on example.com",
  },
  {
    id: "folder-file",
    toolRef: "host/write_file",
    scope: "host-grant-1",
    args: { path: "todo.txt" },
    target: { displayName: "share", relativePath: "todo.txt" },
    title: "Save a file todo.txt in share",
  },
  {
    id: "computer-file",
    toolRef: "computer_write_file",
    scope: "workspace",
    args: { path: "notes.txt" },
    target: { pageUrl: "", filePath: "notes.txt" },
    title: "Save a file notes.txt",
  },
  {
    id: "settings",
    toolRef: "composio-gmail/GMAIL_SETTINGS_GET_IMAP",
    scope: "composio-gmail",
    args: {},
    title: "Get IMAP settings on Gmail",
  },
];

const file = (
  id: string,
  path: string,
  source: FixtureAction["source"],
): FixtureAction => ({
  id,
  toolRef: "computer_write_file",
  scope: "workspace",
  args: { path },
  target: { filePath: path },
  source,
  title: `Save a file ${path}`,
});
const taskActions = [
  file("task", "deno-rollback-note.md", "task"),
  file("own", "notes.md", "personal_rule"),
];

const webPage = "https://en.wikipedia.org/wiki/Main_Page";
const webActions: FixtureAction[] = [
  {
    id: "click",
    toolRef: "computer_click",
    scope: "en.wikipedia.org",
    args: { ref: "f3e43", snapshotId: 4 },
    target: {
      pageUrl: webPage,
      element: {
        ref: "f3e43",
        role: "link",
        name: "Python (programming language)",
        type: "",
      },
      snapshotId: 4,
    },
    title: "Click the link “Python (programming language)”",
  },
  {
    id: "type",
    toolRef: "computer_type",
    scope: "en.wikipedia.org",
    args: { ref: "f7", snapshotId: 4, text: "monty python" },
    target: {
      pageUrl: webPage,
      element: {
        ref: "f7",
        role: "searchbox",
        name: "Search Wikipedia",
        type: "",
      },
      snapshotId: 4,
    },
    title: "Fill in “Search Wikipedia”",
  },
];

async function serveActions(
  browser: Browser,
  botId: string,
  threadId: string,
  actions: FixtureAction[],
) {
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({
      json: {
        enabled: false,
        rules: [],
        teamRules: [],
        questions: [],
        requests: actions.map(
          ({ id, toolRef, scope, args, target, source }) => ({
            id,
            status: "pending",
            createdAt: "2026-10-30T22:00:00Z",
            action: {
              botId,
              threadId,
              toolRef,
              effect: "write",
              scope,
              toolCallId: `call-${id}`,
              args,
              target: target ?? null,
              policy: {
                behaviour: "ask",
                source: source ?? "task",
                reason:
                  source === "personal_rule"
                    ? "A rule asks before this kind of action."
                    : taskReason,
              },
            },
          }),
        ),
      },
    }),
  );
}

async function showInChat(browser: Browser, actions: FixtureAction[]) {
  await configureChatStream(browser, [
    {
      id: "request-actions",
      role: "user",
      content: "Show the actions waiting for review.",
    },
    {
      id: "assistant-actions",
      role: "assistant",
      content: "",
      toolCalls: actions.map(({ id, toolRef, args }) => ({
        id: `call-${id}`,
        type: "function",
        function: {
          name: toolRef.includes("/")
            ? `mcp__${toolRef.replace("/", "__")}`
            : toolRef,
          arguments: JSON.stringify(args),
        },
      })),
    },
  ]);
}

async function useMuse(browser: Browser) {
  await browser.route(/\/api\/settings\/preferences$/, async (route) => {
    const data = await (await route.fetch()).json<{
      preferences: Record<string, unknown>;
    }>();
    return route.fulfill({
      json: { ...data, preferences: { ...data.preferences, skin: "openmuse" } },
    });
  });
}

test("the chat names approval actions consistently for connectors, websites and files", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const thread = await readThreadId(browser, channel);
  await serveActions(browser, bot.id, thread, appActions);
  await showInChat(browser, appActions.slice(0, 5));
  await app.open(`/channel/${channel}`);
  const cards = screen.getByRole("region", "Waiting for your approval", {
    exact: true,
  });
  await expect(cards).toHaveCount(5);
  for (const action of appActions.slice(0, 5)) {
    await expect(cards.getByText(action.title, { exact: true })).toBeVisible();
  }
  for (const denied of [/write file/i, /workspace/i]) {
    await expect(cards.getByText(denied)).toHaveCount(0);
  }
});

test("check-in task approvals omit standing choices in chat and the OpenMuse Needs you sheet", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const thread = await readThreadId(browser, channel);
  await serveActions(browser, bot.id, thread, taskActions);
  await showInChat(browser, taskActions);
  await app.open(`/channel/${channel}`);
  const cards = screen.getByRole("region", "Waiting for your approval", {
    exact: true,
  });
  for (const [filename, choices] of [
    ["deno-rollback-note.md", onceChoices],
    ["notes.md", standingChoices],
  ] as const) {
    const card = cards.filter({ hasText: `Save a file ${filename}` });
    await expect(card.getByRole("radio")).toHaveCount(choices.length);
    for (const choice of choices)
      await expect(
        card.getByRole("radio", choice, { exact: true }),
      ).toBeVisible();
    if (filename === "deno-rollback-note.md")
      await expect(card.getByText(taskReason, { exact: true })).toBeVisible();
  }
  await useMuse(browser);
  await app.open(`/bots/${bot.id}`);
  await screen
    .getByRole("button", "Needs you, 2 waiting", { exact: true })
    .click();
  const sheet = screen.getByRole("dialog", "Needs you");
  await expect(sheet).toBeVisible();
  for (const [filename, choices] of [
    ["deno-rollback-note.md", onceChoices],
    ["notes.md", standingChoices],
  ] as const) {
    const row = browser
      .locator('[role="dialog"] [data-slot="item"]')
      .filter({ has: screen.getByText(filename, { exact: false }) });
    await expect(row.getByRole("button")).toHaveCount(choices.length);
    for (const choice of choices)
      await expect(
        row.getByRole("button", choice, { exact: true }),
      ).toBeVisible();
  }
});

test("the Needs you board and sheet present useful approval details without internal browser refs", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  await serveActions(browser, bot.id, "thread-for-details", [
    ...webActions,
    ...appActions.filter(({ id }) =>
      ["mcp", "brokered", "computer", "settings"].includes(id),
    ),
  ]);
  await app.open(`/bots/${bot.id}`);
  const board = browser
    .locator("section")
    .filter({ has: screen.getByRole("heading", "Needs you", { exact: true }) });
  for (const text of [
    webActions[0]?.title ?? "",
    webActions[1]?.title ?? "",
    "Text",
    "monty python",
  ]) {
    await expect(board.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(
    board.getByText("en.wikipedia.org", { exact: true }).first(),
  ).toBeVisible();
  await expect(board).not.toContainText(/snapshotId|f3e43|"ref"|computer_|\{/);

  await useMuse(browser);
  await app.open(`/bots/${bot.id}`);
  await screen
    .getByRole("button", "Needs you, 6 waiting", { exact: true })
    .click();
  const sheet = screen.getByRole("dialog", "Needs you");
  await expect(
    sheet.getByText(
      `${bot.name} wants to click the link “Python (programming language)”`,
      { exact: true },
    ),
  ).toBeVisible();
  for (const [verb, service] of [
    ["get request", "Requests"],
    ["send email", "Gmail"],
    ["get IMAP settings", "Gmail"],
  ]) {
    const description = screen.getByText(`${bot.name} wants to ${verb}`, {
      exact: true,
    });
    const row = browser
      .locator('[role="dialog"] [data-slot="item"]')
      .filter({ has: description });
    await expect(row.getByText(service, { exact: true })).toBeVisible();
  }
  await expect(
    sheet.getByText(`${bot.name} wants to click`, { exact: true }),
  ).toBeVisible();
  await expect(sheet.getByText("monty python", { exact: true })).toBeVisible();
  await expect(sheet).not.toContainText(
    /snapshotId|f3e43|"ref"|computer_|composio|requests\/|\{/,
  );
});
