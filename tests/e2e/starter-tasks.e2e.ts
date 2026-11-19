import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/starter-tasks.html";
const prompts = [
  {
    title: "Chart Hacker News",
    message:
      "Use web search to find the top 10 stories on the Hacker News front page right now. Show me a bar chart of them by points, then list them with their points and links.",
  },
  {
    title: "Browse Google Maps",
    message:
      "Use your browser to open Google Maps and check the British Museum's Saturday opening hours. Then get walking directions from King's Cross station, list them step by step, and tell me when to leave to arrive at opening time. Don't sign in or change anything.",
  },
  {
    title: "Triage my inbox",
    message:
      "Use Gmail to read my emails from the past 24 hours and tell me the top 2 that need my attention, and why. Don't mark anything as read or change anything. If Gmail isn't connected, help me connect it here, then continue this request.",
  },
  {
    title: "Build a trip budget",
    message:
      "Build an interactive weekend trip budget in this conversation. Start with transport $100, lodging $200 and food $80. Let me edit each cost and see the total update immediately. Use clearly labeled sample amounts, not live prices.",
  },
];

async function serveTour(
  browser: Browser,
  {
    claimed,
    interactive = true,
    checklist,
  }: { claimed?: string; interactive?: boolean; checklist?: string } = {},
) {
  await browser.route(/\/api\/me$/, (route) =>
    route.fulfill({
      json: { user: { id: "first", name: "First person", onboarding: null } },
    }),
  );
  let reads = 0;
  await browser.route(/\/api\/settings\/preferences$/, (route) => {
    reads += 1;
    return route.fulfill({
      json: {
        preferences:
          reads === 1 && claimed ? { starterTourChannelId: claimed } : {},
      },
    });
  });
  await browser.route(/\/api\/capabilities$/, (route) =>
    route.fulfill({ json: { generativeUi: interactive } }),
  );
  await browser.route(/\/api\/setup$/, (route) =>
    checklist === "request_failed"
      ? route.fulfill({ status: 503 })
      : route.fulfill({
          json: {
            checklist: {
              audience: "admin",
              rows: [{ id: "computer", status: checklist, ready: false }],
            },
          },
        }),
  );
  return () => reads;
}

for (const bot of ["picked-harness", "personal-assistant"]) {
  test(`${bot} offers and submits its four Starter Tour tasks`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveTour(browser);
    await app.open(`${fixture}?bot=${bot}`);
    const tour = screen.getByRole("region", "Starter tasks", { exact: true });
    const submitted = screen.getByRole("status", "Submitted tasks", {
      exact: true,
    });
    await expect(tour.getByRole("button")).toHaveCount(4);
    await expect(
      tour.getByRole("button", "Hide starter tasks", { exact: true }),
    ).toHaveCount(0);
    const messages: string[] = [];
    for (const [index, task] of prompts.entries()) {
      const button = tour.getByRole("button", task.title, { exact: true });
      await expect(tour.getByRole("button").nth(index)).toHaveText(task.title);
      await button.click();
      messages.push(task.message);
      await expect(submitted).toHaveText(JSON.stringify(messages));
    }
    const layout = await browser.evaluate(() => {
      const region = document.querySelector('[aria-label="Starter tasks"]');
      const first = region?.querySelector("button");
      const composer = document.querySelector('[data-slot="composer"]');
      const editor = composer?.querySelector("input");
      if (!region || !first || !composer || !editor)
        throw new Error("Missing starter or composer");
      return {
        left: Math.abs(
          first.getBoundingClientRect().left -
            editor.getBoundingClientRect().left,
        ),
        gap:
          composer.getBoundingClientRect().top -
          region.getBoundingClientRect().bottom,
      };
    });
    expect(layout.left).toBeLessThanOrEqual(2);
    expect(layout.gap).toBeGreaterThanOrEqual(12);
  });
}

for (const { query, claimed, shown } of [
  { query: "?bot=custom-bot", shown: false },
  { query: "?channel=first", claimed: "first", shown: true },
  { query: "?channel=later", claimed: "first", shown: false },
  { query: "", claimed: "first", shown: false },
  { query: "?scenario=account", claimed: "first", shown: false },
]) {
  test(`Starter Tour visibility for ${query || "home"} with ${claimed ?? "no"} claim`, async ({
    app,
    browser,
    screen,
  }) => {
    const reads = await serveTour(browser, { claimed });
    await app.open(`${fixture}${query}`);
    const tour = screen.getByRole("region", "Starter tasks", { exact: true });
    await expect(screen.getByRole("status", "Submitted tasks")).toBeVisible();
    if (claimed) await expect.poll(reads).toBe(1);
    if (shown) await expect(tour).toBeVisible();
    else await expect(tour).toHaveCount(0);
    if (query === "?scenario=account") {
      await screen
        .getByRole("button", "Switch account", { exact: true })
        .click();
      await expect(tour).toBeVisible();
      expect(reads()).toBe(2);
    }
  });
}

test("busy Starter Tour tasks ignore repeated presses during a send", async ({
  app,
  browser,
  screen,
}) => {
  await serveTour(browser);
  await app.open(`${fixture}?scenario=busy`);
  const task = screen.getByRole("button", "Chart Hacker News", { exact: true });
  const sent = screen.getByRole("status", "Submitted tasks", { exact: true });
  await expect(task).toBeDisabled();
  await expect(sent).toHaveText("[]");
  await screen.getByRole("button", "Enable tasks", { exact: true }).click();
  await task.click();
  await expect(task).toBeDisabled();
  await browser.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Chart Hacker News")
      ?.click();
  });
  await expect(sent).toHaveText(JSON.stringify([prompts[0].message]));
  await screen.getByRole("button", "Finish sending", { exact: true }).click();
  await expect(task).toBeEnabled();
});

test("a failed Starter Tour task shows the reason and can be retried", async ({
  app,
  browser,
  screen,
}) => {
  await serveTour(browser);
  await app.open(`${fixture}?scenario=retry`);
  const task = screen.getByRole("button", "Chart Hacker News", { exact: true });
  await task.click();
  await expect(screen.getByRole("alert")).toHaveText(
    "Task could not start. Try again.",
  );
  await expect(screen.getByRole("status", "Submitted tasks")).toHaveText("[]");
  await task.click();
  await expect(screen.getByRole("alert")).toHaveCount(0);
  await expect(screen.getByRole("status", "Submitted tasks")).toHaveText(
    JSON.stringify([prompts[0].message]),
  );
});

for (const checklist of ["not_checked", "needs_setup", "request_failed"]) {
  test(`Starter Tour limits interactive answers and allows browser tasks if setup is ${checklist}`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveTour(browser, { interactive: false, checklist });
    await app.open(fixture);
    const sent = screen.getByRole("status", "Submitted tasks");
    await screen
      .getByRole("button", "Build a trip budget", { exact: true })
      .click();
    await expect(screen.getByRole("alert")).toContainText(
      "disabled for this installation",
    );
    await expect(
      screen.getByRole("link", "Check setup", { exact: true }),
    ).toHaveCount(0);
    await expect(sent).toHaveText("[]");
    await screen
      .getByRole("button", "Browse Google Maps", { exact: true })
      .click();
    await expect(sent).toHaveText(JSON.stringify([prompts[1].message]));
    await expect(screen.getByRole("alert")).toHaveCount(0);
  });
}
