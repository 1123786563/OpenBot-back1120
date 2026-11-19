import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/result-consumption.html";
const reply = "This is the completed answer.";
const event = (kind = "result_viewed", messageId = "answer") => ({
  kind,
  threadId: "telemetry-thread",
  messageId,
  surface: "web",
});

async function observeRequests(browser: Browser, status = 204) {
  const requests: unknown[] = [];
  await browser.route(/\/api\/telemetry\/product-events$/, (route) => {
    if (route.request.method === "POST")
      requests.push(JSON.parse(route.request.postData ?? "null"));
    return route.fulfill({ status });
  });
  return requests;
}

for (const direct of [false, true]) {
  test(`a ${direct ? "direct Bot" : "channel"} result records after entering the viewport`, async ({
    app,
    browser,
    screen,
  }) => {
    const requests = await observeRequests(browser);
    await app.open(`${fixture}?below-fold${direct ? "&direct" : ""}`);
    await expect(screen.getByText(reply, { exact: true })).toBeVisible();
    expect(
      await browser.evaluate(
        (text) =>
          [...document.querySelectorAll("p")].some(
            (node) =>
              node.textContent === text &&
              node.getBoundingClientRect().top > innerHeight,
          ),
        reply,
      ),
    ).toBe(true);
    expect(requests).toEqual([]);
    await screen.getByRole("button", "Move answer", { exact: true }).click();
    await expect.poll(() => requests).toEqual([event()]);
  });

  test(`a ${direct ? "direct Bot" : "channel"} result waits for its run to settle`, async ({
    app,
    browser,
    screen,
  }) => {
    const requests = await observeRequests(browser);
    await app.open(`${fixture}?busy${direct ? "&direct" : "&second"}`);
    await expect(screen.getByText(reply, { exact: true })).toBeVisible();
    expect(requests).toEqual([]);
    const toggle = screen.getByRole("button", "Toggle run", { exact: true });
    await toggle.click();
    const expected = direct
      ? [event()]
      : [event(), event("result_viewed", "second-answer")];
    await expect.poll(() => requests.length).toBe(expected.length);
    expect(requests.map((entry) => JSON.stringify(entry)).sort()).toEqual(
      expected.map((entry) => JSON.stringify(entry)).sort(),
    );
    await toggle.click();
    await toggle.click();
    await expect(screen.getByRole("status", "Run state")).toHaveText("Settled");
    expect(requests).toHaveLength(expected.length);
  });
}

test("a refused telemetry POST stays deduplicated and a remount uses the same IDs", async ({
  app,
  browser,
  screen,
}) => {
  const requests = await observeRequests(browser, 503);
  await app.open(fixture);
  await expect.poll(() => requests).toEqual([event()]);
  const move = screen.getByRole("button", "Move answer", { exact: true });
  await move.click();
  await move.click();
  await expect(screen.getByText(reply, { exact: true })).toBeVisible();
  expect(requests).toEqual([event()]);
  await screen.getByRole("button", "Remount answer", { exact: true }).click();
  await expect.poll(() => requests).toEqual([event(), event()]);
});

test("an answer without a thread ID sends no view event", async ({
  app,
  browser,
  screen,
}) => {
  const requests = await observeRequests(browser);
  await app.open(`${fixture}?unlinked`);
  await expect(screen.getByText(reply, { exact: true })).toBeVisible();
  await browser.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(requests).toEqual([]);
});

for (const refused of [false, true]) {
  test(`direct Bot copy ${refused ? "omits telemetry on failure" : "records only after clipboard success"}`, async ({
    app,
    browser,
  }) => {
    const requests = await observeRequests(browser);
    await browser.addInitScript((refused) => {
      const clipboard = Promise.withResolvers<void>();
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText(text: string) {
            document.documentElement.dataset.copiedText = text;
            return clipboard.promise;
          },
        },
      });
      document.addEventListener(
        "finish-test-copy",
        () => {
          if (refused)
            clipboard.reject(new Error("Clipboard permission denied"));
          else clipboard.resolve();
        },
        { once: true },
      );
    }, refused);
    await app.open(`${fixture}?direct&below-fold`);
    await browser.locator('[data-testid="copilot-copy-button"]').click();
    await expect(browser.locator("html")).toHaveAttribute(
      "data-copied-text",
      reply,
    );
    const copies = () =>
      requests.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "kind" in entry &&
          entry.kind === "result_copied",
      );
    expect(copies()).toEqual([]);
    await browser.evaluate(async () => {
      document.dispatchEvent(new Event("finish-test-copy"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    if (refused) expect(copies()).toEqual([]);
    else await expect.poll(copies).toEqual([event("result_copied")]);
  });
}

for (const scrollAway of [false, true]) {
  test(`background results ${scrollAway ? "stay unrecorded when offscreen on return" : "record when the document becomes visible"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const requests = await observeRequests(browser);
    await browser.addInitScript(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
    });
    await app.open(`${fixture}?${scrollAway ? "direct" : ""}`);
    await expect(screen.getByText(reply, { exact: true })).toBeVisible();
    if (scrollAway)
      await screen.getByRole("button", "Move answer", { exact: true }).click();
    await browser.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    if (scrollAway) {
      expect(requests).toEqual([]);
      await screen.getByRole("button", "Move answer", { exact: true }).click();
    }
    await expect.poll(() => requests).toEqual([event()]);
  });
}
