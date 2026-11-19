import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";

test(`${personal ? "Personal" : "Team admin"} Bot Activity opens the audit trail filtered to that Bot`, async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const reads: { bot: string | null; excluded: string | null }[] = [];
  const events = [
    { id: "first", agentId: bot.id, file: "finance-report.txt" },
    { id: "second", agentId: "other-bot", file: "unrelated-notes.txt" },
  ].map(({ id, agentId, file }) => ({
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: agentId,
    payload: { bot: agentId, action: "computer_write_file", file },
    createdAt: "2026-11-06T09:00:00Z",
  }));
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) => {
    const search = new URL(route.request.url).searchParams;
    const botId = search.get("bot");
    reads.push({ bot: botId, excluded: search.get("excludeEventType") });
    return route.fulfill({
      json: {
        events: botId
          ? events.filter((event) => event.targetId === botId)
          : events,
      },
    });
  });
  await serveActivity(browser, () => ({}));
  await app.open(`/bots/${bot.id}/activity`);
  await expect(
    screen.getByText("No tasks, routines or goals have finished yet.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    screen.getByText("Nothing has finished yet.", { exact: true }),
  ).toHaveCount(0);
  const link = screen.getByRole("link", /^Every action this Bot took/);
  const trail = personal ? "/settings/activity" : "/admin/audit";
  await expect(link).toHaveAttribute("href", `${trail}?bot=${bot.id}`);
  await link.tap();
  await expect(browser).toHaveURL(`${trail}?bot=${bot.id}`);
  await expect(
    screen.getByText("finance-report.txt", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("unrelated-notes.txt", { exact: true }),
  ).toHaveCount(0);
  expect(reads[0]?.bot).toBe(bot.id);

  if (personal) {
    const everyBot = screen.getByRole(
      "button",
      `Show every Bot, not only ${bot.name}`,
      { exact: true },
    );
    await expect(everyBot).toHaveText(`Only ${bot.name}`);
    await everyBot.tap();
    await expect(browser).toHaveURL(trail);
    await expect(
      screen.getByText("unrelated-notes.txt", { exact: true }),
    ).toBeVisible();
    expect(reads.at(-1)).toEqual({ bot: null, excluded: reads[0]?.excluded });
  }
});

if (!personal) {
  test("a team member's Bot Activity keeps the completed section without the audit link", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    await serveActivity(browser, () => ({}));
    await browser.route(/\/api\/me$/, async (route) => {
      const response = await route.fetch();
      const data = await response.json<{
        user: Record<string, string | boolean | null>;
        version?: string | null;
      }>();
      return route.fulfill({
        json: { ...data, user: { ...data.user, role: "user" } },
      });
    });
    await app.open(`/bots/${bot.id}/activity`);
    await expect(
      screen.getByText("No tasks, routines or goals have finished yet.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      screen.getByRole("link", /^Every action this Bot took/),
    ).toHaveCount(0);
  });
}

function activityItem(
  title: string,
  status: "running" | "scheduled" | "active" | "done",
  kind: "routine" | "responsibility" = "routine",
) {
  return {
    id: title,
    kind,
    title,
    detail: null,
    status,
    at: "2026-10-09T10:00:00Z",
    channelId: null,
    needsYou: false,
    stoppable: false,
    cancellable: false,
  };
}

async function serveActivity(
  browser: Browser,
  read: () => {
    inProgress?: ReturnType<typeof activityItem>[];
    scheduled?: ReturnType<typeof activityItem>[];
    onDemand?: ReturnType<typeof activityItem>[];
    completed?: ReturnType<typeof activityItem>[];
  },
) {
  await browser.route(/\/api\/bots\/[^/?]+\/activity$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        activity: { inProgress: [], scheduled: [], completed: [], ...read() },
      }),
    }),
  );
}

function activityTitles(browser: Browser, heading: string) {
  return browser.evaluate((heading) => {
    const title = [...document.querySelectorAll("section h2")].find(
      (element) => element.textContent === heading,
    );
    return [
      ...(title
        ?.closest("section")
        ?.querySelectorAll("[data-slot='item-title']") ?? []),
    ].map((element) => element.textContent);
  }, heading);
}

test("the profile previews three upcoming items in order and a running Goal opens its page", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const longTitle =
    "Review the latest OpenBot release and post its version number and release date in the project conversation with a link to the release notes.";
  await serveActivity(browser, () => ({
    inProgress: [
      activityItem("Close the month", "running", "responsibility"),
      activityItem("Running report", "running"),
    ],
    scheduled: [
      activityItem(longTitle, "scheduled"),
      activityItem("Review accounts", "scheduled"),
      activityItem("Review expenses", "scheduled"),
    ],
    completed: [activityItem("Completed report", "done")],
  }));

  await browser.setViewport({ width: 700, height: 820 });
  await app.open(`/bots/${bot.id}`);
  const heading = screen.getByRole("heading", "Activity", { exact: true });
  await expect(heading).toBeVisible();
  const section = browser.locator("section").filter({ has: heading });
  await expect
    .poll(() => activityTitles(browser, "Activity"))
    .toEqual(["Close the month", "Running report", longTitle, "All activity"]);
  await expect(
    section.getByText("2 in progress · 3 scheduled", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Completed report", { exact: true }),
  ).toHaveCount(0);

  const title = section.getByText(longTitle, { exact: true });
  await expect(title).toHaveAttribute("title", longTitle);
  const textOverflowsOnOneLine = await browser.evaluate((value) => {
    const itemTitle = [
      ...document.querySelectorAll<HTMLElement>("[data-slot='item-title']"),
    ].find((element) => element.textContent === value);
    if (!itemTitle) return false;
    const style = getComputedStyle(itemTitle);
    return (
      itemTitle.scrollWidth > itemTitle.clientWidth &&
      style.whiteSpace === "nowrap" &&
      style.textOverflow === "ellipsis"
    );
  }, longTitle);
  expect(textOverflowsOnOneLine).toBe(true);

  const goal = section.getByRole("link", /^Close the month/);
  await expect(goal).toContainText("Goal · running");
  await expect(goal).not.toContainText(/responsibilit/i);
  await goal.tap();
  await expect(browser).toHaveURL(`/bots/${bot.id}/responsibilities`);
});

test("on-demand Goals and scheduled Routines appear under separate headings", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  let scheduled = [activityItem("Check releases", "scheduled")];
  await serveActivity(browser, () => ({
    scheduled,
    onDemand: [
      activityItem("Watch OpenBot releases", "active", "responsibility"),
    ],
  }));

  const profile = `/bots/${bot.id}`;
  await app.open(profile);
  await expect(
    screen.getByText("1 scheduled · 1 on demand", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Watch OpenBot releases", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("link", /^All activity/).tap();
  await expect(browser).toHaveURL(`${profile}/activity`);
  await expect
    .poll(() => activityTitles(browser, "Scheduled"))
    .toEqual(["Check releases"]);
  await expect
    .poll(() => activityTitles(browser, "On demand"))
    .toEqual(["Watch OpenBot releases"]);

  scheduled = [];
  await app.open(profile);
  await expect(screen.getByText("1 on demand", { exact: true })).toBeVisible();
});

test("a Bot with no upcoming work links to Activity from For you", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  let completed = [activityItem("Completed report", "done")];
  let scheduled: ReturnType<typeof activityItem>[] = [];
  await serveActivity(browser, () => ({ scheduled, completed }));

  const profile = `/bots/${bot.id}`;
  await app.open(profile);
  const link = browser
    .locator("section")
    .filter({
      has: screen.getByRole("heading", "For you", { exact: true }),
    })
    .getByRole("link", /^Activity/);
  await expect(link).toContainText("Nothing running or scheduled");
  await expect(
    screen.getByRole("heading", "Activity", { exact: true }),
  ).toHaveCount(0);
  await link.tap();
  await expect(browser).toHaveURL(`${profile}/activity`);
  await expect(
    screen.getByText("Completed report", { exact: true }),
  ).toBeVisible();

  completed = [];
  await app.open(profile);
  await expect(link).toContainText("No tasks, routines or goals yet");

  scheduled = [activityItem("Review accounts", "scheduled")];
  await app.open(profile);
  await expect(screen.getByRole("link", /^All activity/)).toContainText(
    "1 scheduled",
  );
  await expect(link).toHaveCount(0);
});
