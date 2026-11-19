import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/transcript-updates.html";

for (const live of [false, true]) {
  test(`a voice chat added to an open transcript has the correct entrance (live=${live})`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(`${fixture}?scenario=${live ? "new-call" : "old-call"}`);
    await expect(
      screen.getByText("I have the details.", { exact: true }),
    ).toBeVisible();
    await screen
      .getByRole("button", "Deliver voice chat", { exact: true })
      .click();
    await expect(
      screen.getByRole("status", "Initial voice opacity", { exact: true }),
    ).toHaveText(live ? "0" : "1");
    const row = browser.locator('[data-message-id="voice-chat:shipment"]');
    await expect(
      row.getByText("The shipment leaves Friday.", { exact: true }),
    ).toBeVisible();
    expect(
      await browser.evaluate(() => {
        const ids = [...document.querySelectorAll("[data-message-id]")].map(
          (node) => node.getAttribute("data-message-id"),
        );
        return ids.filter(
          (id) => id && ["a1", "u2", "voice-chat:shipment"].includes(id),
        );
      }),
    ).toEqual(["a1", "voice-chat:shipment", "u2"]);
  });
}

test("jumping to an older row brings all rows from there into view", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?scenario=pages`);
  const earlier = screen.getByRole("list", "Earlier rows", { exact: true });
  const later = screen.getByRole("list", "Opening rows", { exact: true });
  await expect(later).toHaveAttribute("start", "81");
  await expect(later.getByRole("listitem")).toHaveCount(20);
  await expect(earlier.getByRole("listitem")).toHaveCount(0);
  await screen.getByRole("button", "Jump to row 33", { exact: true }).click();
  await expect(earlier).toHaveAttribute("start", "34");
  await expect(earlier.getByRole("listitem")).toHaveCount(47);
  await expect(earlier.getByText("r33", { exact: true })).toBeVisible();
  await screen.getByRole("button", "Jump to row 50", { exact: true }).click();
  await expect(earlier).toHaveAttribute("start", "34");
  await expect(earlier.getByRole("listitem")).toHaveCount(47);
});

test("recovering and removing history above the opening page keeps its first row mounted", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${fixture}?scenario=pages`);
  const earlier = screen.getByRole("list", "Earlier rows", { exact: true });
  const later = screen.getByRole("list", "Opening rows", { exact: true });
  await expect(later).toHaveAttribute("start", "81");
  await expect(later.getByText("r80", { exact: true })).toBeVisible();
  await browser.evaluate(() => {
    Object.defineProperty(window, "openingRow", {
      value: document.querySelector('[aria-label="Opening rows"] li'),
    });
    return null;
  });
  await screen
    .getByRole("button", "Recover rows above", { exact: true })
    .click();
  await expect(later).toHaveAttribute("start", "86");
  await expect(earlier).toHaveAttribute("start", "86");
  await screen
    .getByRole("button", "Draw earlier page", { exact: true })
    .click();
  await expect(earlier).toHaveAttribute("start", "66");
  await expect(earlier.getByText("r60", { exact: true })).toBeVisible();
  await screen
    .getByRole("button", "Remove earlier rows", { exact: true })
    .click();
  await expect(earlier).toHaveAttribute("start", "60");
  await expect(later).toHaveAttribute("start", "80");
  await expect(later.getByText("r80", { exact: true })).toBeVisible();
  expect(
    await browser.evaluate(
      () =>
        Reflect.get(window, "openingRow") ===
        document.querySelector('[aria-label="Opening rows"] li'),
    ),
  ).toBe(true);
});

test("a running step shows activity, then the transcript shows the Bot is thinking until the run ends", async ({
  app,
  browser,
  screen,
}) => {
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
  await app.open(`${fixture}?scenario=gmail`);
  const action = screen.getByText("Fetch thread messages", { exact: true });
  const thinking = screen.getByRole("status").filter({ hasText: "Thinking" });
  const shimmer = browser.locator(".tool-line-running");
  await screen.getByText("Fetch thread messages…", { exact: true }).click();
  await expect(action).toHaveAttribute("class", /\btool-line-running\b/);
  await expect(screen.getByText("Fetch emails", { exact: true })).toHaveCount(
    4,
  );
  await expect(shimmer.filter({ hasText: "Fetch emails" })).toHaveCount(0);
  await screen
    .getByRole("button", "Deliver final tool result", { exact: true })
    .click();
  await expect(action).not.toHaveAttribute("class", /\btool-line-running\b/);
  await expect(screen.getByText("Used Gmail", { exact: true })).toBeVisible();
  await expect(thinking).toBeVisible();
  await expect(thinking).toHaveAttribute("class", /\btool-line-running\b/);
  await screen.getByRole("button", "Finish working", { exact: true }).click();
  await expect(thinking).toHaveCount(0);
  await expect(shimmer).toHaveCount(0);
});

test("a running search displays its streamed arguments before receiving a result", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?scenario=running-search`);
  const active = screen.getByText(/searched|searching|web search/i).first();
  await expect(active).toBeVisible();
  await active.click();
  await expect(screen.getByText(/second query/)).toHaveCount(0);
  await screen
    .getByRole("button", "Deliver search arguments", { exact: true })
    .click();
  const running = screen
    .getByRole("listitem")
    .filter({ hasText: "In progress" });
  await running.getByText("Web search", { exact: true }).click();
  await expect(running.getByText(/second query/)).toBeVisible();
  await expect(screen.getByText("Second source", { exact: true })).toHaveCount(
    0,
  );
});

test("finished tool details stay open and mounted while the reply streams", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${fixture}?scenario=finished-search`);
  const disclosure = screen.getByText("Used 2 tools", { exact: true });
  await disclosure.click();
  await screen
    .getByRole("listitem")
    .filter({ hasText: "First source" })
    .getByText("Web search", { exact: true })
    .click();
  const prior = screen.getByText("first query", { exact: true });
  await expect(prior).toBeVisible();
  const lookup = "first query";
  await browser.evaluate((phrase) => {
    const original = [...document.querySelectorAll("main *")].find(
      (node) =>
        node.childNodes.length === 1 && node.textContent?.trim() === phrase,
    );
    if (!original) throw new Error("Completed search details are missing");
    original.setAttribute("data-original-search-details", "");
    return null;
  }, lookup);
  const append = screen.getByRole("button", "Stream another event", {
    exact: true,
  });
  for (let index = 0; index < 10; index += 1) await append.click();
  await expect(
    screen.getByText(/Here are the events.*Event 10\./),
  ).toBeVisible();
  await expect(prior).toBeVisible();
  await expect(browser.locator("[data-original-search-details]")).toBeVisible();
});
