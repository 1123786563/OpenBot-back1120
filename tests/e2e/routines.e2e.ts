import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

function routine({
  id,
  agentId,
  botName,
  title,
  schedule,
  timezone,
  instruction,
  channel,
  enabled = true,
}: {
  id: string;
  agentId: string;
  botName: string;
  title: string | null;
  schedule: string;
  timezone: string;
  instruction: string;
  channel: { id: string; title: string };
  enabled?: boolean;
}) {
  return {
    id,
    agentId,
    title,
    schedule,
    timezone,
    instruction,
    enabled,
    channel: { ...channel, name: botName, gone: false },
    nextRunAt: "2099-01-01T08:00:00.000Z",
    lastRun: null,
  };
}

async function serveRoutines(
  browser: Browser,
  routines: ReturnType<typeof routine>[],
) {
  await browser.route(/\/api\/routines$/, (route) =>
    route.fulfill({
      json: {
        routines,
        sweep: { lastSweptAt: new Date().toISOString(), working: true },
      },
    }),
  );
}

test("Connections explains Routines and links to the list with its enabled count", async ({
  app,
  browser,
  screen,
}) => {
  const item = {
    agentId: "general-assistant",
    botName: "General Assistant",
    title: "Morning leads",
    schedule: "Weekdays at 09:00",
    timezone: "Europe/Madrid",
    instruction: "Send me a summary of yesterday's new leads",
    channel: { id: "conversation-1", title: "Leads" },
  };
  await serveRoutines(browser, [
    routine({ ...item, id: "routine-1" }),
    routine({
      ...item,
      id: "routine-2",
      title: "Paused leads",
      enabled: false,
    }),
  ]);
  await app.open("/connections/routines");
  await expect(
    screen.getByText(
      "Routines are work your Bots do on a schedule. Every Bot can set one up for you.",
    ),
  ).toBeVisible();
  const list = screen.getByRole("link", /Your routines/);
  await expect(list).toHaveAttribute("href", "/routines");
  await expect(list).toContainText("2 routines, 1 on.");
  await expect(
    screen.getByRole("button", "New routine", { exact: true }),
  ).toHaveAttribute("href", "/routines/new");
  await expect(screen.getByText(/create_routine/)).toHaveCount(0);
  await list.tap();
  await expect(browser).toHaveURL("/routines");
  await expect(
    screen.getByRole("heading", "Routines", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Morning leads", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("Paused leads", { exact: true })).toBeVisible();
});

test("the global list displays names, fallback schedules, Bots and posting conversations", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const shared = { agentId: bot.id, botName: bot.name };
  await serveRoutines(browser, [
    routine({
      ...shared,
      id: "routine-named",
      title: "Morning briefing",
      schedule: "Every day at 08:00",
      timezone: "Europe/Madrid",
      instruction: "Summarise my unread mail and today's meetings.",
      channel: { id: "conversation-briefing", title: "Briefings" },
    }),
    routine({
      ...shared,
      id: "routine-unnamed",
      title: null,
      schedule: "Weekdays at 18:00",
      timezone: "UTC",
      instruction: "Post the day's open pull requests.",
      channel: { id: "conversation-prs", title: "Pull requests" },
    }),
    routine({
      ...shared,
      id: "routine-eks",
      title: null,
      schedule: "Every 15 minutes",
      timezone: "UTC",
      instruction: "Reply with the current UTC time.",
      channel: { id: "conversation-eks", title: "15-Minute EKS UTC Routine" },
    }),
    routine({
      ...shared,
      id: "routine-new",
      title: null,
      schedule: "Every day at 09:00",
      timezone: "UTC",
      instruction: "Post the morning summary.",
      channel: { id: "conversation-new", title: "New conversation" },
    }),
  ]);
  await app.open("/routines");
  const titles = browser.locator('[data-slot="item-title"]');
  await expect(titles.filter({ hasText: /^Morning briefing$/ })).toBeVisible();
  const named = browser
    .locator('[data-slot="item"]')
    .filter({ has: screen.getByText("Morning briefing", { exact: true }) });
  await expect(named).toContainText("Every day at 08:00 · Europe/Madrid");
  await expect(named).toContainText(
    "Summarise my unread mail and today's meetings.",
  );
  await expect(
    titles.filter({ hasText: /Weekdays at 18:00\s*UTC/ }),
  ).toBeVisible();
  await expect(
    screen.getByText("Post the day's open pull requests."),
  ).toBeVisible();
  for (const [name, id] of [
    ["Briefings", "briefing"],
    ["Pull requests", "prs"],
    ["15-Minute EKS UTC Routine", "eks"],
    ["New conversation", "new"],
  ]) {
    await expect(
      browser.locator(`a[href="/channel/conversation-${id}"]`),
    ).toHaveText(name);
  }
  const botLink = named.getByRole("link", bot.name, { exact: true });
  await expect(botLink).toHaveAttribute("href", `/bots/${bot.id}/routines`);
  await botLink.tap();
  await expect(browser).toHaveURL(`/bots/${bot.id}/routines`);
  await expect(
    screen.getByText("Morning briefing", { exact: true }),
  ).toBeVisible();
});

test("the empty Routines lists open New routine and the Bot's list preselects the Bot", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  await serveRoutines(browser, []);
  const empty = browser.locator('[data-slot="empty"]');
  const create = empty.getByRole("button", "New routine", { exact: true });
  const heading = screen.getByRole("heading", "New routine", { exact: true });
  await app.open("/routines");
  await expect(
    empty.getByText("No routines yet", { exact: true }),
  ).toBeVisible();
  await expect(create).toHaveAttribute("href", "/routines/new");
  await create.tap();
  await expect(heading).toBeVisible();
  await expect(
    screen.getByRole("combobox", "Bot", { exact: true }),
  ).toContainText("Choose a Bot");

  await app.open(`/bots/${bot.id}/routines`);
  await expect(screen.getByText("No routines for this Bot yet")).toBeVisible();
  await expect(create).toHaveAttribute(
    "href",
    `/routines/new?agentId=${bot.id}`,
  );
  await create.tap();
  await expect(heading).toBeVisible();
  await expect(
    screen.getByRole("combobox", "Bot", { exact: true }),
  ).toContainText(bot.name);
});

test("the composer clock preselects its Bot and Conversation when creating a Routine", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await app.open(`/channel/${channel}`);
  const clock = screen.getByRole("button", "Set up a routine", { exact: true });
  await expect(clock).toHaveAttribute(
    "href",
    `/routines/new?agentId=${bot.id}&channelId=${channel}`,
  );
  await clock.tap();
  await expect(
    screen.getByRole("heading", "New routine", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("combobox", "Bot", { exact: true }),
  ).toContainText(bot.name);
  await expect(
    screen.getByRole("combobox", "Posts in", { exact: true }),
  ).toContainText("This conversation");
  await expect(
    screen.getByText("Every weekday at 9:00 AM", { exact: true }),
  ).toBeVisible();
  const instruction =
    "Check the support queue and summarize open conversations.";
  await screen
    .getByRole("textbox", "What to do", { exact: true })
    .fill(instruction);
  await screen.getByRole("button", "Create routine", { exact: true }).tap();
  await expect(browser).toHaveURL("/routines");
  const created = browser
    .locator('[data-slot="item"]')
    .filter({ has: screen.getByText(instruction, { exact: true }) });
  await expect(created).toBeVisible();
  await expect(
    created.getByRole("link", bot.name, { exact: true }),
  ).toBeVisible();
  const destinations = () =>
    browser.evaluate((instruction) => {
      const row = Array.from(
        document.querySelectorAll('[data-slot="item"]'),
      ).find((item) => item.textContent?.includes(instruction));
      return Array.from(row?.querySelectorAll("a") ?? [], (link) =>
        link.getAttribute("href"),
      );
    }, instruction);
  expect(await destinations()).toContain(`/channel/${channel}`);
  await browser.reload();
  await expect(created).toBeVisible();
  expect(await destinations()).toContain(`/channel/${channel}`);

  const enabled = created.getByRole("switch", /^Enable the routine scheduled/);
  const runNow = created.getByRole("button", /^Run the routine scheduled/);
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await enabled.tap();
  await expect(created.getByText("Paused", { exact: true })).toBeVisible();
  await expect(runNow).toBeDisabled();
  await browser.reload();
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  await expect(runNow).toBeDisabled();
  await enabled.tap();
  await expect(runNow).toBeEnabled();

  const remove = created.getByRole("button", /^Delete the routine scheduled/);
  const confirmation = screen.getByRole("dialog", /^Delete "/);
  await remove.tap();
  await expect(confirmation).toContainText("This routine stops for good.");
  await confirmation.getByRole("button", "Cancel", { exact: true }).tap();
  await expect(confirmation).toBeHidden();
  await expect(created).toBeVisible();
  await remove.tap();
  await confirmation.getByRole("button", "Delete", { exact: true }).tap();
  await expect(created).toHaveCount(0);
  await browser.reload();
  await expect(
    screen.getByText("No routines yet", { exact: true }),
  ).toBeVisible();
});

test("Run now opens History and updates the run outcome when it settles", async ({
  app,
  browser,
  screen,
}) => {
  const id = "routine-history";
  const channel = "routine-conversation";
  await serveRoutines(browser, [
    routine({
      id,
      agentId: "general-assistant",
      botName: "General Assistant",
      title: "Track the inbox",
      schedule: "Every day at 08:00",
      timezone: "UTC",
      instruction: "Summarize the unread items.",
      channel: { id: channel, title: "Inbox review" },
    }),
  ]);
  let finished = false;
  const runRequests: string[] = [];
  const startedAt = new Date().toISOString();
  await browser.route(/\/api\/routines\/routine-history\/run$/, (route) => {
    runRequests.push(route.request.method);
    return route.fulfill({
      status: 202,
      json: { accepted: true, runId: "manual-run" },
    });
  });
  await browser.route(/\/api\/routines\/routine-history\/runs$/, (route) =>
    route.fulfill({
      json: {
        runs:
          runRequests.length > 0
            ? [
                {
                  id: "manual-run",
                  status: finished ? "failed" : "running",
                  source: "run_now",
                  startedAt,
                  finishedAt: finished ? startedAt : null,
                  error: finished ? "The test model was unavailable." : null,
                },
              ]
            : [],
      },
    }),
  );
  await app.open("/routines");
  const row = browser
    .locator('[data-slot="item"]')
    .filter({ has: screen.getByText("Track the inbox", { exact: true }) });
  const history = row.getByRole("button", /^Run history for the routine/);
  await history.tap();
  await expect(row.getByText("No runs yet.", { exact: true })).toBeVisible();
  await history.tap();
  await expect(history).toHaveAttribute("aria-expanded", "false");
  await row.getByRole("button", /^Run the routine scheduled/).tap();
  await expect(history).toHaveAttribute("aria-expanded", "true");
  await expect(row.getByText("Running", { exact: true })).toBeVisible();
  expect(runRequests).toEqual(["POST"]);
  const conversation = row.getByRole("link", "Open conversation", {
    exact: true,
  });
  await expect(conversation).toHaveAttribute("href", `/channel/${channel}`);
  finished = true;
  await expect(
    row.getByText("The test model was unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(row.getByText("Failed", { exact: true })).toBeVisible();
  await expect(row.getByText("Running", { exact: true })).toHaveCount(0);
});
