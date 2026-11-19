import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  FINISH_MS,
  nextReveal,
} from "../../app/src/components/channels/paced-reveal";

const fixture = "/tests/browser/reply-reveal.html";
const history = Array.from({ length: 60 }, (_, index) => `word${index}`).join(
  " ",
);

test("opening a conversation shows the entire stored reply", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?scenario=history`);
  await expect(screen.getByText(history, { exact: true })).toBeVisible();
});

test("a new reply is initially partial and finishes when the run ends", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  await expect(
    screen.getByText("What did you find?", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", "Deliver reply", { exact: true }).click();
  const initial = browser.locator('output[aria-label="Initial reply"]');
  await expect(initial).toBeVisible();
  await expect(initial).not.toContainText("word59");
  await screen.getByRole("button", "Finish run", { exact: true }).click();
  await expect(screen.getByText(history, { exact: true })).toBeVisible();
});

test("the reply's last word can appear while the Bot is still busy", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?scenario=sentence`);
  await expect(
    screen.getByText("What did you find?", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", "Deliver reply", { exact: true }).click();
  await expect(
    screen.getByText("Here is a chart of your sales:", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("status", "Run state", { exact: true }),
  ).toHaveText("Busy");
});

for (const streaming of [false, true]) {
  test(`replies reach their full text when no animation frames come (streaming=${streaming})`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.addInitScript(() => {
      window.requestAnimationFrame = () => 1;
      window.cancelAnimationFrame = () => {};
    });
    await app.open(
      `${fixture}?scenario=no-frames${streaming ? "-streaming" : ""}`,
    );
    const reply = screen.getByRole("status", "Revealed text", { exact: true });
    if (streaming) {
      await expect(reply).toContainText("word0");
      await expect(reply).not.toContainText("word30");
      await screen
        .getByRole("button", "Finish stream", { exact: true })
        .click();
    }
    await expect(reply).toHaveText(history);
  });
}

test("tokens arriving between frames do not reset the clock for revealing a reply", async ({
  app,
  browser,
  screen,
}) => {
  let text = Array.from({ length: 200 }, (_, index) => `w${index}`).join(" ");
  const initialLength = text.length;
  let ideal = 0;
  for (let i = 0; i < 25; i++) {
    text += ` t${i}`;
    ideal = nextReveal({
      text,
      shown: ideal,
      elapsedMs: 16,
      streaming: true,
      finishInMs: FINISH_MS,
    });
  }
  expect(ideal).toBeGreaterThan(initialLength / 2);
  await app.open(`${fixture}?scenario=interleaved`);
  await screen
    .getByRole("button", "Deliver tokens between frames", { exact: true })
    .click();
  const shown = await browser.evaluate(
    () => document.querySelector("output")?.textContent ?? "",
  );
  expect(shown.length).toBeGreaterThanOrEqual(ideal * 0.95);
  expect(text.startsWith(shown)).toBe(true);
});
