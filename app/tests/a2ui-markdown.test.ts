import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { standardUI } from "@copilotkit/react-core/v2/generative-ui";
import { OPENBOT_UI } from "@/lib/copilot/a2ui";
import { codeFence } from "@/lib/copilot/a2ui-markdown";

test("the model is offered the standard Code and Markdown, so what Bots already write keeps drawing", () => {
  for (const name of ["Code", "Markdown"] as const)
    expect(OPENBOT_UI.manifestComponents[name]).toEqual(
      standardUI.manifestComponents[name],
    );
});

test("no run of backticks in the code, and nothing in the language, can close the fence early", () => {
  // Markdown that itself quotes a fenced block, four backticks deep.
  const quoted = ["````md", "```js", "let a = 1;", "```", "````"].join("\n");
  expect(codeFence(quoted, "markdown")).toBe(
    ["`````markdown", quoted, "`````"].join("\n"),
  );
  // Only the language's first word, without backticks, goes on the opening line.
  expect(codeFence("x", "rust `title`\n```")).toBe("```rust\nx\n```");
  expect(codeFence("x")).toBe("```\nx\n```");
});

/**
 * CopilotKit's standard stylesheet is in no cascade layer, so in a browser it outranks Tailwind's
 * utilities, which are, whatever their specificity. Every property it sets on a heading or a button
 * that is not exempted for markdown would restyle the reply's markup inside an interface, so
 * styles.css must hand each one back to the layers.
 *
 * Read as the SDK injects it: the react-core module the app imports puts `STANDARD_CSS` in the page,
 * and takes it from `@copilotkit/shared`, resolved here from that module so it is the same copy. The
 * module picks its injection hook while it loads, before a test has a DOM, so it injects nothing here.
 */
test("everything the SDK's stylesheet sets on headings and buttons is handed back inside interface markdown", async () => {
  const module = Bun.resolveSync(
    "@copilotkit/react-core/v2/generative-ui",
    import.meta.dir,
  );
  expect(readFileSync(module, "utf8")).toContain(
    "style.textContent = STANDARD_CSS;",
  );
  const { STANDARD_CSS: sdk } = (await import(
    Bun.resolveSync("@copilotkit/shared/generative-ui", dirname(module))
  )) as { STANDARD_CSS: string };
  expect(sdk).toContain(".a2ui-surface");

  const rules = (css: string) =>
    Array.from(
      css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
      ([, selector, body]) => ({
        selector: selector.trim(),
        properties: Array.from(
          body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g),
          ([, name, value]) => ({ name, value: value.trim() }),
        ),
      }),
    );
  const reaching = rules(sdk).filter(
    ({ selector }) =>
      /\b(h[1-6]|button|input|select|textarea)\b/.test(selector) &&
      !selector.includes(":not(.a2ui-markdown *)") &&
      !/^\.a2ui-std-|^\[data-a2ui-(input|row)/.test(selector),
  );
  expect(reaching.length).toBeGreaterThan(0);

  const ours = rules(
    readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"),
  ).find(({ selector }) => selector.includes(".openbot-markdown"));
  expect(ours?.selector ?? "").toContain(":is(h1, h2, h3, h4, h5, h6, button");
  const reverted = new Set(
    ours?.properties
      .filter(({ value }) => value === "revert-layer")
      .map(({ name }) => name),
  );
  const FONT = /^(font-(size|weight|family|style)|line-height)$/;
  for (const { properties } of reaching)
    for (const { name } of properties)
      expect(
        reverted.has(name) || (FONT.test(name) && reverted.has("font"))
          ? name
          : `${name} is not handed back`,
      ).toBe(name);
});
