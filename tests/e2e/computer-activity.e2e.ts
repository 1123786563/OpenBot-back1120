import { type Browser, test } from "@e2e-dev/web";
import { expect, type JsonValue } from "e2e";
import {
  DECLINED_BY_PERSON,
  HANDLED_BY_PERSON,
} from "../../shared/approval-outcomes";
import { observeLiveScreen } from "./browser-screen-stream";
import {
  chatEventStream,
  chatRunPath,
  configureChatStream,
  readChatRun,
} from "./chat-stream";
import {
  computerConversation,
  computerStep,
  type Fixtures,
  serveComputer,
  serveTerminalStream,
  site,
} from "./computer-fixtures";
import { createConversation, readThreadId } from "./conversations";
import { createBot } from "./signed-in";
import { stageChatRun } from "./staged-chat-stream";

test("reopening a conversation restores Computer commands and file saves once, without invented times", async (fixtures) => {
  const { browser, screen } = fixtures;
  const history = [
    {
      id: "ask-disk",
      role: "user",
      content: "Check the disk and save a note.",
    },
    ...computerStep(
      "disk",
      "computer_run_command",
      { command: "df -h /" },
      {
        ok: true,
        stdout: "/dev/root  20G  4.1G  16G  21% /\n",
        exitCode: 0,
      },
    ),
    ...computerStep(
      "note",
      "computer_write_file",
      { path: "disk.md", contents: "21% used" },
      {
        ok: true,
        path: "disk.md",
        bytes: 8,
        appended: false,
      },
    ),
    { id: "disk-summary", role: "assistant", content: "The disk is 21% full." },
  ];
  let runs = 0;
  await browser.route(chatRunPath, (route) => {
    runs++;
    return route.fulfill({
      status: 500,
      json: { error: "Opening history should not start a run" },
    });
  });

  await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { history, terminal: true },
  );
  const rows = screen
    .getByRole("region", "Computer sidebar", { exact: true })
    .getByRole("listitem");
  const times = browser.locator('[aria-label="Computer sidebar"] li time');
  const reply = screen
    .getByRole("region", "Messages", { exact: true })
    .getByText("The disk is 21% full.", { exact: true });
  async function assertRestoredHistory() {
    await expect(reply).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("disk.md");
    await expect(rows.nth(0)).toContainText("8 bytes");
    await expect(rows.nth(0)).not.toContainText("21% used");
    await expect(rows.nth(1)).toContainText("df -h /");
    await expect(rows.nth(1)).toContainText(
      /\/dev\/root\s+20G\s+4\.1G\s+16G\s+21%/,
    );
    await expect(times).toHaveCount(0);
    expect(runs).toBe(0);
  }
  await assertRestoredHistory();
  await browser.reload();
  await assertRestoredHistory();
});

test("restored browser Activity lists completed and refused steps without exposing typed contents", async (fixtures) => {
  const { browser, screen } = fixtures;
  const blocked = "https://blocked.example.test/private";
  const history = [
    { id: "ask-release", role: "user", content: "Find the latest release." },
    ...computerStep(
      "opened",
      "computer_navigate",
      { url: site },
      { ok: true, url: site, title: "Fixture releases" },
    ),
    ...computerStep(
      "looked",
      "computer_snapshot",
      {},
      { ok: true, url: site, elements: [] },
    ),
    ...computerStep(
      "stale",
      "computer_click",
      { ref: "e7", snapshotId: 2 },
      {
        ok: false,
        snapshotRequired: true,
        reason: "Take a fresh snapshot first.",
      },
    ),
    ...computerStep(
      "filled",
      "computer_type",
      {
        ref: "e12",
        snapshotId: 3,
        text: "private-search-fixture",
        submit: true,
      },
      {
        ok: true,
        action: "type",
        ref: "e12",
        url: site,
        element: { role: "searchbox", name: "Find a release" },
      },
    ),
    ...computerStep(
      "blocked",
      "computer_navigate",
      { url: blocked },
      {
        ok: false,
        refused: true,
        reason: "This address is not allowed.",
      },
    ),
    {
      id: "release-summary",
      role: "assistant",
      content: "The latest release is 1.0.1.",
    },
  ];
  await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { history },
  );
  const activity = screen.getByRole("region", "Computer sidebar", {
    exact: true,
  });
  const rows = activity.getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText(blocked);
  await expect(rows.nth(0)).toContainText("This address is not allowed.");
  await expect(rows.nth(1)).toContainText("Filled in field");
  await expect(rows.nth(1)).toContainText("Find a release");
  await expect(rows.nth(2)).toContainText("Inspected page");
  await expect(rows.nth(3)).toContainText("Opened page");
  await expect(rows.nth(3)).toContainText("Fixture releases");
  await expect(activity).not.toContainText("private-search-fixture");
  await expect(activity).not.toContainText("fresh snapshot");
  await expect(activity).not.toContainText("Nothing yet");
  await expect(
    browser.locator('[aria-label="Computer sidebar"] li time'),
  ).toHaveCount(0);
});

type LiveComputerStep = {
  id: string;
  name: string;
  args: object;
  result: JsonValue;
  directPath?: string;
};

async function serveLiveComputerActivity(
  browser: Browser,
  steps: readonly LiveComputerStep[],
  reply: string,
) {
  let runs = 0;
  const requests: { path: string; step: unknown }[] = [];
  await browser.route(chatRunPath, (route) => {
    const { runId, threadId } = readChatRun(
      route.request.postData ?? undefined,
    );
    const step = steps[runs++];
    const output = step
      ? [
          {
            type: "TOOL_CALL_START",
            toolCallId: step.id,
            toolCallName: step.name,
            parentMessageId: `message-${step.id}`,
          },
          {
            type: "TOOL_CALL_ARGS",
            toolCallId: step.id,
            delta: JSON.stringify(step.args),
          },
          { type: "TOOL_CALL_END", toolCallId: step.id },
        ]
      : [
          {
            type: "TEXT_MESSAGE_START",
            messageId: "activity-reply",
            role: "assistant",
          },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "activity-reply",
            delta: reply,
          },
          { type: "TEXT_MESSAGE_END", messageId: "activity-reply" },
        ];
    return route.fulfill(
      chatEventStream([
        { type: "RUN_STARTED", runId, threadId },
        ...output,
        { type: "RUN_FINISHED", runId, threadId },
      ]),
    );
  });
  await browser.route(
    /\/api\/approvals\/computer\/[^/?]+$|\/api\/computers\/[^/]+\/(?:exec|files\/read|files\/write|navigate|click|type)$/,
    (route) => {
      const path = new URL(route.request.url).pathname;
      const step: unknown = JSON.parse(route.request.postData ?? "null");
      requests.push({ path, step });
      const call = steps.find((candidate) =>
        candidate.directPath
          ? path.endsWith(candidate.directPath)
          : path.startsWith("/api/approvals/computer/") &&
            step !== null &&
            typeof step === "object" &&
            "toolCallId" in step &&
            step.toolCallId === candidate.id,
      );
      if (!call)
        return route.fulfill({
          status: 400,
          json: { error: "Unexpected Computer request" },
        });
      return route.fulfill({
        json: call.directPath ? call.result : { result: call.result },
      });
    },
  );
  return { requests, runs: () => runs };
}

test("live Computer Activity shows command output, exit status and file details as the Bot works", async (fixtures) => {
  const { browser, screen } = fixtures;
  const reply = "Checked the system and saved the shopping note.";
  const steps: LiveComputerStep[] = [
    {
      id: "system",
      name: "computer_run_command",
      args: { command: "uname -a" },
      result: {
        ok: true,
        command: "uname -a",
        stdout: "Linux fixture 6.1.0 x86_64 GNU/Linux\n",
        exitCode: 0,
      },
    },
    {
      id: "missing",
      name: "computer_run_command",
      args: { command: "ls /missing" },
      result: {
        ok: true,
        command: "ls /missing",
        stderr: "ls: cannot access '/missing': No such file or directory\n",
        exitCode: 2,
      },
    },
    {
      id: "save",
      name: "computer_write_file",
      args: { path: "notes.md", contents: "Buy milk\n" },
      result: { ok: true, path: "notes.md", bytes: 9, appended: false },
    },
    {
      id: "read",
      name: "computer_read_file",
      args: { path: "notes.md" },
      directPath: "/files/read",
      result: {
        path: "notes.md",
        text: "Buy milk\n",
        bytes: 9,
        truncated: false,
      },
    },
  ];
  const live = await serveLiveComputerActivity(browser, steps, reply);
  const { bot } = await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { terminal: true },
  );
  const panel = screen.getByRole("region", "Computer sidebar", { exact: true });
  await expect(panel.getByText(/Nothing yet/)).toBeVisible();
  await screen
    .getByRole("textbox", "Message", { exact: true })
    .fill("Check the system and note that I need milk.");
  await screen.getByRole("button", "Send message", { exact: true }).click();
  await expect(
    screen
      .getByRole("region", "Messages", { exact: true })
      .getByText(reply, { exact: true }),
  ).toBeVisible();
  const rows = panel.getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Read");
  await expect(rows.nth(0)).toContainText("Buy milk");
  await expect(rows.nth(1)).toContainText("Saved");
  await expect(rows.nth(1)).toContainText("notes.md");
  await expect(rows.nth(1)).toContainText("9 bytes");
  await expect(rows.nth(1)).not.toContainText("Buy milk");
  await expect(rows.nth(2)).toContainText("ls /missing");
  await expect(rows.nth(2)).toContainText("Exit 2");
  await expect(rows.nth(2)).toContainText("No such file or directory");
  await expect(rows.nth(3)).toContainText("uname -a");
  await expect(rows.nth(3)).toContainText(
    "Linux fixture 6.1.0 x86_64 GNU/Linux",
  );
  await expect(
    browser.locator('[aria-label="Computer sidebar"] li time[datetime]'),
  ).toHaveCount(4);
  const [system, missing, save] = steps;
  expect(live.requests).toEqual([
    ...[system, missing, save].map(({ id, name, args }) => ({
      path: `/api/approvals/computer/${bot.id}`,
      step: expect.objectContaining({ toolCallId: id, toolName: name, args }),
    })),
    {
      path: `/api/computers/${bot.id}/files/read`,
      step: expect.objectContaining({ path: "notes.md" }),
    },
  ]);
  expect(live.runs()).toBe(steps.length + 1);
});

test("live browser Activity identifies the opened page, clicked link and filled field while masking its input", async (fixtures) => {
  const { browser, screen } = fixtures;
  const reply = "The latest release is 1.0.1.";
  const privateInput = "private-live-search-fixture";
  const steps: LiveComputerStep[] = [
    {
      id: "open",
      name: "computer_navigate",
      args: { url: site },
      directPath: "/navigate",
      result: {
        url: site,
        title: "Fixture releases",
        text: "Release 1.0.1",
        truncated: false,
      },
    },
    {
      id: "type",
      name: "computer_type",
      args: { ref: "e12", snapshotId: 3, text: privateInput, submit: true },
      result: {
        ok: true,
        action: "type",
        ref: "e12",
        url: site,
        element: { role: "searchbox", name: "Find a release" },
      },
    },
    {
      id: "click",
      name: "computer_click",
      args: { ref: "e7", snapshotId: 3 },
      result: {
        ok: true,
        action: "click",
        ref: "e7",
        url: site,
        element: { role: "link", name: "OpenBot 1.0.1" },
      },
    },
  ];
  const live = await serveLiveComputerActivity(browser, steps, reply);
  const { bot } = await computerConversation(fixtures, {
    status: "ready",
    frame: "frame",
  });
  const panel = screen.getByRole("region", "Computer sidebar", { exact: true });
  await expect(panel.getByText(/Nothing yet/)).toBeVisible();
  await screen
    .getByRole("textbox", "Message", { exact: true })
    .fill("Find the latest release.");
  await screen.getByRole("button", "Send message", { exact: true }).click();
  await expect(
    screen
      .getByRole("region", "Messages", { exact: true })
      .getByText(reply, { exact: true }),
  ).toBeVisible();
  const rows = panel.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Clicked on page");
  await expect(rows.nth(0)).toContainText("OpenBot 1.0.1");
  await expect(rows.nth(1)).toContainText("Filled in field");
  await expect(rows.nth(1)).toContainText("Find a release");
  await expect(rows.nth(2)).toContainText("Opened page");
  await expect(rows.nth(2)).toContainText(site);
  await expect(rows.nth(2)).toContainText("Fixture releases");
  await expect(panel).not.toContainText(privateInput);
  await expect(
    browser.locator('[aria-label="Computer sidebar"] li time[datetime]'),
  ).toHaveCount(3);
  expect(live.requests).toEqual([
    {
      path: `/api/computers/${bot.id}/navigate`,
      step: expect.objectContaining({ url: site }),
    },
    ...steps.slice(1).map(({ id, name, args }) => ({
      path: `/api/approvals/computer/${bot.id}`,
      step: expect.objectContaining({ toolCallId: id, toolName: name, args }),
    })),
  ]);
  expect(live.runs()).toBe(steps.length + 1);
});

const approvalCommand = "printf 'approval fixture'";
const approvalCard = {
  title: "Print a confirmation",
  summary: "Run the command in the workspace to print a confirmation.",
  details: [{ label: "Command", value: approvalCommand }],
  command: approvalCommand,
  approveLabel: "Run command",
  rejectLabel: "Skip command",
};

async function enableComputerApprovalCard(browser: Browser) {
  await browser.route(/\/api\/components\/for-agent\/[^/?]+$/, (route) =>
    route.fulfill({
      json: {
        components: [
          { name: "askApproval", description: "Ask about a command" },
        ],
      },
    }),
  );
}

for (const approved of [true, false]) {
  test(`a command ${approved ? "approved" : "declined"} on the Bot's own card appears in Activity once`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const reply = approved
      ? "Printed the confirmation."
      : "I skipped the command.";
    const steps: LiveComputerStep[] = [
      { id: "approval", name: "askApproval", args: approvalCard, result: null },
    ];
    if (approved)
      steps.push({
        id: "confirmation",
        name: "computer_run_command",
        args: { command: approvalCommand },
        result: {
          ok: true,
          command: approvalCommand,
          stdout: "approval fixture",
          exitCode: 0,
        },
      });
    await enableComputerApprovalCard(browser);
    const live = await serveLiveComputerActivity(browser, steps, reply);
    const { bot } = await computerConversation(
      fixtures,
      { status: "ready", frame: "frame" },
      { terminal: true },
    );
    const messages = screen.getByRole("region", "Messages", { exact: true });
    const panel = screen.getByRole("region", "Computer sidebar", {
      exact: true,
    });
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("Ask me before printing a confirmation.");
    await screen.getByRole("button", "Send message", { exact: true }).click();
    await expect(
      messages.getByText(approvalCard.title, { exact: true }),
    ).toBeVisible();
    const command = messages.getByText(approvalCommand, { exact: true });
    await expect(command).toBeVisible();
    await expect(command).toHaveCount(1);
    await expect(panel.getByText(/Nothing yet/)).toBeVisible();
    const choice = approved
      ? approvalCard.approveLabel
      : approvalCard.rejectLabel;
    if (!approved)
      await messages.getByRole("radio", choice, { exact: true }).click();
    await messages.getByRole("button", choice, { exact: true }).click();
    await expect(messages.getByText(reply, { exact: true })).toBeVisible();

    const rows = panel.getByRole("listitem");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(approvalCommand);
    await expect(
      browser.locator('[aria-label="Computer sidebar"] li time[datetime]'),
    ).toHaveCount(1);
    if (approved) {
      await expect(
        rows.getByText("approval fixture", { exact: true }),
      ).toBeVisible();
      await expect(rows).not.toContainText("You declined it.");
      expect(live.requests).toEqual([
        {
          path: `/api/approvals/computer/${bot.id}`,
          step: expect.objectContaining({
            toolCallId: "confirmation",
            toolName: "computer_run_command",
            args: { command: approvalCommand },
          }),
        },
      ]);
    } else {
      await expect(rows).toHaveText(/^Declined/);
      await expect(rows).toContainText("You declined it.");
      await expect(messages.getByText("Declined", { exact: true })).toHaveCount(
        1,
      );
      await expect(rows.getByText("Declined", { exact: true })).toHaveCount(2);
      expect(live.requests).toEqual([]);
    }
    expect(live.runs()).toBe(steps.length + 1);
  });
}

test("a restored command declined on the Bot's own card keeps its status without adding a time", async (fixtures) => {
  const { browser, screen } = fixtures;
  await enableComputerApprovalCard(browser);
  const live = await serveLiveComputerActivity(
    browser,
    [],
    "Unexpected continuation.",
  );
  const history = [
    {
      id: "ask-before-printing",
      role: "user",
      content: "Ask me before printing a confirmation.",
    },
    ...computerStep("approved-print", "askApproval", approvalCard, {
      decision: "declined",
    }),
    { id: "skip-reply", role: "assistant", content: "I skipped the command." },
  ];
  await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { history, terminal: true },
  );
  const rows = screen
    .getByRole("region", "Computer sidebar", { exact: true })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveText(/^Declined/);
  await expect(rows).toContainText(approvalCommand);
  await expect(rows).toContainText("You declined it.");
  await expect(
    browser.locator('[aria-label="Computer sidebar"] li time'),
  ).toHaveCount(0);
  expect(live.requests).toEqual([]);
  expect(live.runs()).toBe(0);
});

test("Activity replay waits for stored results without timestamping them as live work", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await serveComputer(browser, bot.id, { status: "ready", frame: "frame" });
  await serveTerminalStream(browser, bot.id);
  await observeLiveScreen(browser, bot.id);

  const question = {
    id: "replay-question",
    role: "user",
    content: "Run date, then save a note.",
  };
  const date = computerStep(
    "date",
    "computer_run_command",
    { command: "date" },
    {
      ok: true,
      command: "date",
      stdout: "Wed Nov 4 05:31:25 UTC 2026",
      exitCode: 0,
    },
  );
  const save = computerStep(
    "save-note",
    "computer_write_file",
    { path: "notes.md", contents: "hello" },
    {
      ok: true,
      path: "notes.md",
      bytes: 5,
      appended: false,
    },
  );
  const reply = {
    id: "note-reply",
    role: "assistant",
    content: "Saved hello to notes.md.",
  };
  let replayFinished = false;
  await configureChatStream(browser, [], async () =>
    replayFinished ? [question, ...date, ...save, reply] : [],
  );
  let runs = 0;
  await browser.route(chatRunPath, (route) => {
    runs++;
    return route.fulfill({
      status: 500,
      json: { error: "Replay should not execute tools again" },
    });
  });

  function replayStart(threadId: string, runId: string, messages: object[]) {
    return {
      type: "RUN_STARTED",
      threadId,
      runId,
      input: {
        threadId,
        runId,
        messages,
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    };
  }
  function replayCall(id: string, name: string, args: object) {
    return [
      {
        type: "TOOL_CALL_START",
        toolCallId: id,
        toolCallName: name,
        parentMessageId: `call-message-${id}`,
      },
      { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
      { type: "TOOL_CALL_END", toolCallId: id },
    ];
  }
  using stream = await stageChatRun(
    browser,
    ({ threadId }) => [
      replayStart(threadId, "date-run", [question]),
      ...replayCall("date", "computer_run_command", { command: "date" }),
      { type: "RUN_FINISHED", threadId, runId: "date-run" },
    ],
    ({ threadId }) => [
      replayStart(threadId, "save-run", [question, ...date]),
      ...replayCall("save-note", "computer_write_file", {
        path: "notes.md",
        contents: "hello",
      }),
      { type: "RUN_FINISHED", threadId, runId: "save-run" },
      replayStart(threadId, "reply-run", [question, ...date, ...save]),
      { type: "TEXT_MESSAGE_START", messageId: reply.id, role: "assistant" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: reply.id,
        delta: reply.content,
      },
      { type: "TEXT_MESSAGE_END", messageId: reply.id },
      { type: "RUN_FINISHED", threadId, runId: "reply-run" },
    ],
    /\/api\/copilotkit\/agent\/[^/]+\/connect$/,
  );
  await app.open(`/channel/${channel}?watch=true`);
  const panel = screen.getByRole("region", "Computer sidebar", { exact: true });
  await expect(
    panel.getByRole("tab", "Terminal", { exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const rows = panel.getByRole("listitem");
  await expect(rows).toHaveCount(0);
  replayFinished = true;
  stream.finish();
  await expect(
    screen
      .getByRole("region", "Messages", { exact: true })
      .getByText(reply.content, { exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("notes.md");
  await expect(rows.nth(1)).toContainText("Wed Nov 4 05:31:25 UTC 2026");
  await expect(
    browser.locator('[aria-label="Computer sidebar"] li time'),
  ).toHaveCount(0);
  expect(runs).toBe(0);
});

type GateApproval = {
  name: "computer_run_command" | "computer_write_file";
  args: Readonly<Record<string, JsonValue>>;
  question: string;
  reply: string;
  choice: "allow_once" | "deny" | "handled";
  result: string;
  heldBeforeOpen?: boolean;
};

async function openWithComputerApproval(
  fixtures: Fixtures,
  scenario: GateApproval,
) {
  const { app, browser } = fixtures;
  const bot = await createBot(fixtures);
  const channelId = await createConversation(browser, bot.id);
  const threadId = await readThreadId(browser, channelId);
  const callId = "tool-held-by-gate";
  const approvalId = "held-approval";
  const [call] = computerStep(callId, scenario.name, scenario.args, {});
  const resume = {
    id: "after-decision",
    role: "assistant",
    content: scenario.reply,
  };
  const answer = {
    id: "resolved-tool",
    role: "tool",
    toolCallId: callId,
    content: scenario.result,
  };
  let stored: object[] = scenario.heldBeforeOpen
    ? [{ id: "earlier-prompt", role: "user", content: scenario.question }, call]
    : [];
  let inbox: "missing" | "pending" | "completed" = scenario.heldBeforeOpen
    ? "pending"
    : "missing";
  const gateRequests: unknown[] = [];
  const decisions: unknown[] = [];
  const direct: string[] = [];
  const runs: unknown[][] = [];

  await browser.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    const roster = new Set<WebSocket>();
    window.WebSocket = new Proxy(NativeSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        if (new URL(socket.url).pathname === "/api/channels/events") {
          roster.add(socket);
          socket.addEventListener("close", () => roster.delete(socket), {
            once: true,
          });
        }
        return socket;
      },
    });
    Object.defineProperty(window, "emitApprovalChannelEvent", {
      value(event: object) {
        if (!roster.size)
          throw new Error("The channel activity socket is missing");
        for (const socket of roster)
          socket.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify(event) }),
          );
      },
    });
  });

  await configureChatStream(browser, [], async () => stored);
  await browser.route(
    /\/api\/copilotkit\/agent\/[^/]+\/stop\/[^/?]+$/,
    (route) => route.fulfill({ json: { ok: true } }),
  );
  await browser.route(/\/api\/copilotkit\/agent\/[^/]+\/connect$/, (route) => {
    const runId = "opening-gated-activity";
    return route.fulfill(
      chatEventStream([
        { type: "RUN_STARTED", threadId, runId },
        { type: "MESSAGES_SNAPSHOT", messages: stored },
        { type: "RUN_FINISHED", threadId, runId },
      ]),
    );
  });
  await browser.route(chatRunPath, (route) => {
    const { runId, threadId, messages } = readChatRun(
      route.request.postData ?? undefined,
    );
    runs.push(messages);
    if (inbox === "completed") {
      const followup = {
        id: "after-thanks",
        role: "assistant",
        content: "You're welcome.",
      };
      const lastQuestion = messages.findLast(
        (message) =>
          message &&
          typeof message === "object" &&
          "role" in message &&
          message.role === "user",
      );
      if (lastQuestion && typeof lastQuestion === "object")
        stored = [...stored, lastQuestion, followup];
      return route.fulfill(
        chatEventStream([
          { type: "RUN_STARTED", threadId, runId },
          {
            type: "TEXT_MESSAGE_START",
            messageId: followup.id,
            role: "assistant",
          },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: followup.id,
            delta: followup.content,
          },
          { type: "TEXT_MESSAGE_END", messageId: followup.id },
          { type: "RUN_FINISHED", threadId, runId },
        ]),
      );
    }
    stored = [
      ...messages.filter(
        (message): message is object =>
          !!message && typeof message === "object",
      ),
      call,
    ];
    return route.fulfill(
      chatEventStream([
        { type: "RUN_STARTED", threadId, runId },
        {
          type: "TOOL_CALL_START",
          toolCallId: callId,
          toolCallName: scenario.name,
          parentMessageId: call.id,
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: callId,
          delta: JSON.stringify(scenario.args),
        },
        { type: "TOOL_CALL_END", toolCallId: callId },
        { type: "RUN_FINISHED", threadId, runId },
      ]),
    );
  });
  await browser.route(
    new RegExp(`/api/approvals/computer/${RegExp.escape(bot.id)}$`),
    (route) => {
      gateRequests.push(JSON.parse(route.request.postData ?? "null"));
      inbox = "pending";
      return route.fulfill({
        status: 202,
        json: {
          waiting: true,
          approvalId,
          reason: "This action needs your approval.",
        },
      });
    },
  );
  await browser.route(/\/api\/approvals(?:\?[^#]*)?$/, (route) =>
    route.fulfill({
      json: {
        enabled: true,
        requests:
          inbox === "missing"
            ? []
            : [
                {
                  id: approvalId,
                  status: inbox,
                  createdAt: new Date().toISOString(),
                  action: {
                    botId: bot.id,
                    toolRef: scenario.name,
                    toolCallId: callId,
                    effect: "write",
                    scope: "workspace",
                    args: scenario.args,
                    threadId,
                    target: {},
                    ...(scenario.choice === "handled"
                      ? {
                          policy: {
                            behaviour: "hand_off",
                            source: "safety",
                            reason: "This change belongs to the person.",
                          },
                        }
                      : {}),
                  },
                },
              ],
        rules: [],
        teamRules: [],
        questions: [],
      },
    }),
  );
  await browser.route(/\/api\/approvals\/threads\/[^/?]+$/, (route) =>
    route.fulfill({ json: { asksEveryStep: false } }),
  );
  await browser.route(
    new RegExp(`/api/approvals/${approvalId}/decision$`),
    (route) => {
      decisions.push(JSON.parse(route.request.postData ?? "null"));
      inbox = "completed";
      return route.fulfill({ json: { ok: true } });
    },
  );
  await browser.route(
    new RegExp(`/api/computers/${RegExp.escape(bot.id)}/(?:exec|files/write)$`),
    (route) => {
      direct.push(new URL(route.request.url).pathname);
      return route.fulfill({
        status: 400,
        json: { error: "The browser should not execute a held action" },
      });
    },
  );
  await serveComputer(browser, bot.id, { status: "ready", frame: "frame" });
  await serveTerminalStream(browser, bot.id);
  await observeLiveScreen(browser, bot.id);
  await app.open(`/channel/${channelId}?watch=true`);

  return {
    decisions,
    direct,
    gateRequests,
    runs,
    async announceContinuation() {
      stored = [...stored, answer, resume];
      await browser.evaluate(
        (event) => {
          Reflect.get(window, "emitApprovalChannelEvent")(event);
          return null;
        },
        {
          channelId,
          lastMessage: scenario.reply,
          lastMessageAt: new Date().toISOString(),
          lastMessageAgentId: bot.id,
        },
      );
    },
  };
}

const commandApprovals = [
  {
    name: "computer_run_command",
    args: { command: "date" },
    question: "What's the date?",
    reply: "It is Wednesday, 4 November.",
    choice: "allow_once",
    expected: "Wed Nov 4 06:01:02 UTC 2026",
  },
  {
    name: "computer_run_command",
    args: { command: "date" },
    question: "What's the date?",
    reply: "It is Wednesday, 4 November.",
    choice: "allow_once",
    expected: "Wed Nov 4 06:01:02 UTC 2026",
    heldBeforeOpen: true,
  },
  {
    name: "computer_run_command",
    args: { command: "date" },
    question: "Ask before reading the date.",
    reply: "I skipped the date command.",
    choice: "deny",
    expected: "You declined it.",
  },
  {
    name: "computer_run_command",
    args: { command: "passwd" },
    question: "Help me change my password.",
    reply: "Thanks, I'll carry on from your new password.",
    choice: "handled",
    expected: "You did it yourself.",
  },
] as const;

for (const scenario of commandApprovals) {
  const openedEarlier = "heldBeforeOpen" in scenario;
  test(`Computer Activity shows a gated command decided with ${scenario.choice}${openedEarlier ? " after reopening" : ""}`, async (fixtures) => {
    const { browser, screen } = fixtures;
    const activity = await openWithComputerApproval(fixtures, {
      ...scenario,
      result:
        scenario.choice === "allow_once"
          ? JSON.stringify({
              ok: true,
              command: scenario.args.command,
              stdout: scenario.expected,
              exitCode: 0,
            })
          : scenario.choice === "deny"
            ? DECLINED_BY_PERSON
            : HANDLED_BY_PERSON,
    });
    const messages = screen.getByRole("region", "Messages", { exact: true });
    const panel = screen.getByRole("region", "Computer sidebar", {
      exact: true,
    });
    const rows = panel.getByRole("listitem");
    if (!openedEarlier) {
      await screen
        .getByRole("textbox", "Message", { exact: true })
        .fill(scenario.question);
      await screen.getByRole("button", "Send message", { exact: true }).click();
    }
    const choice =
      scenario.choice === "allow_once"
        ? "Allow once"
        : scenario.choice === "deny"
          ? "Deny"
          : "I did it myself";
    if (scenario.choice === "deny")
      await messages.getByRole("radio", choice, { exact: true }).click();
    const decision = messages.getByRole("button", choice, { exact: true });
    await expect(decision).toBeVisible();
    await expect(rows).toHaveCount(0);
    await decision.click();
    await expect
      .poll(() => activity.decisions)
      .toEqual([{ decision: scenario.choice }]);
    await expect(rows).toHaveCount(0);
    await activity.announceContinuation();

    await expect(
      messages.getByText(scenario.reply, { exact: true }),
    ).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(scenario.args.command);
    await expect(rows).toContainText(scenario.expected);
    await expect(
      browser.locator('[aria-label="Computer sidebar"] li time[datetime]'),
    ).toHaveCount(1);
    if (scenario.choice !== "allow_once") {
      await expect(
        messages.getByText(scenario.expected, { exact: true }),
      ).toBeVisible();
      await expect(messages).not.toContainText(
        /It printed nothing|Do not try this action|Do not repeat it/,
      );
      await expect(panel).not.toContainText(
        /It printed nothing|Do not try this action|Do not repeat it/,
      );
    }
    if (scenario.choice === "deny") await expect(rows).toHaveText(/^Declined/);
    if (scenario.choice === "handled") {
      await expect(
        messages.getByText("Done by you", { exact: true }),
      ).toBeVisible();
      await expect(rows).not.toContainText("Blocked");
    }
    expect(activity.gateRequests).toEqual(
      openedEarlier
        ? []
        : [
            expect.objectContaining({
              toolName: scenario.name,
              toolCallId: "tool-held-by-gate",
              args: scenario.args,
            }),
          ],
    );
    expect(activity.runs).toHaveLength(openedEarlier ? 0 : 1);
    expect(activity.direct).toEqual([]);
  });
}

test("a declined file save stays declined through another message and reload", async (fixtures) => {
  const { browser, screen } = fixtures;
  const file = "notes.txt";
  const contents = "private contents that will never be written";
  const reply = "I didn't save notes.txt because you declined.";
  const activity = await openWithComputerApproval(fixtures, {
    name: "computer_write_file",
    args: { path: file, contents },
    question: "Save a note for me.",
    reply,
    choice: "deny",
    result: DECLINED_BY_PERSON,
  });
  const messages = screen.getByRole("region", "Messages", { exact: true });
  const panel = screen.getByRole("region", "Computer sidebar", { exact: true });
  const composer = screen.getByRole("textbox", "Message", { exact: true });
  const send = screen.getByRole("button", "Send message", { exact: true });
  const rows = panel.getByRole("listitem");
  async function assertDeclinedFile() {
    await expect(
      messages.getByText("Blocked: Save a file", { exact: true }),
    ).toBeVisible();
    await expect(
      messages.getByText(`${file} · You declined it.`, { exact: true }),
    ).toBeVisible();
    await expect(messages).not.toContainText(
      /Saved a file|Do not try this action/,
    );
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(file);
    await expect(rows).toContainText("You declined it.");
    await expect(rows).not.toContainText(contents);
  }

  await composer.fill("Save a note for me.");
  await send.click();
  await messages.getByRole("radio", "Deny", { exact: true }).click();
  await messages.getByRole("button", "Deny", { exact: true }).click();
  await expect.poll(() => activity.decisions).toEqual([{ decision: "deny" }]);
  await activity.announceContinuation();
  await expect(messages.getByText(reply, { exact: true })).toBeVisible();
  await assertDeclinedFile();

  await composer.fill("Thanks.");
  await send.click();
  const thanks = messages.getByText("You're welcome.", { exact: true });
  await expect(thanks).toBeVisible();
  await assertDeclinedFile();
  expect(activity.runs).toHaveLength(2);
  expect(
    activity.runs
      .at(-1)
      ?.filter(
        (message) =>
          message &&
          typeof message === "object" &&
          "toolCallId" in message &&
          message.toolCallId === "tool-held-by-gate",
      ),
  ).toEqual([
    expect.objectContaining({ role: "tool", content: DECLINED_BY_PERSON }),
  ]);

  await browser.reload();
  await expect(thanks).toBeVisible();
  await assertDeclinedFile();
  expect(activity.direct).toEqual([]);
  expect(activity.gateRequests).toHaveLength(1);
});
