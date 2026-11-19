import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { generatedSurface } from "./a2ui-surface";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const FIZZBUZZ = [
  "/// Prints the numbers 1 to 15, with Fizz, Buzz and FizzBuzz.",
  "///",
  "/// ```",
  "/// fizzbuzz();",
  "/// ```",
  "fn fizzbuzz() {",
  "    for i in 1..=15 {",
  "        match (i % 3, i % 5) {",
  '            (0, 0) => println!("FizzBuzz"),',
  '            (0, _) => println!("Fizz"),',
  '            (_, 0) => println!("Buzz"),',
  '            _ => println!("{i}"),',
  "        }",
  "    }",
  "}",
].join("\n");

/** The function alone, without the doc comment whose own fence would close a three-backtick block. */
const FUNCTION = FIZZBUZZ.split("\n").slice(5).join("\n");

/** Prose a Bot might put next to other components: a heading, a list, links, a table and code. */
const PROSE = [
  "## FizzBuzz in Rust",
  "",
  "With a [reference](https://doc.rust-lang.org/book/), the [spec](https://docs.google.com/document/d/abc/edit) and a [trap](javascript:alert(1)):",
  "",
  "- loops from **1** to `15`",
  "- prints *Fizz*, *Buzz* or both",
  "",
  "| n | prints |",
  "|---|---|",
  "| 3 | Fizz |",
  "| 15 | FizzBuzz |",
  "",
  "```rust",
  FUNCTION,
  "```",
].join("\n");

const codeBody = '[data-streamdown="code-block-body"]';
const codeBlock = '[data-streamdown="code-block"]';
const token = `${codeBody} code span`;
const markdownHeading = '[data-streamdown="heading-2"]';
const root = "[data-generative-ui-chat-surface]";

function card(
  name: string,
  drawn: Record<string, unknown> & { component: string },
) {
  return generatedSurface(name, [
    { id: "root", component: "Card", child: "drawn" },
    { id: "drawn", ...drawn },
  ]);
}

const scope = (name: string) => `[data-generative-ui-chat-surface="${name}"]`;

async function captureClipboard(browser: Browser) {
  await browser.addInitScript(() => {
    const writes: string[] = [];
    Object.defineProperty(window, "codeClipboard", { value: writes });
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (value: string) => {
        writes.push(value);
      },
    });
  });
}

function clipboard(browser: Browser) {
  return browser.evaluate(
    () => (window as Window & { codeClipboard?: string[] }).codeClipboard ?? [],
  );
}

async function tokenColors(browser: Browser, container: string) {
  const selector = `${container} ${token}`;
  await expect(
    browser.locator(`${selector}[style*="--shiki-dark"]`).first(),
  ).toBeVisible();
  return browser.evaluate((selector) => {
    const tokens = [...document.querySelectorAll(selector)];
    return ["fn", "fizzbuzz"].map((name) => {
      const found = tokens.find((element) => element.textContent === name);
      if (!found) throw new Error(`Missing highlighted Rust token: ${name}`);
      return getComputedStyle(found).color;
    });
  }, selector);
}

test("generated Rust code highlights nested fences in both themes and copies exactly", async (fixtures) => {
  const { app, browser } = fixtures;
  const bot = await createBot(fixtures);
  const conversation = await createConversation(browser, bot.id);
  await captureClipboard(browser);
  await browser.addInitScript(() =>
    localStorage.setItem("openbot-theme", "light"),
  );
  const source = "PRINT 'hello'\nGOTO 10";
  await configureChatStream(browser, [
    card("rust", { component: "Code", text: FIZZBUZZ, language: "rust" }),
    card("plain-code", {
      component: "Code",
      text: source,
      language: "not-a-language",
    }),
  ]);
  await app.open(`/channel/${conversation}`);
  const rust = scope("rust");
  const plain = scope("plain-code");
  await expect(browser.locator(`${rust} ${codeBody}`)).toContainText(
    'println!("FizzBuzz")',
  );
  await expect(browser.locator(`${rust} ${codeBody}`)).toContainText("/// ```");
  const light = await tokenColors(browser, rust);
  expect(light[0]).not.toBe(light[1]);
  await browser.evaluate(() => {
    document.documentElement.classList.add("dark");
    return null;
  });
  const dark = await tokenColors(browser, rust);
  expect(dark[0]).not.toBe(dark[1]);
  expect(dark).not.toEqual(light);
  await browser
    .locator(rust)
    .getByRole("button", "Copy Code", { exact: true })
    .tap();
  await expect.poll(() => clipboard(browser)).toEqual([`${FIZZBUZZ}\n`]);

  await expect(browser.locator(`${plain} ${codeBody}`)).toContainText(
    "GOTO 10",
  );
  await expect(browser.locator(`${plain} code [style*="--sdm-c"]`)).toHaveCount(
    0,
  );
  await browser
    .locator(plain)
    .getByRole("button", "Copy Code", { exact: true })
    .tap();
  await expect
    .poll(() => clipboard(browser))
    .toEqual([`${FIZZBUZZ}\n`, `${source}\n`]);
});

test("generated Markdown keeps the reply's formatting, style, and copy behavior", async (fixtures) => {
  const { app, browser } = fixtures;
  const bot = await createBot(fixtures);
  const conversation = await createConversation(browser, bot.id);
  await captureClipboard(browser);
  await configureChatStream(browser, [
    { id: "question", role: "user", content: "Show me how FizzBuzz works." },
    { id: "reply", role: "assistant", content: PROSE },
    card("markdown", { component: "Markdown", text: PROSE }),
    card("standalone", { component: "Code", text: FUNCTION, language: "rust" }),
  ]);
  await app.open(`/channel/${conversation}`);
  const markdown = scope("markdown");
  const standalone = scope("standalone");
  await expect(
    browser
      .locator(markdown)
      .getByRole("heading", "FizzBuzz in Rust", { exact: true }),
  ).toBeVisible();
  await expect(browser.locator(markdown).getByRole("listitem")).toHaveCount(2);
  await expect(
    browser.locator(markdown).getByRole("cell", "FizzBuzz", { exact: true }),
  ).toBeVisible();
  const colors = await tokenColors(browser, markdown);
  expect(colors[0]).not.toBe(colors[1]);
  await tokenColors(browser, standalone);
  const replyCode = `[data-slot="message"][data-align="start"] ${token}[style*="--shiki-dark"]`;
  await expect(browser.locator(replyCode).first()).toBeVisible();
  const selectors = {
    root,
    markdown,
    standalone,
    heading: markdownHeading,
    codeBlock,
  };
  const appearance = await browser.evaluate(
    ({ root, markdown, standalone, heading, codeBlock }) => {
      const replyHeading = [...document.querySelectorAll(heading)].find(
        (element) => !element.closest(root),
      );
      const generatedHeading = document.querySelector(`${markdown} ${heading}`);
      const reply = replyHeading?.parentElement;
      const generated = generatedHeading?.parentElement;
      const replyBlock = reply?.querySelector(codeBlock);
      const standaloneBlock = document.querySelector(
        `${standalone} ${codeBlock}`,
      );
      const copy = '[data-streamdown="code-block-copy-button"]';
      const replyCopy = reply?.querySelector(copy);
      const generatedCopy = generated?.querySelector(copy);
      if (
        !reply ||
        !generated ||
        !replyBlock ||
        !standaloneBlock ||
        !replyCopy ||
        !generatedCopy
      ) {
        throw new Error("Missing a rendered Markdown block");
      }
      return {
        contents: [reply, generated].map((block) => block.innerHTML),
        code: [replyBlock.outerHTML, standaloneBlock.outerHTML],
        copyColors: [replyCopy, generatedCopy].map(
          (button) => getComputedStyle(button).color,
        ),
      };
    },
    selectors,
  );
  expect(appearance.contents[1]).toBe(appearance.contents[0]);
  expect(appearance.code[1]).toBe(appearance.code[0]);
  expect(appearance.copyColors[1]).toBe(appearance.copyColors[0]);
  await browser
    .locator(markdown)
    .getByRole("button", "Copy Code", { exact: true })
    .tap();
  await expect.poll(() => clipboard(browser)).toEqual([`${FUNCTION}\n`]);
});

test("generated Markdown links open safely and streaming emphasis stays readable", async (fixtures) => {
  const { app, browser } = fixtures;
  const bot = await createBot(fixtures);
  const conversation = await createConversation(browser, bot.id);
  const reference = "https://doc.rust-lang.org/book/";
  await browser.route(reference, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Reference fixture</title>",
    }),
  );
  await configureChatStream(browser, [
    card("markdown", { component: "Markdown", text: PROSE }),
    card("partial", {
      component: "Markdown",
      text: "Counting to **fifteen",
      streaming: true,
    }),
  ]);
  await app.open(`/channel/${conversation}`);
  const prose = browser.locator(scope("markdown"));
  const link = prose.getByRole("link", "reference", { exact: true });
  await expect(link).toHaveAttribute("href", reference);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /\bnoopener\b/);
  await expect(link).toHaveAttribute("rel", /\bnoreferrer\b/);
  const document = browser.locator(
    `${scope("markdown")} a[href^="https://docs.google.com/"]`,
  );
  await expect(document).toHaveText(/spec\s*Doc/);
  await expect(document).toHaveAttribute("rel", /\bnoopener\b/);
  await expect(document).toHaveAttribute("rel", /\bnoreferrer\b/);
  await expect(
    browser.locator(`${scope("markdown")} a[href^="javascript:" i]`),
  ).toHaveCount(0);
  const tab = await browser.waitForPopup(() => link.tap());
  expect(await tab.url()).toBe(reference);
  expect(
    await browser.evaluate(
      () => window.opener === null && window.document.referrer === "",
    ),
  ).toBe(true);
  await tab.close();

  const partial = scope("partial");
  await expect(browser.locator(partial)).toContainText("Counting to fifteen");
  await expect(browser.locator(partial)).not.toContainText("**");
  await expect(
    browser.locator(`${partial} [data-streamdown="strong"]`),
  ).toHaveText("fifteen");
});
