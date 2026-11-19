import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const skipped = (counts: Record<string, number>) => ({
  off_admin: 0,
  off_person: 0,
  paused: 0,
  capped: 0,
  unreachable: 0,
  no_sources: 0,
  busy: 0,
  ...counts,
});

const inbox = {
  agentId: "inbox-bot",
  name: "Inbox Bot",
  avatarSeed: "inbox-bot",
  peopleOn: 11,
  runs: {
    quiet: 1227,
    raised: 37,
    failed: 12,
    skipped: skipped({ paused: 4, capped: 2 }),
  },
  items: { raised: 47, started: 29, hidden: 9, cleared: 2, open: 7 },
  acceptance: 29 / 38,
  pinged: 44,
};
const fresh = {
  agentId: "general-assistant",
  name: "General Assistant",
  avatarSeed: "general-assistant",
  peopleOn: 2,
  runs: { quiet: 0, raised: 0, failed: 0, skipped: skipped({}) },
  items: { raised: 0, started: 0, hidden: 0, cleared: 0, open: 0 },
  acceptance: null,
  pinged: 0,
};

const checkIns = "/admin/proactive";
const capability = "/api/admin/enterprise/capabilities";
const limit = "/api/admin/enterprise/settings/proactiveDailyRuns";
const disabledCheckIns = {
  scopeKind: "organization",
  scopeId: "",
  capability: "proactive",
  allowed: false,
};

async function serveCheckIns(browser: Browser) {
  let organization: boolean | null = null;
  let dailyRuns = 24;
  const writes: { request: string; body: unknown }[] = [];
  const periods: string[] = [];
  await browser.route(/\/api\/admin\/enterprise$/, (route) =>
    route.fulfill({
      json: {
        capabilities: [
          {
            capability: "proactive",
            title: "Check-ins",
            description:
              "Bots check people's apps in the background and tell them when something needs them.",
            default: true,
            organization,
            roles: {},
            groups: {},
          },
        ],
        settings: { proactiveDailyRuns: dailyRuns },
      },
    }),
  );
  await browser.route(/\/api\/admin\/proactive\?days=(7|30)$/, (route) => {
    const day = new URL(route.request.url).searchParams.get("days")!;
    periods.push(day);
    return route.fulfill({
      json: {
        days: Number(day),
        dailyRuns,
        bots: [fresh, inbox],
        pings: { sent: 59, itemsPerPing: 2.2291 },
      },
    });
  });
  await browser.route(/\/api\/admin\/enterprise\/capabilities$/, (route) => {
    const body: { allowed: boolean } = JSON.parse(
      route.request.postData ?? "null",
    );
    writes.push({ request: `${route.request.method} ${capability}`, body });
    organization = body.allowed;
    return route.fulfill({ json: { saved: body } });
  });
  await browser.route(
    /\/api\/admin\/enterprise\/settings\/proactiveDailyRuns$/,
    (route) => {
      const body: { value: number } = JSON.parse(
        route.request.postData ?? "null",
      );
      writes.push({ request: `${route.request.method} ${limit}`, body });
      dailyRuns = body.value;
      return route.fulfill({
        json: { key: "proactiveDailyRuns", value: dailyRuns },
      });
    },
  );
  return { periods, writes };
}

test("Check-ins shows Bot acceptance and counts only nonzero skip reasons", async ({
  app,
  browser,
  screen,
}) => {
  const { periods, writes } = await serveCheckIns(browser);
  await app.open(checkIns);
  const row = screen.getByRole("button", /^Inbox Bot/);
  await expect(row).toContainText("11 people · 1,276 check-ins · 47 items");
  await expect(row).toContainText("76% started");
  await expect(screen.getByRole("button", /^General Assistant/)).toContainText(
    "No answers yet",
  );
  await expect(
    screen.getByText("2.2 items in each, on average", { exact: true }),
  ).toBeVisible();
  expect(periods).toEqual(["7"]);

  await row.click();
  const dialog = screen.getByRole("dialog", "Inbox Bot");
  await expect(dialog).toContainText(
    "Last 7 days. 11 people have check-ins on now.",
  );
  await expect(
    dialog.getByText("Turned off by an admin", { exact: true }),
  ).toHaveCount(0);
  const counts = await browser.evaluate(
    (labels) => {
      const terms = Array.from(document.querySelectorAll('[role="dialog"] dt'));
      return labels.map((label) => {
        const term = terms.find((node) => node.textContent?.trim() === label);
        return term?.nextElementSibling?.textContent?.trim() ?? null;
      });
    },
    ["Skipped before looking", "Bot paused", "Over the daily limit"],
  );
  expect(counts).toEqual(["6", "4", "2"]);
  expect(writes).toEqual([]);
});

test("Check-ins saves the organization switch and only a valid daily limit", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveCheckIns(browser);
  await app.open(checkIns);
  const toggle = screen.getByRole("switch", "Check-ins", { exact: true });
  const off = screen.getByText("Off. No Bot checks in for anybody.", {
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(off).toBeVisible();
  const toggleWrite = { request: `PUT ${capability}`, body: disabledCheckIns };
  expect(writes).toEqual([toggleWrite]);

  const dailyLimit = screen.getByRole("button", /^Daily limit/);
  await dailyLimit.click();
  const dialog = screen.getByRole("dialog", "Daily limit");
  const field = dialog.getByLabel("Check-ins a day per Bot, for each person", {
    exact: true,
  });
  const save = dialog.getByRole("button", "Save", { exact: true });
  for (const value of ["0", "1441", "2.5", ""]) {
    await field.fill(value);
    await expect(save).toBeDisabled();
  }
  expect(writes).toEqual([toggleWrite]);
  for (const value of ["1", "1440", "12"]) {
    await field.fill(value);
    await expect(save).toBeEnabled();
  }
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([
    toggleWrite,
    { request: `PUT ${limit}`, body: { value: 12 } },
  ]);
  await expect(dailyLimit).toContainText(
    "Up to 12 check-ins a day per Bot for each person",
  );

  await browser.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(off).toBeVisible();
  await dailyLimit.click();
  await expect(field).toHaveValue("12");
});
