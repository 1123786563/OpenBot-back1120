import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

const GMAIL = {
  id: "00000000-0000-4000-8000-000000000001",
  actorUserId: null,
  initiatorKind: "routine",
  initiatorId: "routine-digest",
  eventType: "mcp.call_succeeded",
  targetType: "mcp_tool",
  targetId: "composio-gmail/GMAIL_SEND_EMAIL",
  payload: {
    bot: "inbox",
    server: "composio-gmail",
    tool: "GMAIL_SEND_EMAIL",
    effect: "write",
  },
  createdAt: "2026-11-06T15:20:00.000Z",
};
const CLICK = {
  id: "00000000-0000-4000-8000-000000000002",
  actorUserId: "dana",
  initiatorKind: "person",
  initiatorId: null,
  eventType: "computer.action_allowed",
  targetType: "computer",
  targetId: "inbox",
  payload: {
    bot: "inbox",
    action: "computer_click",
    element: { name: "Archive", role: "button" },
  },
  createdAt: "2026-11-07T15:20:00.000Z",
};

/** What `POST /api/admin/audit-events/ask` answered on the real page for the same question. */
const ANSWERED = {
  answerable: "yes",
  unanswered: null,
  filters: {
    initiatorKind: ["routine"],
    app: ["gmail"],
    effect: "write",
    from: "2026-11-02T08:00:00.000Z",
    to: "2026-11-09T08:00:00.000Z",
  },
  reading:
    "Rows of Bot activity started by a routine, calling Gmail to change something, from 2 November through 8 November.",
  labels: { bots: {}, people: {}, apps: { gmail: "Gmail" }, rules: {} },
};
const UNANSWERABLE = {
  answerable: "no",
  unanswered:
    "The trail does not record email text. Tool arguments and message contents are left out on purpose.",
  filters: {},
  reading: null,
  labels: { bots: {}, people: {}, apps: {}, rules: {} },
};

const question = "Show me every Gmail write by a routine last week";

async function serveAudit(
  browser: Browser,
  answers: (typeof ANSWERED | typeof UNANSWERABLE)[],
) {
  const asks: unknown[] = [];
  const reads: URLSearchParams[] = [];
  await browser.route(/\/api\/admin\/audit-events\/ask$/, (route) => {
    asks.push(JSON.parse(route.request.postData ?? "null"));
    const answer = answers[asks.length - 1];
    return answer
      ? route.fulfill({ json: answer })
      : route.fulfill({ status: 400, json: { error: "Unexpected question" } });
  });
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) => {
    const search = new URL(route.request.url).searchParams;
    reads.push(search);
    return route.fulfill({
      json: { events: search.has("app") ? [GMAIL] : [GMAIL, CLICK] },
    });
  });
  return { asks, reads };
}

async function ask({ screen }: Pick<TestFixtures, "screen">, question: string) {
  await screen.getByLabel("Ask about the audit trail").fill(question);
  await screen.getByRole("button", "Ask", { exact: true }).tap();
}

test("Audit Ask applies returned filters and removing a chip refreshes the rows", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { asks, reads } = await serveAudit(browser, [ANSWERED]);
  await app.open("/admin/audit");
  const count = browser.locator("[data-audit-count]");
  await expect(count).toHaveText("2 events");
  await ask(fixtures, question);
  await expect(count).toHaveText("1 event");
  const reading = browser.locator("[data-audit-reading]");
  await expect(reading).toContainText(ANSWERED.reading);
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ question });
  const labels = await browser.evaluate(() =>
    Array.from(
      document.querySelectorAll("[data-audit-chip]"),
      (chip) => chip.textContent,
    ),
  );
  expect(labels.slice(0, 3)).toEqual([
    "Started by: A routine",
    "App: Gmail",
    "Effect: Changes something",
  ]);
  expect(labels).toHaveLength(5);
  expect(labels[3]).toMatch(/^After: /);
  expect(labels[4]).toMatch(/^Before: /);
  expect(Object.fromEntries(reads.at(-1) ?? [])).toMatchObject({
    app: "gmail",
    effect: "write",
    initiatorKind: "routine",
    from: "2026-11-02T08:00:00.000Z",
  });
  expect(
    await screen.getByLabel("Ask about the audit trail").inputValue(),
  ).toBe(question);
  await screen.getByRole("button", "Remove App: Gmail", { exact: true }).tap();
  await expect(count).toHaveText("2 events");
  const changed = reads.at(-1);
  expect(changed?.has("app")).toBe(false);
  expect(changed?.get("effect")).toBe("write");
  await expect(
    screen.getByText(/^You've changed the filters since\./),
  ).toBeVisible();
});

test("an unanswerable Audit question explains why and restores the unfiltered trail", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { asks, reads } = await serveAudit(browser, [ANSWERED, UNANSWERABLE]);
  await app.open("/admin/audit");
  const count = browser.locator("[data-audit-count]");
  await expect(count).toHaveText("2 events");
  await ask(fixtures, question);
  await expect(count).toHaveText("1 event");

  const followup =
    "What did the Inbox triage Bot write in the emails it sent yesterday?";
  await ask(fixtures, followup);
  const explanation = screen.getByText(/^The trail can't answer this\./);
  await expect(explanation).toBeVisible();
  await expect(explanation).toContainText(UNANSWERABLE.unanswered);
  await expect(browser.locator("[data-audit-chip]")).toHaveCount(0);
  await expect(browser.locator("[data-audit-reading]")).toHaveCount(0);
  await expect(count).toHaveText("2 events");
  expect(asks).toHaveLength(2);
  expect(asks[1]).toMatchObject({ question: followup });
  expect(reads.at(-1)?.has("app")).toBe(false);
});

test("Audit offers one set of filters beside the search and count", async ({
  app,
  browser,
  screen,
}) => {
  const readFilters: (string | null)[] = [];
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) => {
    const initiator = new URL(route.request.url).searchParams.get(
      "initiatorKind",
    );
    readFilters.push(initiator);
    const events = initiator === "routine" ? [GMAIL] : [GMAIL, CLICK];
    return route.fulfill({ json: { events } });
  });
  await browser.setViewport({ width: 1600, height: 900 });
  await app.open("/admin/audit");
  const count = browser.locator("[data-audit-count]");
  await expect(count).toHaveText("2 events");
  const search = screen.getByRole("searchbox", "Search events");
  const add = screen.getByRole("button", "Add filter", { exact: true });
  const [searchBox, buttonBox, countBox] = await Promise.all([
    search.boundingBox(),
    add.boundingBox(),
    count.boundingBox(),
  ]);
  if (!searchBox || !buttonBox || !countBox)
    throw new Error("Audit toolbar is missing");
  expect(buttonBox.x).toBeGreaterThan(searchBox.x);
  expect(countBox.x).toBeGreaterThan(buttonBox.x);
  expect(
    Math.abs(
      buttonBox.y + buttonBox.height / 2 - (searchBox.y + searchBox.height / 2),
    ),
  ).toBeLessThan(2);
  expect(
    Math.abs(
      buttonBox.y + buttonBox.height / 2 - (countBox.y + countBox.height / 2),
    ),
  ).toBeLessThan(2);
  await add.tap();
  const menu = screen.getByRole("menu");
  for (const name of ["Outcome", "Bot", "Started by"]) {
    await expect(menu.getByRole("menuitem", name, { exact: true })).toHaveCount(
      1,
    );
    await expect(screen.getByRole("button", name, { exact: true })).toHaveCount(
      0,
    );
  }
  await menu
    .getByRole("menuitem", "Started by", { exact: true })
    .press("ArrowRight");
  await screen
    .getByRole("menuitemcheckbox", "A routine", { exact: true })
    .tap();
  await expect(count).toHaveText("1 event");
  expect(readFilters).toEqual([null, "routine"]);
  await expect(
    browser
      .locator("tbody tr")
      .getByText("Started by a routine", { exact: true }),
  ).toBeVisible();
});
