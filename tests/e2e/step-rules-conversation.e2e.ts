import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { NOT_RUN_AFTER_FAILURE } from "../../shared/approval-outcomes";
import { NOT_ASKED, NOT_DRAWN } from "../../shared/tool-steps";
import type { readChatRun } from "./chat-stream";
import { computerConversation } from "./computer-fixtures";
import { stageChatRun } from "./staged-chat-stream";

type Call = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  answered?: string;
};
type Turn = { step: Call[] } | { reply: string };
type Message = {
  id: string;
  role: string;
  content?: string;
  toolCallId?: string;
  toolCalls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
};

async function serveSteps(browser: Browser, turns: Turn[]) {
  let stored: Message[] = [];
  const runs: ReturnType<typeof readChatRun>[] = [];
  await browser.route(/\/api\/components\/for-agent\/[^/?]+$/, (route) =>
    route.fulfill({
      json: {
        components: ["showBarChart", "showTable", "askApproval"].map(
          (name) => ({
            name,
            description: `Fixture ${name}`,
          }),
        ),
      },
    }),
  );
  await browser.route(/\/api\/components\/[^/]+\/decision$/, (route) =>
    route.fulfill({ json: { allowed: true } }),
  );
  const stream = await stageChatRun(
    browser,
    (run) => {
      runs.push(run);
      const held = new Set(stored.map((message) => message.id));
      for (const message of run.messages as Message[]) {
        if (held.has(message.id)) continue;
        if (message.role === "tool")
          stored = stored.filter(
            (saved) =>
              saved.role !== "tool" || saved.toolCallId !== message.toolCallId,
          );
        stored.push(message);
      }
      const ids = { threadId: run.threadId, runId: run.runId };
      const turn = turns[runs.length - 1];
      if (!turn) throw new Error("Unexpected extra model run");
      const messageId = `step-${run.runId}`;
      if ("reply" in turn) {
        stored.push({ id: messageId, role: "assistant", content: turn.reply });
        return [
          { type: "RUN_STARTED", ...ids },
          { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
          { type: "TEXT_MESSAGE_CONTENT", messageId, delta: turn.reply },
          { type: "TEXT_MESSAGE_END", messageId },
        ];
      }
      stored.push({
        id: messageId,
        role: "assistant",
        toolCalls: turn.step.map(({ id, name, args }) => ({
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        })),
      });
      for (const call of turn.step) {
        if (call.answered !== undefined)
          stored.push({
            id: `answer-${call.id}`,
            role: "tool",
            toolCallId: call.id,
            content: call.answered,
          });
      }
      return [
        { type: "RUN_STARTED", ...ids },
        ...turn.step.flatMap(({ id, name, args, answered }) => [
          {
            type: "TOOL_CALL_START",
            toolCallId: id,
            toolCallName: name,
            parentMessageId: messageId,
          },
          {
            type: "TOOL_CALL_ARGS",
            toolCallId: id,
            delta: JSON.stringify(args),
          },
          { type: "TOOL_CALL_END", toolCallId: id },
          ...(answered === undefined
            ? []
            : [
                {
                  type: "TOOL_CALL_RESULT",
                  messageId: `answer-${id}`,
                  toolCallId: id,
                  role: "tool",
                  content: answered,
                },
              ]),
        ]),
      ];
    },
    (run) => [
      { type: "RUN_FINISHED", threadId: run.threadId, runId: run.runId },
    ],
  );
  return { ...stream, runs, history: () => stored };
}

function answersIn(run: ReturnType<typeof readChatRun> | undefined) {
  return Object.fromEntries(
    (run?.messages ?? []).flatMap((message) => {
      if (
        message === null ||
        typeof message !== "object" ||
        !("role" in message) ||
        message.role !== "tool"
      )
        return [];
      return "toolCallId" in message && "content" in message
        ? [[String(message.toolCallId), message.content]]
        : [];
    }),
  );
}

async function watch(browser: Browser, phrases: string[]) {
  await browser.evaluate((phrases) => {
    const seen = new Set<string>();
    const observer = new MutationObserver(() => {
      const text = document.body.textContent ?? "";
      for (const phrase of phrases) if (text.includes(phrase)) seen.add(phrase);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    Object.defineProperty(window, "stepRuleWatch", {
      configurable: true,
      value: { seen, observer },
    });
    return null;
  }, phrases);
}

async function observed(browser: Browser) {
  return browser.evaluate(() => {
    const { seen, observer } = Reflect.get(window, "stepRuleWatch") as {
      seen: Set<string>;
      observer: MutationObserver;
    };
    observer.disconnect();
    return [...seen];
  });
}

const search: Call = {
  id: "search",
  name: "web_search",
  args: { query: "logistics companies AI initiatives" },
  answered:
    "Halvorsen Freight (Oslo, 1,200 people) announced AI route planning.",
};

const chart = (title: string) => ({
  title,
  basis: "read",
  sources: [{ title: "Search results" }],
  points: [{ label: "Halvorsen Freight", value: 1200 }],
});
const table = (title: string) => ({
  title,
  columns: ["Company", "Employees"],
  rows: [{ cells: ["Halvorsen Freight", 1200] }],
});

test("a chart and table beside a search never flash, but both render after reading and reload", async (fixtures) => {
  const { browser, screen } = fixtures;
  using steps = await serveSteps(browser, [
    {
      step: [
        search,
        {
          id: "chart-early",
          name: "showBarChart",
          args: chart("Drawn before reading"),
        },
        {
          id: "table-early",
          name: "showTable",
          args: table("Listed before reading"),
        },
      ],
    },
    {
      step: [
        {
          id: "chart",
          name: "showBarChart",
          args: chart("Headcount by company"),
        },
        {
          id: "table",
          name: "showTable",
          args: table("Companies and sources"),
        },
      ],
    },
    { reply: "Here are the companies I found." },
  ]);
  await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { search: "", readHistory: steps.history },
  );
  await watch(browser, [
    "Drawn before reading",
    "Listed before reading",
    "Headcount by company",
  ]);
  await screen
    .getByRole("textbox", "Message", { exact: true })
    .fill("Find logistics companies with AI news.");
  await screen.getByRole("button", "Send message", { exact: true }).click();
  await expect.poll(() => steps.runs.length).toBe(1);
  steps.finish();
  await expect(
    screen.getByText("Here are the companies I found.", { exact: true }),
  ).toBeVisible();
  expect(answersIn(steps.runs[1])["chart-early"]).toBe(NOT_DRAWN);
  expect(answersIn(steps.runs[1])["table-early"]).toBe(NOT_DRAWN);
  expect(await observed(browser)).toEqual(["Headcount by company"]);
  await expect(
    screen.getByText("Headcount by company", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Companies and sources", { exact: true }),
  ).toBeVisible();
  for (const id of ["chart", "table"]) {
    expect(answersIn(steps.runs[2])[id]).toBeDefined();
    expect(answersIn(steps.runs[2])[id]).not.toBe(NOT_DRAWN);
  }
  await browser.reload();
  for (const title of ["Headcount by company", "Companies and sources"])
    await expect(screen.getByText(title, { exact: true })).toBeVisible();
  for (const title of ["Drawn before reading", "Listed before reading"])
    await expect(screen.getByText(title, { exact: true })).toHaveCount(0);
  expect(steps.runs).toHaveLength(3);
});

test("an approval beside a search is never offered and the next run receives NOT_ASKED", async (fixtures) => {
  const { browser, screen } = fixtures;
  const title = "Email these five companies?";
  const reply = "I read the results. Here they are before I ask you anything.";
  using steps = await serveSteps(browser, [
    {
      step: [
        search,
        {
          id: "approve-early",
          name: "askApproval",
          args: { title, summary: "Send each one an introduction." },
        },
      ],
    },
    { reply },
  ]);
  await computerConversation(
    fixtures,
    { status: "ready", frame: "frame" },
    { search: "", readHistory: steps.history },
  );
  await watch(browser, [title]);
  await screen
    .getByRole("textbox", "Message", { exact: true })
    .fill("Find logistics companies and offer to email them.");
  await screen.getByRole("button", "Send message", { exact: true }).click();
  await expect.poll(() => steps.runs.length).toBe(1);
  steps.finish();
  await expect(screen.getByText(reply, { exact: true })).toBeVisible();
  expect(answersIn(steps.runs[1])["approve-early"]).toBe(NOT_ASKED);
  expect(await observed(browser)).toEqual([]);
  await expect(
    screen.getByRole("button", "Approve", { exact: true }),
  ).toHaveCount(0);
});

test("typing a form runs fields serially, stops at a stale field, and reports the skipped step", async (fixtures) => {
  const { browser, screen } = fixtures;
  const reply = "The Website field was gone, so I'll look at the form again.";
  using steps = await serveSteps(browser, [
    {
      step: [
        ["type-name", "e1", "Halvorsen Freight"],
        ["type-website", "e2", "halvorsen.com"],
        ["type-headquarters", "e3", "Oslo"],
      ].map(([id, ref, text]) => ({
        id,
        name: "computer_type",
        args: { ref, snapshotId: 3, text },
      })),
    },
    { reply },
  ]);
  const first = Promise.withResolvers<void>();
  const gated: string[] = [];
  let active = 0;
  let mostActive = 0;
  await browser.route(/\/api\/approvals\/computer\/[^/?]+$/, async (route) => {
    const body = JSON.parse(route.request.postData ?? "null");
    gated.push(body.args.ref);
    active++;
    mostActive = Math.max(mostActive, active);
    try {
      if (body.args.ref === "e1") await first.promise;
      return await route.fulfill(
        body.args.ref === "e2"
          ? {
              status: 409,
              json: {
                error:
                  "Element e2 is not on the page any more. Take a fresh snapshot and use the refs from it.",
              },
            }
          : {
              json: {
                result: {
                  ok: true,
                  action: "type",
                  element: { role: "textbox", name: "Account name" },
                },
              },
            },
      );
    } finally {
      active--;
    }
  });
  try {
    await computerConversation(
      fixtures,
      { status: "ready", frame: "frame" },
      { search: "", readHistory: steps.history },
    );
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("Add Halvorsen Freight as a new account.");
    await screen.getByRole("button", "Send message", { exact: true }).click();
    await expect.poll(() => steps.runs.length).toBe(1);
    steps.finish();
    await expect.poll(() => gated.length).toBe(1);
    expect(gated).toEqual(["e1"]);
    first.resolve();
    await expect(screen.getByText(reply, { exact: true })).toBeVisible();
    expect(gated).toEqual(["e1", "e2"]);
    expect(mostActive).toBe(1);
    const answers = answersIn(steps.runs[1]);
    expect(JSON.parse(String(answers["type-name"]))).toMatchObject({
      ok: true,
    });
    expect(JSON.parse(String(answers["type-website"]))).toMatchObject({
      ok: false,
      staleRefs: true,
    });
    expect(answers["type-headquarters"]).toBe(NOT_RUN_AFTER_FAILURE);
    await screen.getByText("Used the browser", { exact: true }).tap();
    await expect(
      screen.getByText(/Not done\. A step before it didn't work\./),
    ).toBeVisible();
  } finally {
    first.resolve();
  }
});
