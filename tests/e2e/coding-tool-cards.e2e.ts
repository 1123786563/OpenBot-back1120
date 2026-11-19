import { type Browser, test } from "@e2e-dev/web";
import { expect, type JsonValue } from "e2e";
import {
  constructed,
  documented,
  recorded,
} from "../../app/tests/coding-tools.fixture";

const fixture = "/tests/browser/coding-transcript.html";
const cardSelector =
  'section[aria-label="Ran a command"], section[aria-label="Edited a file"], section[aria-label="Wrote a file"]';

type Call = { name: string; arguments: string };

async function serve(browser: Browser) {
  let replay: { messages: JsonValue[]; busy: boolean };
  await browser.route(/\/fixture\/coding-transcript$/, (route) =>
    route.fulfill({ json: replay }),
  );
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({
      json: {
        enabled: false,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [],
      },
    }),
  );
  return (calls: Call[], results: (string | undefined)[], busy = false) => {
    const messages: JsonValue[] = [
      { id: "u1", role: "user", content: "Build greet.py and run it." },
    ];
    for (const [index, call] of calls.entries()) {
      const id = `call-${index}`;
      messages.push({
        id: `a-${index}`,
        role: "assistant",
        content: "",
        toolCalls: [{ id, type: "function", function: call }],
      });
      const result = results[index];
      if (result !== undefined)
        messages.push({
          id: `t-${index}`,
          role: "tool",
          toolCallId: id,
          content: result,
        });
    }
    replay = { messages, busy };
  };
}

async function cardNames(browser: Browser) {
  return browser.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll(selector), (card) =>
        card.getAttribute("aria-label"),
      ),
    cardSelector,
  );
}

test("the coding transcript shows a command and its output", async ({
  app,
  browser,
  screen,
}) => {
  const replay = await serve(browser);
  replay([recorded.run], [recorded.run.live]);
  await app.open(fixture);
  const command = screen.getByRole("region", "Ran a command", { exact: true });
  await expect(
    command.getByText(
      "python3 /private/tmp/claude-harness-run/work4/greet.py",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(command.getByText(/Hi, World!\s+Bye, World!/)).toBeVisible();
  await expect(command.getByText(/Running|Exit code/)).toHaveCount(0);
});

test("a command without a result says whether the run is active or stopped", async ({
  app,
  browser,
  screen,
}) => {
  const replay = await serve(browser);
  const command = screen.getByRole("region", "Ran a command", { exact: true });
  for (const busy of [true, false]) {
    replay([recorded.run], [undefined], busy);
    await app.open(fixture);
    await expect(
      command.getByText(busy ? "Running" : "Not completed", { exact: true }),
    ).toBeVisible();
    await expect(
      command.getByText(busy ? "Not completed" : "Running", { exact: true }),
    ).toHaveCount(0);
  }
});

test("a command with 40 output lines folds to six and can expand and collapse", async ({
  app,
  browser,
  screen,
}) => {
  const replay = await serve(browser);
  replay([recorded.longOutput], [recorded.longOutput.live]);
  await app.open(fixture);
  const command = screen.getByRole("region", "Ran a command", { exact: true });
  const more = command.getByRole("button", "Show 34 more lines", {
    exact: true,
  });
  const lines = () =>
    browser.evaluate(
      () =>
        document
          .querySelector('section[aria-label="Ran a command"] pre')
          ?.textContent?.split("\n") ?? [],
    );
  const preview = ["1", "2", "3", "4", "5", "6"];
  await expect(more).toBeVisible();
  expect(await lines()).toEqual(preview);
  await more.click();
  const less = command.getByRole("button", "Show less", { exact: true });
  await expect(less).toBeVisible();
  expect(await lines()).toEqual(
    Array.from({ length: 40 }, (_, i) => String(i + 1)),
  );
  await less.click();
  await expect(more).toBeVisible();
  expect(await lines()).toEqual(preview);
});

for (const encoding of ["live", "history"] as const) {
  test(`a refused edit and a command failure stay visible in ${encoding} data`, async ({
    app,
    browser,
    screen,
  }) => {
    const replay = await serve(browser);
    const { failedCommand, refusedEdit } = recorded;
    replay(
      [failedCommand, refusedEdit],
      [failedCommand[encoding], refusedEdit[encoding]],
    );
    await app.open(fixture);
    const command = screen.getByRole("region", "Ran a command", {
      exact: true,
    });
    const edit = screen.getByRole("region", "Edited a file", { exact: true });
    await expect(
      command.getByText("Exit code 1", { exact: true }),
    ).toBeVisible();
    await expect(
      command.getByText("ls: /definitely/not/here: No such file or directory", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(edit.getByText("Didn't work", { exact: true })).toBeVisible();
  });
}

test("a successful command may print JSON containing an error field", async ({
  app,
  browser,
  screen,
}) => {
  const replay = await serve(browser);
  const { apiError } = constructed;
  replay([apiError], [apiError.result]);
  await app.open(fixture);
  const command = screen.getByRole("region", "Ran a command", { exact: true });
  await expect(
    command.getByText('{"error": true, "message": "rate limited"}', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(command.getByText(/Didn't work|Exit code/)).toHaveCount(0);
});

test("a file edit preserves its path and marks removed and added lines", async ({
  app,
  browser,
  screen,
}) => {
  const replay = await serve(browser);
  replay([recorded.edit], [recorded.edit.live]);
  await app.open(fixture);
  const edit = screen.getByRole("region", "Edited a file", { exact: true });
  await expect(edit.getByText("greet.py", { exact: true })).toHaveAttribute(
    "title",
    "/private/tmp/claude-harness-run/work4/greet.py",
  );
  await expect(edit.getByText("+1", { exact: true })).toBeVisible();
  await expect(edit.getByText("−1", { exact: true })).toBeVisible();
  await expect(edit.getByText("All occurrences", { exact: true })).toHaveCount(
    0,
  );
  const rows = await browser.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Edited a file"] span')]
      .filter((node) =>
        ["Removed:", "Added:"].includes(node.textContent?.trim() ?? ""),
      )
      .map((node) => {
        const line = node.parentElement;
        const block = line?.parentElement;
        if (!block) throw new Error("Missing diff block");
        return {
          text: line?.textContent?.trim(),
          color: getComputedStyle(block).backgroundColor,
        };
      }),
  );
  expect(rows.map(({ text }) => text)).toEqual([
    'Removed:     return f"Hello, {name}!"',
    'Added:     return f"Hi, {name}!"',
  ]);
  expect(rows[0]?.color).toMatch(/oklab|oklch|rgba?/);
  expect(rows[0]?.color).not.toBe(rows[1]?.color);
  replay([constructed.replaceAll], [constructed.replaceAll.result]);
  await app.open(fixture);
  await expect(
    edit.getByText("All occurrences", { exact: true }),
  ).toBeVisible();
});

test("written files fold long additions and multi-edits show their combined diff", async ({
  app,
  browser,
  screen,
}) => {
  const replay = await serve(browser);
  replay([recorded.write], [recorded.write.live]);
  await app.open(fixture);
  const write = screen.getByRole("region", "Wrote a file", { exact: true });
  await expect(write.getByText("+38", { exact: true })).toBeVisible();
  await expect(write.getByText("Removed:", { exact: true })).toHaveCount(0);
  await expect(write.getByText("Added:", { exact: true })).toHaveCount(12);
  await write
    .getByRole("button", "Show 26 more lines", { exact: true })
    .click();
  await expect(write.getByText("Added:", { exact: true })).toHaveCount(38);
  replay([documented.multiEdit], [documented.multiEdit.result]);
  await app.open(fixture);
  const edit = screen.getByRole("region", "Edited a file", { exact: true });
  await expect(edit.getByText("+2", { exact: true })).toBeVisible();
  await expect(edit.getByText("−2", { exact: true })).toBeVisible();
  await expect(edit.getByText("Removed:", { exact: true })).toHaveCount(2);
});

test("folded file reads and searches show what each step found on expansion", async ({
  app,
  browser,
  screen,
}) => {
  const replay = await serve(browser);
  const search = [
    documented.grepFiles,
    documented.grepContent,
    documented.grepNone,
    documented.glob,
  ];
  replay(
    [recorded.read, ...search],
    [recorded.read.history, ...search.map(({ result }) => result)],
  );
  await app.open(fixture);
  const summary = screen.getByText("Read 1 file and searched for 4 patterns", {
    exact: true,
  });
  await expect(summary).toBeVisible();
  expect(await cardNames(browser)).toEqual([]);
  await summary.click();
  const lines = await browser.evaluate(() =>
    [...document.querySelectorAll("ol > li details > summary")].map((node) => {
      const printable = node.cloneNode(true) as HTMLElement;
      for (const hidden of printable.querySelectorAll("[aria-hidden]"))
        hidden.remove();
      return printable.textContent;
    }),
  );
  expect(lines).toEqual([
    "Read 39 linesgreet.py",
    'Found 2 files"def " in workspace',
    'Found 2 matches"def " in greet.py',
    'Found no matches"class "',
    "Found 2 files**/*.py",
  ]);
});

test("a full coding turn shows writes, edits and commands beside folded reads and listings", async ({
  app,
  browser,
  screen,
}) => {
  const replay = await serve(browser);
  const calls = [
    recorded.todoPlan,
    recorded.write,
    recorded.read,
    recorded.edit,
    recorded.failedCommand,
    recorded.failedCommand,
    recorded.run,
  ];
  replay(
    calls,
    calls.map(({ history }) => history),
  );
  await app.open(fixture);
  for (const text of [
    "To-dos",
    "Read 39 lines",
    "Listed 2 directories",
    "2 issues",
  ]) {
    await expect(screen.getByText(text, { exact: true })).toBeVisible();
  }
  expect(await cardNames(browser)).toEqual([
    "Wrote a file",
    "Edited a file",
    "Ran a command",
  ]);
});

test("a tool name shared with Claude Code needs Claude Code arguments to get a coding card", async ({
  app,
  browser,
  screen,
}) => {
  const replay = await serve(browser);
  const other = { name: "Bash", arguments: JSON.stringify({ cmd: "ls" }) };
  replay([other], ["greet.py"]);
  await app.open(fixture);
  await expect(screen.getByText("Bash", { exact: true })).toBeVisible();
  expect(await cardNames(browser)).toEqual([]);
  replay([other, other], ["greet.py", "greet.py"]);
  await app.open(fixture);
  await expect(screen.getByText("Used 2 tools", { exact: true })).toBeVisible();
  expect(await cardNames(browser)).toEqual([]);
});

test("a coding plan and task actions identify progress in readable words", async ({
  app,
  browser,
  screen,
}) => {
  const replay = await serve(browser);
  replay([recorded.todoProgress], [recorded.todoProgress.live]);
  await app.open(fixture);
  const plan = browser.locator("figure").filter({ hasText: "To-dos" });
  await expect(plan.getByText("2 of 4", { exact: true })).toBeVisible();
  const items = await browser.evaluate(() => {
    const figure = [...document.querySelectorAll("figure")].find((node) =>
      node.textContent?.includes("To-dos"),
    );
    return [...(figure?.querySelectorAll("li") ?? [])].map((node) => {
      const copy = node.cloneNode(true) as HTMLElement;
      for (const hidden of copy.querySelectorAll("[aria-hidden]"))
        hidden.remove();
      return copy.textContent;
    });
  });
  expect(items).toEqual([
    "Write greet.py module, Done",
    "Edit and modify greet.py, Done",
    "Test greet.py using Grep and Glob tools, In progress",
    "Run greet.py and other bash commands, Not started",
  ]);
  const tasks = [recorded.taskCreate, recorded.taskStart, recorded.taskFinish];
  replay(
    tasks,
    tasks.map(({ history }) => history),
  );
  await app.open(fixture);
  for (const text of [
    "Added a task",
    JSON.parse(recorded.taskCreate.arguments).subject,
    "Started task 1",
    "Finished task 1",
  ]) {
    await expect(screen.getByText(text, { exact: true })).toBeVisible();
  }
});
