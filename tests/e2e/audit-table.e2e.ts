import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

function event(
  id: string,
  eventType: string,
  at: string,
  payload: { action: string; element: string | { name: string; role: string } },
) {
  return {
    id,
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType: "computer",
    targetId: "bot-a",
    payload: { bot: "bot-a", ...payload },
    createdAt: at,
  };
}

const ROWS = [
  event("e1", "computer.action_allowed", "2026-10-27T09:00:00Z", {
    action: "computer_click",
    element: { name: "Save deal", role: "button" },
  }),
  event("e2", "computer.action_refused", "2026-10-27T10:00:00Z", {
    action: "computer_navigate",
    element: "https://evil.test",
  }),
  event("e3", "computer.action_failed", "2026-10-27T08:00:00Z", {
    action: "computer_type",
    element: { name: "Notes", role: "textbox" },
  }),
];

const LAYOUT_ROWS: {
  id: string;
  actorUserId: string | null;
  initiatorKind: string;
  initiatorId: string | null;
  eventType: string;
  targetType: string;
  targetId: string;
  payload: Record<string, string>;
  createdAt: string;
}[] = [
  {
    id: "e1",
    actorUserId: "person",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.action_refused",
    targetType: "computer",
    targetId: "bot-a",
    payload: {
      bot: "bot-a",
      action: "computer_write_file",
      file: "reports/refused.txt",
    },
    createdAt: "2026-11-06T09:00:00Z",
  },
  {
    id: "e3",
    actorUserId: "person",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "mcp.call_rejected",
    targetType: "mcp_tool",
    targetId: "notes/create_note",
    payload: {
      bot: "bot-a",
      reason:
        "A refusal's reason can be a whole sentence, long enough to push a fixed column past the window: https://example.test/a/very/long/address/with/no/spaces/in/it",
    },
    createdAt: "2026-11-06T07:00:00Z",
  },
  {
    id: "e2",
    actorUserId: null,
    initiatorKind: "routine",
    initiatorId: "routine-1",
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: "bot-a",
    payload: { bot: "bot-a", action: "computer_read_file", file: "notes.md" },
    createdAt: "2026-11-06T08:00:00Z",
  },
];

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const eventsEndpoint = /\/api\/admin\/audit-events(?:\?|$)/;
const scrollTable = '[data-slot="table-container"]';

if (personal) {
  test("Activity filters loaded events by Outcome and Started by", async ({
    app,
    browser,
    screen,
  }) => {
    let reads = 0;
    await browser.route(eventsEndpoint, (route) => {
      reads += 1;
      return route.fulfill({ json: { events: LAYOUT_ROWS } });
    });
    await app.open("/settings/activity");
    const count = browser.locator("[data-audit-count]");
    await expect(count).toHaveText("3 events");
    const outcome = screen.getByRole("button", /^Outcome/);
    await outcome.tap();
    await screen.getByRole("menuitemcheckbox", /^Blocked/).tap();
    await expect(count).toHaveText("2 of 3 events");
    await expect(
      browser.locator('tbody tr[data-outcome="allowed"]'),
    ).toHaveCount(0);
    await screen.getByRole("menuitemcheckbox", /^Blocked/).tap();
    await expect(count).toHaveText("3 events");
    await outcome.press("Escape");

    await screen.getByRole("button", /^Started by/).tap();
    await screen.getByRole("menuitemcheckbox", /^A routine/).tap();
    await expect(count).toHaveText("1 of 3 events");
    await expect(browser.locator("tbody")).toContainText("notes.md");
    expect(reads).toBe(1);
  });

  test("Activity fills its panel and scrolls events independently of its heading", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width: 1280, height: 760 });
    const many = Array.from({ length: 42 }, (_, index) =>
      event(
        `event-${index}`,
        "computer.action_allowed",
        new Date(Date.UTC(2026, 9, 27, 9, index)).toISOString(),
        {
          action: "computer_click",
          element: { name: `Record ${index + 1}`, role: "button" },
        },
      ),
    );
    await browser.route(eventsEndpoint, (route) =>
      route.fulfill({ json: { events: many } }),
    );
    await app.open("/settings/activity");
    const heading = screen.getByRole("heading", "Activity", { exact: true });
    await expect(heading).toBeVisible();
    await expect(browser.locator("tbody tr")).toHaveCount(42);
    const y = (await heading.boundingBox())?.y;
    expect(y).toBeGreaterThan(0);
    const geometry = await browser.evaluate((selector) => {
      const scroller = document.querySelector(selector);
      const panel = scroller?.closest("main");
      if (!scroller || !panel) throw new Error("Missing Activity panel");
      scroller.scrollTop = scroller.scrollHeight;
      return {
        scrollTop: scroller.scrollTop,
        tableWidth: scroller.getBoundingClientRect().width,
        panelWidth: panel.clientWidth,
        tableBottom: scroller.getBoundingClientRect().bottom,
        panelBottom:
          panel.getBoundingClientRect().top +
          panel.clientTop +
          panel.clientHeight,
        panelScrollTop: panel.scrollTop,
      };
    }, scrollTable);
    expect(geometry.scrollTop).toBeGreaterThan(0);
    expect(Math.abs(geometry.tableWidth - geometry.panelWidth)).toBeLessThan(2);
    expect(Math.abs(geometry.tableBottom - geometry.panelBottom)).toBeLessThan(
      3,
    );
    expect(geometry.panelScrollTop).toBe(0);
    expect((await heading.boundingBox())?.y).toBe(y);
  });
} else {
  test("Audit sorts events, labels their outcomes, and searches the loaded rows", async ({
    app,
    browser,
    screen,
  }) => {
    let reads = 0;
    await browser.route(eventsEndpoint, (route) => {
      reads += 1;
      return route.fulfill({ json: { events: ROWS } });
    });
    await app.open("/admin/audit");
    await expect(browser.locator("tbody tr")).toHaveCount(3);
    const displayed = () =>
      browser.evaluate(() =>
        Array.from(document.querySelectorAll("tbody tr"), (row) => ({
          what:
            row.querySelector('[data-column="what"] > div')?.textContent ?? "",
          outcome: row.getAttribute("data-outcome"),
        })),
      );
    const newest = [
      { what: "Open a page", outcome: "refused" },
      { what: "Click on a page", outcome: "allowed" },
      { what: "Fill in a field", outcome: "did-not-happen" },
    ];
    expect(await displayed()).toEqual(newest);
    await screen.getByRole("button", /^When/).tap();
    await expect.poll(displayed).toEqual([...newest].reverse());
    await screen.getByRole("searchbox", "Search events").fill("save deal");
    await expect(browser.locator("[data-audit-count]")).toHaveText(
      "1 of 3 events",
    );
    expect(await displayed()).toEqual([newest[1]]);
    expect(reads).toBe(1);
  });

  test("Audit's five columns keep file details and decisions readable at desktop widths", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    await browser.route(eventsEndpoint, (route) =>
      route.fulfill({
        json: {
          events: LAYOUT_ROWS.map((row) => ({
            ...row,
            payload: { ...row.payload, bot: bot.id },
          })),
        },
      }),
    );
    await app.open("/admin/audit");
    await expect(
      screen.getByText("reports/refused.txt", { exact: true }),
    ).toBeVisible();
    const columns = await browser.evaluate(() => {
      const cell = (row: Element, column: string) =>
        Array.from(
          row.querySelectorAll(`[data-column="${column}"] > div`),
          (line) => line.textContent,
        );
      return {
        headings: Array.from(
          document.querySelectorAll("thead th"),
          (th) => th.textContent,
        ),
        rows: Array.from(document.querySelectorAll("tbody tr"), (row) => ({
          what: cell(row, "what"),
          bot: cell(row, "bot"),
        })),
      };
    });
    expect(columns.headings).toEqual([
      "Outcome",
      "When, newest first",
      "What",
      "Bot",
      "Decision",
    ]);
    expect(columns.rows[0]).toEqual({
      what: ["Save a file", "reports/refused.txt"],
      bot: [bot.name, "Started by a person"],
    });
    expect(columns.rows[1]?.bot).toEqual([bot.name, "Started by a routine"]);

    for (const width of [1000, 1440]) {
      await browser.setViewport({ width, height: 820 });
      const sizes = await browser.evaluate((selector) => {
        const scroller = document.querySelector(selector);
        const decision = document.querySelector('[data-column="decision"]');
        const paragraphs = Array.from(
          document.querySelectorAll<HTMLElement>('[data-column="decision"] *'),
        );
        const reason = paragraphs.find(
          (item) =>
            item.childElementCount === 0 &&
            item.textContent?.startsWith("A refusal's reason"),
        );
        if (!scroller || !decision || !reason)
          throw new Error("Audit layout is missing");
        const lines = document.createRange();
        lines.selectNodeContents(reason);
        return {
          viewport: scroller.clientWidth,
          content: scroller.scrollWidth,
          decision: decision.getBoundingClientRect().width,
          reasonLines: lines.getClientRects().length,
          reasonWidth: reason.getBoundingClientRect().width,
        };
      }, scrollTable);
      expect(sizes.content - sizes.viewport).toBeLessThanOrEqual(1);
      expect(sizes.decision).toBeGreaterThanOrEqual(255);
      expect(sizes.reasonLines).toBeGreaterThan(1);
      expect(sizes.reasonWidth).toBeLessThanOrEqual(352);
    }
  });

  test("Admin Audit scrolls its bounded table and recording history separately", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width: 1280, height: 760 });
    const events = Array.from({ length: 42 }, (_, i) => ({
      ...ROWS[i % ROWS.length],
      id: `event-${i}`,
    }));
    await browser.route(eventsEndpoint, (route) =>
      route.fulfill({ json: { events } }),
    );
    await browser.route(/\/api\/admin\/enterprise$/, (route) =>
      route.fulfill({
        json: {
          settings: { actionRecording: true },
          actionRecordRetentionDays: 30,
          otel: { configured: false },
        },
      }),
    );
    await browser.route(/\/api\/admin\/enterprise\/actions\?/, (route) =>
      route.fulfill({
        json: {
          actions: Array.from({ length: 40 }, (_, i) => ({
            id: `command-${i}`,
            surface: "cloud",
            botId: "general-assistant",
            toolName: "shell",
            command: `Recorded command ${i + 1}`,
            outcome: "allowed",
            createdAt: "2026-11-08T12:00:00Z",
          })),
        },
      }),
    );
    await app.open("/admin/audit");
    await expect(browser.locator("tbody tr")).toHaveCount(42);
    const lastCommand = screen.getByText("Recorded command 40", {
      exact: true,
    });
    await expect(lastCommand).toBeVisible();
    const auditHeading = screen.getByRole("heading", "Audit", { exact: true });
    const headingY = (await auditHeading.boundingBox())?.y;
    const positions = await browser.evaluate((selector) => {
      const table = document.querySelector(selector);
      const last = Array.from(
        document.querySelectorAll('[data-slot="item-title"]'),
      ).find((node) => node.textContent === "Recorded command 40");
      if (!table || !last)
        throw new Error("Audit or recording list is missing");
      let outer = table.parentElement;
      while (
        outer &&
        !(
          ["auto", "scroll"].includes(getComputedStyle(outer).overflowY) &&
          outer.contains(last)
        )
      ) {
        outer = outer.parentElement;
      }
      if (!outer)
        throw new Error("Missing scroll region for Audit and Recording");
      table.scrollTop = table.scrollHeight;
      const tableTop = table.scrollTop;
      const outerBefore = outer.scrollTop;
      outer.scrollTop = outer.scrollHeight;
      return {
        isSeparate: !table.contains(last),
        tableTop,
        tableAfter: table.scrollTop,
        outerBefore,
        outerAfter: outer.scrollTop,
        lastBottom: last.getBoundingClientRect().bottom,
        outerBottom: outer.getBoundingClientRect().bottom,
      };
    }, scrollTable);
    expect(positions.isSeparate).toBe(true);
    expect(positions.tableTop).toBeGreaterThan(0);
    expect(positions.outerBefore).toBe(0);
    expect(positions.outerAfter).toBeGreaterThan(0);
    expect(positions.tableAfter).toBe(positions.tableTop);
    expect(positions.lastBottom).toBeLessThan(positions.outerBottom);
    expect((await auditHeading.boundingBox())?.y).toBe(headingY);
  });
}
