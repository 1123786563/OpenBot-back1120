import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { SKIN_IDS } from "../../shared/user-preferences";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const transcriptColumn = "[data-transcript-column]";
const composerColumn = '[data-slot="composer-column"]';
const codeTokens = '[data-streamdown="code-block-body"] code span';
const code = [
  "```python",
  "def greet(name):",
  '    return f"Hello, {name}!"',
  "```",
].join("\n");
const prose = "The report is ready.";
const response = [
  prose,
  code,
  "| Item | Count |\n| --- | --- |\n| Apples | 12 |",
].join("\n\n");
const messages = [
  { id: "ask", role: "user", content: "Show me the report." },
  { id: "report", role: "assistant", content: response },
];

function measureColumns(browser: Browser) {
  return browser.evaluate(
    ({ transcriptColumn, composerColumn }) => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element)
          throw new Error(`Missing conversation column: ${selector}`);
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          width: bounds.width,
          maxWidth: parseFloat(style.maxWidth),
          centre: (bounds.left + bounds.right) / 2,
          paddingLeft: parseFloat(style.paddingLeft),
          paddingRight: parseFloat(style.paddingRight),
        };
      };
      return {
        transcript: box(transcriptColumn),
        composer: box(composerColumn),
      };
    },
    { transcriptColumn, composerColumn },
  );
}

function expectCentred(columns: Awaited<ReturnType<typeof measureColumns>>) {
  expect(
    Math.abs(columns.transcript.centre - columns.composer.centre),
  ).toBeLessThanOrEqual(1);
}

test("restoring and loaded conversations keep centered reading and composer widths", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const archive = Promise.withResolvers<readonly object[]>();
  await configureChatStream(browser, messages, () => archive.promise);
  await browser.setViewport({ width: 1550, height: 900 });
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const placeholder = screen.getByRole("status", "Loading this conversation", {
    exact: true,
  });
  try {
    await app.open(`/channel/${channel}`);
    await expect(placeholder).toBeVisible();
    const restoring = await measureColumns(browser);
    expectCentred(restoring);
    expect(restoring.transcript.width).toBe(768);
    expect(restoring.composer.width).toBe(800);
    expect(restoring.composer.paddingLeft).toBe(16);
    expect(restoring.composer.paddingRight).toBe(16);
    expect(restoring.transcript.paddingLeft).toBe(16);
    expect(restoring.transcript.paddingRight).toBe(16);

    archive.resolve([]);
    await expect(transcript.getByText(prose, { exact: true })).toBeVisible();
    await expect(placeholder).toHaveCount(0);
    expect(await measureColumns(browser)).toEqual(restoring);
    await browser.setViewport({ width: 480, height: 850 });
    const narrow = await measureColumns(browser);
    expectCentred(narrow);
    expect(narrow.transcript.width).toBe(480);
    expect(narrow.composer.width).toBe(narrow.transcript.width);
    expect(narrow.transcript.paddingLeft).toBe(16);
    expect(narrow.transcript.paddingRight).toBe(16);
    expect(narrow.composer.paddingLeft).toBe(16);
    expect(narrow.composer.paddingRight).toBe(16);
    await expect(transcript.getByRole("table")).toBeVisible();
    const layout = await browser.evaluate(() => {
      const column = document.querySelector("[data-transcript-column]");
      const code = document.querySelector(
        '[data-streamdown="code-block-body"]',
      );
      const table = column?.querySelector("table");
      if (!column || !code || !table)
        throw new Error("Missing a rendered reply block");
      const bounds = column.getBoundingClientRect();
      return [code, table].map((item) => {
        const box = item.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right;
      });
    });
    expect(layout).toEqual([true, true]);
  } finally {
    archive.resolve([]);
  }
});

if (process.env.OPENBOT_E2E_SUITE !== "personal") {
  test("group replies use the same 768px reading column on a wide window", async (fixtures) => {
    const { app, browser } = fixtures;
    const first = await createBot(fixtures);
    const second = await createBot(fixtures);
    const channel = await createConversation(browser, [first.id, second.id]);
    await browser.setViewport({ width: 1550, height: 850 });
    await app.open(`/group/${channel}`);
    const column = browser.locator(transcriptColumn);
    await expect(column).toContainText("Every Bot answers in turn");
    const width = await browser.evaluate(
      (selector) =>
        document.querySelector(selector)?.getBoundingClientRect().width ?? null,
      transcriptColumn,
    );
    expect(width).toBe(768);
  });
}

test("alternate skins keep their own reading and composer widths", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(browser, messages);
  await browser.setViewport({ width: 1550, height: 900 });
  let skin: (typeof SKIN_IDS)[number] = "openbot";
  await browser.route(/\/api\/settings\/preferences$/, async (route) => {
    const data = await (await route.fetch()).json<{
      preferences: Record<string, unknown>;
    }>();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...data,
        preferences: { ...data.preferences, skin },
      }),
    });
  });
  for (const next of SKIN_IDS.filter((id) => id !== "openbot")) {
    skin = next;
    await app.open(`/channel/${channel}`);
    await expect(browser.locator("html")).toHaveAttribute("data-skin", skin);
    await expect(
      screen
        .getByRole("region", "Messages", { exact: true })
        .getByText(prose, { exact: true }),
    ).toBeVisible();
    const columns = await measureColumns(browser);
    expectCentred(columns);
    expect(columns.transcript.maxWidth).toBe(672);
    expect(columns.composer.maxWidth).toBe(672);
    const width = skin === "openduet" ? 430 : 672;
    expect(columns.transcript.width).toBe(width);
    expect(columns.composer.width).toBe(width);
    const padding = skin === "openduet" ? 12 : 0;
    expect(columns.composer.paddingLeft).toBe(padding);
    expect(columns.composer.paddingRight).toBe(padding);
  }
});

async function colours(browser: Browser, scope: string) {
  const selector = `${scope} ${codeTokens}`;
  await expect(
    browser.locator(`${selector}[style*="--shiki-dark"]`).first(),
  ).toBeVisible();
  return browser.evaluate((selector) => {
    const tokens = [...document.querySelectorAll(selector)];
    return ["def", "greet"].map((text) => {
      const token = tokens.find((node) => node.textContent === text);
      if (!token)
        throw new Error(`The Python token ${text} was not highlighted`);
      return getComputedStyle(token).color;
    });
  }, selector);
}

test("Python syntax colours distinguish tokens in the Bot's reply and an expanded tool result", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id, "Review Python");
  await configureChatStream(browser, [
    {
      id: "ask",
      role: "user",
      content: "Write greet and show me the reference.",
    },
    {
      id: "tool-call",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "docs",
          type: "function",
          function: { name: "mcp__docs__fetch", arguments: "{}" },
        },
      ],
    },
    { id: "docs-result", role: "tool", toolCallId: "docs", content: code },
    { id: "python-reply", role: "assistant", content: code },
  ]);
  await app.open(`/channel/${channel}`);
  const assistant = '[data-slot="message"][data-align="start"]';
  await expect(
    screen.getByRole("region", "Messages", { exact: true }),
  ).toBeVisible();
  const light = await colours(browser, assistant);
  expect(light[0]).not.toBe(light[1]);
  await browser.evaluate(() => {
    localStorage.setItem("openbot-theme", "dark");
    return null;
  });
  await browser.reload();
  await expect(browser.locator("html")).toHaveAttribute("class", /\bdark\b/);
  const dark = await colours(browser, assistant);
  expect(dark[0]).not.toBe(dark[1]);
  expect(dark).not.toEqual(light);

  const tools = browser.locator("details.tool-line > summary");
  if ((await tools.count()) === 0) {
    await screen.getByText(/^Used 1 tool/).tap();
  }
  await tools.tap();
  const tool = await colours(browser, "details.tool-line[open]");
  expect(tool[0]).not.toBe(tool[1]);
});

test("chat keeps intentional line breaks alongside structured Markdown", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const prompt = "Red\nGreen\n*Blue*";
  await configureChatStream(browser, [
    { id: "ask", role: "user", content: prompt },
    {
      id: "formatted-reply",
      role: "assistant",
      content: [
        "First line\nsecond line\nthird line",
        "- one\n- two\n- three",
        "1. alpha\n2. beta",
        "| colour | hex |\n| --- | --- |\n| Red | #f00 |\n| Blue | #00f |",
        code,
        "Run `a\nb` and **bold\ntext**.",
      ].join("\n\n"),
    },
  ]);
  await app.open(`/channel/${channel}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const table = transcript.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("cell", "#00f", { exact: true })).toBeVisible();

  const reading = await browser.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error(`Missing conversation column: ${selector}`);
    const rendered = (selector: string) => {
      const element = root.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing rendered text: ${selector}`);
      return element.innerText;
    };
    const code = root.querySelector('[data-streamdown="code-block-body"]');
    const user = root.querySelector('[data-slot="message"][data-align="end"]');
    const prose = [...root.querySelectorAll("p")].find((paragraph) =>
      paragraph.textContent?.startsWith("First line"),
    );
    const typed = [...(user?.querySelectorAll<HTMLElement>("*") ?? [])].find(
      (element) =>
        element.textContent === "Red\nGreen\n*Blue*" &&
        element.children.length === 0,
    );
    return {
      typed: typed?.innerText ?? null,
      prose: prose?.innerText ?? null,
      bullets: [...root.querySelectorAll("ul li")].map(
        (item) => item.textContent,
      ),
      numbered: [...root.querySelectorAll("ol li")].map(
        (item) => item.textContent,
      ),
      inlineCode: rendered('[data-streamdown="inline-code"]'),
      emphasis: rendered('[data-streamdown="strong"]'),
      code: code?.textContent ?? null,
      extraBreaks: root.querySelectorAll(
        'li br, table br, [data-streamdown="code-block-body"] br',
      ).length,
    };
  }, transcriptColumn);
  expect(reading).toEqual({
    typed: prompt,
    prose: "First line\nsecond line\nthird line",
    bullets: ["one", "two", "three"],
    numbered: ["alpha", "beta"],
    inlineCode: "a b",
    emphasis: "bold\ntext",
    code: expect.stringContaining('return f"Hello, {name}!"'),
    extraBreaks: 0,
  });
  expect(reading.code).toContain("def greet(name):");
});
