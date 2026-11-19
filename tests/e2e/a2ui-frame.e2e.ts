import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/a2ui-frame.html";
const surface = "[data-generative-ui-chat-surface]";
const shotDirectory = process.env.OPENBOT_APP_SHOTS;

/**
 * For each interface: which of the boxes around the whole of it draw a border (CopilotKit's frame,
 * and the interface's own top component), how far the interface sits inside the frame, and the
 * frame's padding.
 */
function frames(browser: Browser) {
  return browser.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((frame) => {
        const surface = frame.querySelector(":scope > .a2ui-surface");
        let top = [...(surface?.children ?? [])].find(
          (child) => child.tagName !== "STYLE",
        );
        // A component with an accessible name the catalog does not apply itself is wrapped in a
        // `display: contents` span.
        if (top?.matches("[data-a2ui-accessibility]"))
          top = top.firstElementChild ?? undefined;
        if (!top) throw new Error("an interface drew nothing");
        const boxed = (element: Element) => {
          const style = getComputedStyle(element);
          return (["Top", "Right", "Bottom", "Left"] as const).every(
            (side) =>
              Number.parseFloat(style[`border${side}Width`]) > 0 &&
              style[`border${side}Style`] !== "none",
          );
        };
        const outer = frame.getBoundingClientRect();
        const inner = top.getBoundingClientRect();
        return {
          surface: frame.getAttribute("data-generative-ui-chat-surface"),
          bordered: [
            ...(boxed(frame) ? ["frame"] : []),
            ...(boxed(top) ? ["interface"] : []),
          ],
          inset: Math.round(inner.left - outer.left),
          padding: getComputedStyle(frame).paddingTop,
        };
      }),
    surface,
  );
}

test("a generated interface uses one frame, whether or not its root draws a border", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 680, height: 900 });
  await app.open(fixture);
  await expect(screen.getByText("Total $430", { exact: true })).toBeVisible();
  await expect(
    browser.locator(`${surface} .a2ui-surface [data-a2ui-std]`).first(),
  ).toBeVisible();
  await expect(browser.locator(surface)).toHaveCount(4);
  expect(await frames(browser)).toEqual([
    { surface: "budget", bordered: ["interface"], inset: 0, padding: "0px" },
    { surface: "labelled", bordered: ["interface"], inset: 0, padding: "0px" },
    { surface: "plain", bordered: ["frame"], inset: 13, padding: "12px" },
    { surface: "section", bordered: ["frame"], inset: 13, padding: "12px" },
  ]);
});

if (shotDirectory) {
  test("exports the generated budget and plain interface in both themes", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width: 680, height: 900 });
    await mkdir(shotDirectory, { recursive: true });
    for (const theme of ["light", "dark"]) {
      for (const [only, heading] of [
        ["budget", "Weekend trip budget"],
        ["plain", "Before you go"],
      ]) {
        await app.open(`${fixture}?only=${only}&theme=${theme}`);
        await expect(screen.getByText(heading, { exact: true })).toBeVisible();
        await browser.evaluate(async () => {
          await document.fonts.ready;
          for (const animation of document.getAnimations()) {
            if (animation.effect?.getComputedTiming().endTime === Infinity)
              animation.cancel();
            else animation.finish();
          }
          return null;
        });
        const name = `${only}-${theme}`;
        await copyFile(
          await app.screenshot(name),
          join(shotDirectory, `${name}.png`),
        );
      }
    }
  });
}
