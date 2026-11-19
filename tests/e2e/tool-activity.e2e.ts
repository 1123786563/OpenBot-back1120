import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { DECLINED_BY_PERSON } from "../../shared/approval-outcomes";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";
import { stageChatRun } from "./staged-chat-stream";
import {
  type ToolHistoryCall as Call,
  toolHistory as history,
  openToolHistory,
} from "./tool-history";

const searchTool = "mcp__exa__web_search_exa";
const fetchTool = "mcp__exa__web_fetch_exa";

function callEvents(id: string, name: string, args: object) {
  return [
    {
      type: "TOOL_CALL_START",
      toolCallId: id,
      toolCallName: name,
      parentMessageId: "fixture-step",
    },
    { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
    { type: "TOOL_CALL_END", toolCallId: id },
  ];
}

function answerEvent(id: string, content: string) {
  return {
    type: "TOOL_CALL_RESULT",
    toolCallId: id,
    messageId: `result-${id}`,
    role: "tool",
    content,
  };
}

test("folded tool activity counts and distinguishes a refusal and a failure", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(
    browser,
    history("Check two sources.", [
      {
        id: "refused-search",
        name: searchTool,
        args: { query: "GDP estimates" },
        result: JSON.stringify("Refused. Not allowed here."),
      },
      {
        id: "failed-search",
        name: searchTool,
        args: { query: "Population estimates" },
        result: JSON.stringify("That tool could not be called: timeout"),
      },
    ]),
  );
  await app.open(`/channel/${channel}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const issues = transcript.getByText("2 issues", { exact: true });
  await expect(issues).toBeVisible();
  await issues.tap();
  await expect(transcript.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("Didn't work", { exact: true }),
  ).toBeVisible();
});

test("the transcript suppresses retry instructions and keeps the completed browser step", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const url = "https://fixture.example.test/login";
  await configureChatStream(
    browser,
    history("Open the sign-in page.", [
      {
        id: "open",
        name: "computer_navigate",
        args: { url },
        result: JSON.stringify({
          ok: false,
          reason: "Take a fresh browser snapshot after handback before acting.",
          staleRefs: true,
          snapshotRequired: true,
        }),
      },
      {
        id: "look",
        name: "computer_snapshot",
        args: {},
        result: JSON.stringify({ elements: [] }),
      },
      {
        id: "again",
        name: "computer_navigate",
        args: { url },
        result: JSON.stringify({
          ok: true,
          url,
          title: "Fixture sign-in page",
        }),
      },
    ]),
  );
  await app.open(`/channel/${channel}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const summary = transcript.getByText("Browsed fixture.example.test", {
    exact: true,
  });
  await expect(summary).toBeVisible();
  await summary.tap();
  const openPage = transcript.getByText("Opened page", { exact: true });
  await expect(openPage).toHaveCount(1);
  await expect(openPage).toBeVisible();
  await expect(
    transcript.getByText("Fixture sign-in page", { exact: true }),
  ).toBeVisible();
  await expect(transcript).not.toContainText(
    /fresh browser snapshot|Didn't work|\bissues?\b/,
  );
});

test("tool activity names a pending step and can show the inputs for an earlier step", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(browser);
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId }) => [
      { type: "RUN_STARTED", runId, threadId },
      ...callEvents("search", searchTool, { query: "top 5 GDP 2025" }),
      answerEvent("search", JSON.stringify("Results")),
      ...callEvents("fetch", fetchTool, { urls: ["https://imf.org"] }),
    ],
    ({ runId, threadId }) => [
      answerEvent("fetch", JSON.stringify("Page text")),
      { type: "RUN_FINISHED", runId, threadId },
    ],
  );
  await app.open(`/channel/${channel}`);
  await screen
    .getByRole("textbox", "Message", { exact: true })
    .fill("Compare the five largest economies.");
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const running = transcript.getByText("Read web pages…", { exact: true });
  await expect(running).toBeVisible();
  await running.tap();
  await transcript.getByText("Search the web", { exact: true }).tap();
  await expect(transcript.getByText("query", { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("top 5 GDP 2025", { exact: true }).last(),
  ).toBeVisible();
  stream.finish();
  await expect(running).toHaveCount(0);
  await expect(
    transcript.getByText("Searched the web and read 1 page", { exact: true }),
  ).toBeVisible();
});

function separateToolSteps(
  question: string,
  calls: (Call & { report: string })[],
) {
  return [
    { id: "fixture-question", role: "user", content: question },
    ...calls.flatMap(({ id, name, args, result, report }) => [
      {
        id: `assistant-${id}`,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      { id: `result-${id}`, role: "tool", toolCallId: id, content: result },
      { id: `report-${id}`, role: "assistant", content: report },
    ]),
  ];
}

const builtInSteps = [
  {
    id: "skill",
    name: "copilotkit_load_skill",
    args: {},
    result: '{"instructions":"Check the report dates."}',
    label: "Used a skill",
    report: "I loaded the reporting skill.",
  },
  {
    id: "bots",
    name: "list_bots",
    args: {},
    result: "Finance Bot: yours",
    label: "Checked existing Bots",
    report: "I checked which Bots can help.",
  },
  {
    id: "memory",
    name: "remember_personal_fact",
    args: {},
    result: '{"id":"m1"}',
    label: "Saved a memory",
    report: "I saved your preference.",
  },
];

test("completed built-in tools use readable labels in a restored conversation", async (fixtures) => {
  const transcript = await openToolHistory(
    fixtures,
    separateToolSteps(
      "Plan the budget with the people who can help.",
      builtInSteps,
    ),
  );
  for (const { label } of builtInSteps)
    await expect(transcript.getByText(label, { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("I saved your preference.", { exact: true }),
  ).toBeVisible();
  await expect(transcript).not.toContainText(
    /copilotkit_load_skill|list_bots|remember_personal_fact|render_ui/,
  );
});

for (const scenario of [
  {
    name: "remember_personal_fact",
    running: "Saving a memory",
    finished: "Saved a memory",
    result: '{"id":"m1"}',
  },
  {
    name: "web_search",
    running: "Web search",
    finished: "Web search",
    result: "Error: no tool by that name.",
  },
]) {
  test(`the transcript labels ${scenario.running.toLowerCase()} from the first tool event through completion`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(browser, bot.id);
    await configureChatStream(browser);
    const toolCallId = "started-tool";
    const reply = "The tool step finished.";
    using stream = await stageChatRun(
      browser,
      ({ threadId, runId }) => [
        { type: "RUN_STARTED", threadId, runId },
        {
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: scenario.name,
          parentMessageId: "first-tool",
        },
      ],
      ({ threadId, runId }) => [
        { type: "TOOL_CALL_ARGS", toolCallId, delta: "{}" },
        { type: "TOOL_CALL_END", toolCallId },
        answerEvent(toolCallId, scenario.result),
        {
          type: "TEXT_MESSAGE_START",
          messageId: "assistant-reply",
          role: "assistant",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "assistant-reply",
          delta: reply,
        },
        { type: "TEXT_MESSAGE_END", messageId: "assistant-reply" },
        { type: "RUN_FINISHED", threadId, runId },
      ],
    );
    const connected = browser.waitForResponse(
      /\/api\/copilotkit\/agent\/[^/]+\/connect$/,
    );
    await app.open(`/channel/${channel}`);
    await connected;
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("Run the next step.");
    const send = screen.getByRole("button", "Send message", { exact: true });
    await expect(send).toBeEnabled();
    await send.click();
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      transcript.getByText(scenario.running, { exact: true }),
    ).toBeVisible();
    await expect(transcript.getByText(reply, { exact: true })).toHaveCount(0);
    await expect(transcript).not.toContainText(scenario.name);

    stream.finish();
    await expect(transcript.getByText(reply, { exact: true })).toBeVisible();
    await expect(
      transcript.getByText(scenario.finished, { exact: true }),
    ).toBeVisible();
    await expect(transcript).not.toContainText(scenario.name);
  });
}

const unavailableName = "web_search";
const unavailableSentence =
  "This Bot asked for a tool it doesn't have, so it carried on without it.";
const sdkUnavailable =
  "Error: Model tried to call unavailable tool 'web_search'. Available tools: generateSandboxedUi, computer_navigate, computer_read, mcp__routines__create_routine, copilotkit_load_skill, AGUISendStateSnapshot.";
const graphUnavailable =
  "Error: web_search is not a valid tool, try one of [computer_navigate, mcp__routines__create_routine].";
const ordinaryFailure = "Error: the page did not load.";
const unofferedQuestion = "Search the web for OpenBot.";

for (const suggestion of [
  { source: "AI SDK", result: sdkUnavailable, shown: unavailableSentence },
  { source: "LangGraph", result: graphUnavailable, shown: unavailableSentence },
  {
    source: "a JSON-wrapped SDK reply",
    result: JSON.stringify(sdkUnavailable),
    shown: unavailableSentence,
  },
  {
    source: "a Bot with no tools",
    result:
      "Error: Model tried to call unavailable tool 'web_search'. No tools are available.",
    shown: unavailableSentence,
  },
  {
    source: "an ordinary error",
    result: ordinaryFailure,
    shown: ordinaryFailure,
  },
]) {
  test(`tool failure details read correctly for ${suggestion.source}`, async (fixtures) => {
    const transcript = await openToolHistory(fixtures, [
      ...history(unofferedQuestion, [
        {
          id: "search",
          name: unavailableName,
          args: { query: "OpenBot" },
          result: suggestion.result,
        },
      ]),
      {
        id: "search-reply",
        role: "assistant",
        content: "Here is what I found.",
      },
    ]);
    await expect(
      transcript.getByText("Here is what I found.", { exact: true }),
    ).toBeVisible();
    const label =
      suggestion.shown === ordinaryFailure
        ? "Web search"
        : "Web search, didn't work";
    const failed = transcript.getByText(label, { exact: true });
    await failed.click();
    await expect(
      transcript.getByText(suggestion.shown, { exact: true }),
    ).toBeVisible();
    await expect(transcript).not.toContainText(
      /Available tools|not a valid tool|Model tried|computer_navigate|mcp__routines__create_routine|web_search/,
    );
    if (suggestion.shown === ordinaryFailure)
      await expect(
        transcript.getByText(unavailableSentence, { exact: true }),
      ).toHaveCount(0);
  });
}

test("an unoffered tool counts as one issue in a group and opens to the same explanation", async (fixtures) => {
  const transcript = await openToolHistory(fixtures, [
    ...history(unofferedQuestion, [
      {
        id: "search",
        name: unavailableName,
        args: { query: "OpenBot" },
        result: graphUnavailable,
      },
      { id: "bots", name: "list_bots", args: {}, result: "Scout: yours" },
    ]),
    { id: "search-reply", role: "assistant", content: "Done." },
  ]);
  const issues = transcript.getByText("1 issue", { exact: true });
  await expect(issues).toBeVisible();
  await issues.click();
  await expect(
    transcript.getByText("Checked existing Bots", { exact: true }),
  ).toBeVisible();
  await transcript.getByText("Web search", { exact: true }).click();
  const step = transcript
    .getByRole("listitem")
    .filter({ hasText: "Web search" });
  await expect(step.getByText("Didn't work", { exact: true })).toBeVisible();
  await expect(
    step.getByText(unavailableSentence, { exact: true }),
  ).toBeVisible();
  await expect(transcript).not.toContainText(
    /not a valid tool|computer_navigate|mcp__routines__create_routine|web_search/,
  );
});

test("the standalone transcript names the interface step before and after it is drawn", async ({
  app,
  screen,
}) => {
  await app.open("/tests/browser/transcript-interface.html");
  const running = screen.getByText("Drawing an interface", { exact: true });
  await expect(running).toBeVisible();
  await expect(screen.getByText("render_ui", { exact: true })).toHaveCount(0);
  await screen.getByRole("button", "Finish drawing", { exact: true }).click();
  await expect(running).toHaveCount(0);
  await expect(
    screen.getByText("Drew an interface", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("The trip budget is ready.", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("render_ui", { exact: true })).toHaveCount(0);
});

test("a registered chart stays between the tool groups that surround it", async (fixtures) => {
  const { browser } = fixtures;
  const chart = "Logistics cost comparison";
  const before = "Searched the web and read 1 page";
  const after = "Used Google Drive";
  await browser.route(/\/api\/components\/for-agent\//, (route) =>
    route.fulfill({
      json: {
        components: [
          { name: "showBarChart", description: "Show values as bars." },
        ],
      },
    }),
  );
  const transcript = await openToolHistory(fixtures, [
    ...history("Compare shipping costs.", [
      {
        id: "search",
        name: searchTool,
        args: { query: "Shipping prices" },
        result: '"Search results"',
      },
      {
        id: "source",
        name: fetchTool,
        args: { urls: ["https://shipping.example.test"] },
        result: '"Price list"',
      },
      {
        id: "chart",
        name: "showBarChart",
        args: {
          title: chart,
          points: [
            { label: "Standard", value: 12 },
            { label: "Express", value: 21 },
          ],
        },
        result: '{"shown":true}',
      },
      {
        id: "recent",
        name: "mcp__google-drive__search_files",
        args: { q: "recent shipping prices" },
        result: '"Comparison spreadsheet"',
      },
      {
        id: "older",
        name: "mcp__google-drive__search_files",
        args: { q: "past shipping prices" },
        result: '"Last year spreadsheet"',
      },
    ]),
    { id: "chart-reply", role: "assistant", content: "These are the costs." },
  ]);
  await expect(transcript.getByText(before, { exact: true })).toBeVisible();
  await expect(transcript.getByText(chart, { exact: true })).toBeVisible();
  await expect(transcript.getByText(after, { exact: true })).toBeVisible();
  const ordered = await browser.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[aria-label="Messages"] :is(details:not(details details) > summary,[data-slot="gallery-frame"] figcaption)',
      ),
    ].map((element) => element.textContent?.replace(/^▸\s*/, "").trim()),
  );
  expect(ordered).toEqual([before, chart, after]);
  await expect(
    transcript.getByText("Standard", { exact: true }).first(),
  ).toBeVisible();
});

const folderGrant = "host-grant-fixture-81672";
const sharedFolder = "Shared notes";
const folderListing = JSON.stringify({
  connected: true,
  folders: [{ grantId: folderGrant, displayName: sharedFolder }],
});
const desktopDenial = "Refused. Declined in OpenBot Desktop.";
const writeTool = "host_write_file";

test("blocked and declined folder steps label each attempted action", async (fixtures) => {
  const operations = [
    {
      id: "write",
      name: writeTool,
      args: {
        grantId: folderGrant,
        path: "todo.txt",
        content: "Check the schedule.",
      },
      action: "Save a file",
    },
    {
      id: "files",
      name: "host_list_files",
      args: { grantId: folderGrant },
      action: "List files",
    },
    {
      id: "read",
      name: "host_read_file",
      args: { grantId: folderGrant, path: "notes.md" },
      action: "Read a file",
    },
    {
      id: "command",
      name: "host_run_command",
      args: { grantId: folderGrant, command: "dir" },
      action: "Run a command",
    },
    {
      id: "folders",
      name: "host_list_folders",
      args: {},
      action: "Check your folders",
    },
  ];
  const transcript = await openToolHistory(
    fixtures,
    separateToolSteps("Try the folder tools.", [
      ...operations.map((operation, index) => ({
        ...operation,
        result: desktopDenial,
        report: `Desktop declined step ${index + 1}.`,
      })),
      {
        id: "declined-save",
        name: writeTool,
        args: {
          grantId: folderGrant,
          path: "budget.txt",
          content: "Keep the budget.",
        },
        result: DECLINED_BY_PERSON,
        report: "I left the budget untouched.",
      },
      {
        id: "declined-command",
        name: "host_run_command",
        args: { grantId: folderGrant, command: "wc -c budget.txt" },
        result: DECLINED_BY_PERSON,
        report: "I left the count unchanged.",
      },
    ]),
  );
  await expect(
    transcript.getByText("I left the count unchanged.", { exact: true }),
  ).toBeVisible();
  for (const { action } of operations) {
    const label = transcript.getByText(`Blocked: ${action}`, { exact: true });
    await expect(label).toHaveCount(
      action === "Save a file" || action === "Run a command" ? 2 : 1,
    );
    await expect(label.first()).toBeVisible();
  }
  await expect(transcript).toContainText("todo.txt");
  await expect(
    transcript.getByText("budget.txt · You declined it.", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("You declined it.", { exact: true }),
  ).toBeVisible();
  await expect(transcript).not.toContainText(
    /Saved a file|Ran a command|Do not try this action|host-grant/,
  );
});

test("folder lists read in words and a successful save names the file and folder", async (fixtures) => {
  const transcript = await openToolHistory(
    fixtures,
    separateToolSteps("Check my folders and save a note.", [
      {
        id: "connected",
        name: "host_list_folders",
        args: {},
        result: folderListing,
        report: "The shared folder is ready.",
      },
      {
        id: "saved",
        name: writeTool,
        args: {
          grantId: folderGrant,
          path: "todo.txt",
          content: "Check the schedule.",
        },
        result: '{"ok":true}',
        report: "The note is saved.",
      },
      {
        id: "offline",
        name: "host_list_folders",
        args: {},
        result: '{"connected":false,"folders":[]}',
        report: "Desktop is no longer connected.",
      },
    ]),
  );
  await expect(
    transcript.getByText("The note is saved.", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("Saved a file", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText(`todo.txt in ${sharedFolder}`, { exact: true }),
  ).toBeVisible();
  const listings = transcript.getByText("Checked your folders", {
    exact: true,
  });
  await expect(listings).toHaveCount(2);
  await listings.nth(0).click();
  await expect(
    transcript.getByText(`Folders it can read: ${sharedFolder}.`, {
      exact: true,
    }),
  ).toBeVisible();
  await listings.nth(1).click();
  await expect(
    transcript.getByText(
      "No folders are shared with this Bot. OpenBot Desktop isn't running.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(transcript).not.toContainText(
    /Blocked|host-grant|grantId|"connected"|"ok"/,
  );
});

test("expanded folder steps keep readable path and content and omit grant IDs and JSON", async (fixtures) => {
  const path = "notes.txt";
  const content = "Pick up the documents.";
  const transcript = await openToolHistory(fixtures, [
    ...history("Update the shared notes.", [
      {
        id: "folders",
        name: "host_list_folders",
        args: {},
        result: folderListing,
      },
      {
        id: "save",
        name: writeTool,
        args: { grantId: folderGrant, path, content },
        result: DECLINED_BY_PERSON,
      },
      {
        id: "command",
        name: "host_run_command",
        args: { grantId: folderGrant, command: "dir" },
        result: JSON.stringify({ grantId: folderGrant }),
      },
      {
        id: "read",
        name: "host_read_file",
        args: { grantId: folderGrant, path: "index.txt" },
        result: "The folder index is current.",
      },
    ]),
    { id: "folder-reply", role: "assistant", content: "I reviewed the notes." },
  ]);
  const issues = transcript.getByText("1 issue", { exact: true });
  await expect(issues).toBeVisible();
  await issues.click();
  const save = transcript.getByRole("listitem").filter({ hasText: path });
  await expect(save.getByText("Blocked", { exact: true })).toBeVisible();
  await save.getByText("Save a file", { exact: true }).click();
  await expect(
    save.getByText(`${path} in ${sharedFolder}`, { exact: true }),
  ).toBeVisible();
  await expect(save.getByText("path", { exact: true })).toBeVisible();
  await expect(save.getByText("content", { exact: true })).toBeVisible();
  await expect(save.getByText(content, { exact: true })).toBeVisible();
  await expect(
    save.getByText("You declined it.", { exact: true }),
  ).toBeVisible();
  const command = transcript
    .getByRole("listitem")
    .filter({ hasText: "Ran a command" });
  await command.getByText("Ran a command", { exact: true }).click();
  await expect(
    command.getByText(`in ${sharedFolder}`, { exact: true }),
  ).toBeVisible();
  await expect(command.getByText("dir", { exact: true })).toBeVisible();
  const read = transcript
    .getByRole("listitem")
    .filter({ hasText: "index.txt" });
  await read.getByText("Read a file", { exact: true }).click();
  await expect(
    read.getByText("The folder index is current.", { exact: true }),
  ).toBeVisible();
  await expect(transcript).not.toContainText(
    /host-grant|grantId|Do not try this action/,
  );
});
