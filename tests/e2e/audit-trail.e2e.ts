import { readFile } from "node:fs/promises";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { connectAppRefusal } from "../../shared/connect-prompt";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const eventsEndpoint = /\/api\/admin\/audit-events(?:\?|$)/;

function storedRow(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: "personal-assistant",
    createdAt: new Date(
      Date.UTC(2026, 10, 8, 12, 0) - index * 60_000,
    ).toISOString(),
    payload: {
      bot: "personal-assistant",
      action: "computer_click",
      element: { name: `Button ${index}`, role: "button" },
    },
  };
}

if (personal) {
  test("Activity labels the newest events and loads an older page with the same filters", async ({
    app,
    browser,
    screen,
  }) => {
    const last = storedRow(50);
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: last.createdAt, id: last.id }),
    ).toString("base64url");
    const requested: URLSearchParams[] = [];
    await browser.route(eventsEndpoint, (route) => {
      const search = new URL(route.request.url).searchParams;
      requested.push(search);
      const older = search.has("cursor");
      const rows = Array.from({ length: older ? 10 : 50 }, (_, i) =>
        storedRow(i + (older ? 51 : 1)),
      );
      return route.fulfill({
        json: { events: rows, ...(older ? {} : { nextCursor: cursor }) },
      });
    });

    await app.open("/settings/activity");
    await expect(
      screen.getByText("Newest 50 events", { exact: true }),
    ).toBeVisible();
    const table = browser.locator("tbody");
    await expect(table).toContainText("Button 50");
    await expect(table).not.toContainText("Button 51");
    const older = screen.getByRole("button", "Show older events", {
      exact: true,
    });
    await older.tap();
    await expect(screen.getByText("60 events", { exact: true })).toBeVisible();
    await expect(table).toContainText("Button 60");
    await expect(browser.locator("tbody tr[data-outcome]")).toHaveCount(60);
    await expect(older).toHaveCount(0);
    expect(requested).toHaveLength(2);
    const [latest, earlier] = requested;
    expect(earlier?.get("cursor")).toBe(cursor);
    expect(latest?.has("excludeEventType")).toBe(true);
    expect(earlier?.get("excludeEventType")).toBe(
      latest?.get("excludeEventType"),
    );
  });
} else {
  const dryRun = "dry-run: recorded, not enforced";
  const policyDecisions = [
    {
      name: "a trial-mode refusal that went ahead",
      eventType: "computer.action_refused",
      allowed: false,
      mode: "dry-run",
      carriedOut: true,
      label: "Blocked",
      note: true,
    },
    {
      name: "an allowed action in trial mode",
      eventType: "computer.action_allowed",
      allowed: true,
      mode: "dry-run",
      carriedOut: true,
      label: "Allowed",
      note: false,
    },
    {
      name: "an enforced refusal",
      eventType: "computer.action_refused",
      allowed: false,
      mode: "enforce",
      carriedOut: false,
      label: "Blocked",
      note: false,
    },
  ];
  for (const {
    name,
    eventType,
    allowed,
    mode,
    carriedOut,
    label,
    note,
  } of policyDecisions) {
    test(`Audit records ${name}`, async ({ app, browser }) => {
      const row = storedRow(1);
      const decision = {
        allowed,
        mode,
        source: allowed ? "allow" : "deny",
        rule: allowed ? "true" : 'element.name == "Submit"',
        carriedOut,
      };
      await browser.route(eventsEndpoint, (route) =>
        route.fulfill({
          json: {
            events: [
              { ...row, eventType, payload: { ...row.payload, decision } },
            ],
          },
        }),
      );
      await app.open("/admin/audit");
      const tableRow = browser.locator("tbody tr");
      await expect(tableRow.getByText(label, { exact: true })).toBeVisible();
      await expect(tableRow.getByText(dryRun, { exact: true })).toHaveCount(
        note ? 1 : 0,
      );
    });
  }

  test("Audit shows a tool call stopped by content inspection as blocked", async ({
    app,
    browser,
  }) => {
    const row = {
      ...storedRow(1),
      eventType: "mcp.call_rejected",
      targetType: "mcp_tool",
      targetId: "google-drive/search_files",
      payload: {
        bot: "personal-assistant",
        server: "google-drive",
        tool: "search_files",
        refusal: "sensitive_tool_arguments",
        contentInspection: {
          reason: "sensitive_content",
          findings: [{ category: "credential_field", path: "$.nested.apiKey" }],
        },
        decision: {
          allowed: true,
          mode: "dry-run",
          source: "allow",
          rule: "true",
          carriedOut: true,
        },
      },
    };
    await browser.route(eventsEndpoint, (route) =>
      route.fulfill({ json: { events: [row] } }),
    );
    await app.open("/admin/audit");
    const tableRow = browser.locator("tbody tr");
    await expect(tableRow.getByText("Blocked", { exact: true })).toBeVisible();
    await expect(tableRow.getByText(dryRun, { exact: true })).toHaveCount(0);
  });

  for (const capped of [true, false]) {
    test(`Audit downloads the ${capped ? "capped" : "complete"} CSV and reports its scope`, async ({
      app,
      browser,
      screen,
    }) => {
      const csv = "id,eventType\nevent-1,routine.created\n";
      const exports: string[] = [];
      await browser.route(eventsEndpoint, (route) => {
        const url = new URL(route.request.url);
        if (url.searchParams.get("format") !== "csv")
          return route.fulfill({ json: { events: [] } });
        exports.push(url.search);
        return route.fulfill({
          contentType: "text/csv",
          body: csv,
          ...(capped
            ? { headers: { "x-audit-export-truncated": "5000" } }
            : {}),
        });
      });
      await app.open("/admin/audit");
      const exportCsv = screen.getByRole("button", "Export CSV", {
        exact: true,
      });
      const download = await browser.waitForDownload(() => exportCsv.tap());
      expect(download.suggestedFilename).toMatch(
        /^audit-events-\d{4}-\d{2}-\d{2}\.csv$/,
      );
      expect(await readFile(download.absolutePath, "utf8")).toBe(csv);
      expect(exports).toEqual(["?format=csv"]);
      await expect(exportCsv).toBeEnabled();
      const notice = screen
        .getByRole("status")
        .filter({ hasText: /newest 5,000 events/ });
      await expect(notice).toHaveCount(capped ? 1 : 0);
      if (capped) await expect(notice).toBeVisible();
    });
  }
}

const BOT = "personal-assistant";
const REF = "composio-gmail/GMAIL_FETCH_EMAILS";

/** An `mcp.call_failed` row as `callTool` writes it when the call's credential was refused. */
function failedCall(id: string, minute: number, failure: string) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "mcp.call_failed",
    targetType: "mcp_tool",
    targetId: REF,
    payload: {
      actor: "dev-local-user",
      bot: BOT,
      server: "composio-gmail",
      tool: "GMAIL_FETCH_EMAILS",
      effect: "read",
      reachedAs: "dev-local-user",
      decision: {
        allowed: true,
        mode: "enforce",
        rule: null,
        source: "default",
        carriedOut: true,
      },
      failure,
    },
    createdAt: `2026-11-08T18:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** The refusal the server writes today, built by the same function the server builds it with. */
const NOT_CONNECTED = failedCall(
  "now",
  3,
  connectAppRefusal({
    serverId: "composio-gmail",
    title: "Gmail",
    message:
      "You have not connected your Gmail account. Connect it and ask again.",
  }),
);
/** The row as it was stored on the Windows install, character for character. */
const STORED_BEFORE = failedCall(
  "before",
  2,
  '[connect-app]{"serverId":"composio-gmail","title":"Gmail"} You have not connected your Gmail account. Connect it and ask again.',
);
/** An account the vendor stopped honouring, which the server words as a reconnect. */
const WITHDRAWN = failedCall(
  "withdrawn",
  1,
  connectAppRefusal({
    serverId: "composio-gmail",
    title: "Gmail",
    message:
      "Your Gmail access was withdrawn at the vendor, so this was not done. Reconnect it and ask again.",
    reason: "reconnect",
    at: "2026-11-08T18:01:00.000Z",
  }),
);

test("the audit trail names an unconnected or withdrawn Gmail account in this edition", async ({
  app,
  browser,
  screen,
}) => {
  const events = personal
    ? [NOT_CONNECTED, STORED_BEFORE, WITHDRAWN]
    : [STORED_BEFORE];
  await browser.route(eventsEndpoint, (route) =>
    route.fulfill({ json: { events } }),
  );
  await app.open(personal ? "/settings/activity" : "/admin/audit");
  await expect(
    screen.getByRole("heading", personal ? "Activity" : "Audit", {
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  const table = browser.locator("tbody");
  const rows = browser.locator("tbody tr");
  await expect(rows).toHaveCount(events.length);
  if (personal) {
    await expect(table.getByText("Not connected", { exact: true })).toHaveCount(
      2,
    );
    await expect(
      table.getByText("Gmail isn't connected. Connect it in Connections.", {
        exact: true,
      }),
    ).toHaveCount(2);
    await expect(
      table.getByText("No longer connected", { exact: true }),
    ).toBeVisible();
    await expect(
      table.getByText(
        "Gmail is no longer connected. Reconnect it in Connections.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(table.getByText("Fetch emails", { exact: true })).toHaveCount(
      3,
    );
    await expect(table.getByText("Gmail", { exact: true })).toHaveCount(3);
    await expect(table).not.toContainText(/didn't answer|serverId|composio/i);
    await expect(table).not.toContainText(/\[connect-app\]|\{/);
  } else {
    const decision = browser.locator('tbody [data-column="decision"]');
    await expect(
      decision.getByText("Not connected", { exact: true }),
    ).toBeVisible();
    await expect(
      decision.getByText(
        "You have not connected your Gmail account. Connect it and ask again.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      decision.getByRole("button", "Why?", { exact: true }),
    ).toBeVisible();
    await expect(decision).not.toContainText(/\[connect-app\]|\{|composio/i);
  }
});

if (personal) {
  test("personal Settings opens a page named Activity using the same menu label", async ({
    app,
    browser,
  }) => {
    await browser.route(eventsEndpoint, (route) =>
      route.fulfill({ json: { events: [] } }),
    );
    await app.open("/settings");
    const entry = browser.locator('a[href="/settings/activity"]');
    await expect(entry).toHaveText("Activity");
    await entry.tap();
    await expect(browser).toHaveURL("/settings/activity");
    const header = browser.locator('[data-slot="page-header"]');
    await expect(
      header.getByRole("heading", "Activity", { exact: true, level: 1 }),
    ).toBeVisible();
    await expect(header).toContainText("See what your Bots did");
    await expect(header).not.toContainText("deployment");
  });
}
