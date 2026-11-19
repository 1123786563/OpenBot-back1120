import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { gmailServer, notionServer } from "./fixtures/app-details";

const api = "/api/plugins/access-requests";
const apps = "/admin/plugins";
const gmail = gmailServer.id;
const appPath = `${apps}/${gmail}`;
const grant = "give-gmail";
const enable = "enable-gmail";
const connect = "connect-gmail";
const slack = "enable-slack";
type Kind = "grant" | "enable" | "connect_shared";

function request(
  id: string,
  kind: Kind,
  {
    appKey = gmail,
    appTitle = "Gmail",
    requesterName = "Ada",
  }: {
    appKey?: string;
    appTitle?: string;
    requesterName?: string | null;
  } = {},
) {
  return {
    id,
    appKey,
    appTitle,
    kind,
    status: "pending",
    agentId: "expenses",
    botName: "Expenses",
    requestedBy: "u_ada",
    requesterEmail: "ada@example.test",
    requesterName,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  };
}

async function serveInbox(
  browser: Browser,
  {
    initial,
    approvalFailures = {},
  }: {
    initial: ReturnType<typeof request>[];
    approvalFailures?: Record<string, string>;
  },
) {
  let open = initial.slice();
  const reads: string[] = [];
  const writes: { method: string; path: string; body: string | null }[] = [];
  const failed = new Set<string>();
  await browser.route(/\/api\/plugins$/, (route) =>
    route.fulfill({
      json: {
        catalogue: [],
        servers: [{ ...gmailServer, tools: [] }, notionServer],
        skills: [],
        provider: "composio",
        composioConfigured: true,
      },
    }),
  );
  await browser.route(/\/api\/plugins\/connections$/, (route) =>
    route.fulfill({ json: { connections: [] } }),
  );
  await browser.route(
    /\/api\/plugins\/servers\/composio-gmail\/connection\/(?:confirm|siblings)$/,
    (route) =>
      route.fulfill({
        json: { connected: false, siblings: [], unanswered: 0 },
      }),
  );
  await browser.route(/\/api\/plugins\/access-requests(?:\?|$)/, (route) => {
    const { pathname, search, searchParams } = new URL(route.request.url);
    reads.push(pathname + search);
    const app = searchParams.get("app");
    const byApp: Record<string, number> = {};
    for (const request of open)
      byApp[request.appKey] = (byApp[request.appKey] ?? 0) + 1;
    return route.fulfill({
      json: {
        requests: app ? open.filter((request) => request.appKey === app) : open,
        counts: { total: open.length, byApp },
      },
    });
  });
  await browser.route(
    /\/api\/plugins\/access-requests\/[^/]+\/(?:approve|dismiss)$/,
    (route) => {
      const { pathname } = new URL(route.request.url);
      const match = pathname.match(/\/([^/]+)\/(approve|dismiss)$/);
      const id = match?.[1] ?? "";
      const action = match?.[2];
      const current = open.find((request) => request.id === id);
      writes.push({
        method: route.request.method,
        path: pathname,
        body: route.request.postData ?? null,
      });
      if (!current)
        return route.fulfill({
          status: 404,
          json: { error: "Request not found." },
        });
      const failure = approvalFailures[id];
      if (action === "approve" && failure && !failed.has(id)) {
        failed.add(id);
        return route.fulfill({ status: 409, json: { error: failure } });
      }
      open = open.filter((request) => request.id !== id);
      return route.fulfill({
        json: {
          request: {
            ...current,
            status: action === "approve" ? "approved" : "dismissed",
          },
        },
      });
    },
  );
  return { reads, writes };
}

const row = (browser: Browser, id: string) =>
  browser.locator(`[data-request="${id}"]`);
const grantNote =
  "Approving gives Expenses only Gmail's read-only actions. Choose any others on the Bot's page under Gmail.";

test("the Gmail inbox describes the requester, Bot and access requested", async ({
  app,
  browser,
  screen,
}) => {
  const { reads, writes } = await serveInbox(browser, {
    initial: [
      request(grant, "grant"),
      request(enable, "enable"),
      request(connect, "connect_shared", { requesterName: null }),
      request(slack, "enable", { appKey: "composio-slack", appTitle: "Slack" }),
    ],
  });
  await app.open(appPath);
  await expect(
    screen.getByRole("heading", "Requests", { exact: true }),
  ).toBeVisible();
  await expect(row(browser, grant)).toContainText("Give Gmail to Expenses");
  await expect(row(browser, enable)).toContainText(
    "Turn on Gmail for Expenses",
  );
  await expect(row(browser, connect)).toContainText(
    "Connect the shared Gmail account",
  );
  await expect(row(browser, grant)).toContainText(/Ada asked [56] minutes ago/);
  await expect(row(browser, enable)).toContainText(
    /Ada asked [56] minutes ago/,
  );
  await expect(row(browser, connect)).toContainText(
    /ada@example\.test asked.*for Expenses/,
  );
  await expect(
    browser.locator("[data-request]").filter({ hasText: /\bconnected\b/i }),
  ).toHaveCount(0);
  await expect(row(browser, slack)).toHaveCount(0);
  for (const id of [grant, enable])
    await expect(row(browser, id)).toContainText(grantNote);
  await expect(
    row(browser, grant).getByRole("link", "the Bot's page under Gmail", {
      exact: true,
    }),
  ).toHaveAttribute("href", `${appPath}/bots/expenses`);
  await expect(row(browser, enable).getByRole("link")).toHaveCount(0);
  await expect(row(browser, connect)).not.toContainText("read-only");
  expect(reads).toContain(`${api}?app=${gmail}`);
  expect(writes).toEqual([]);
});

test("the App list shows requests first and updates counts after approval and dismissal", async ({
  app,
  browser,
  screen,
}) => {
  const { reads, writes } = await serveInbox(browser, {
    initial: [
      request(grant, "grant"),
      request(enable, "enable"),
      request(slack, "enable", { appKey: "composio-slack", appTitle: "Slack" }),
    ],
  });
  await app.open(apps);
  await expect(
    screen.getByRole("heading", "Requests", { exact: true }),
  ).toBeVisible();
  await expect(row(browser, slack)).toContainText("Turn on Slack for Expenses");
  const gmailRow = screen.getByTestId(`plugin-${gmail}`);
  await expect(gmailRow.getByText("2 requests", { exact: true })).toBeVisible();
  await expect(
    screen.getByTestId("plugin-notion").getByText(/requests?/),
  ).toHaveCount(0);
  const requestsFirst = await browser.evaluate(() => {
    const request = document.querySelector("[data-request]");
    const app = document.querySelector('[data-testid="plugin-composio-gmail"]');
    return Boolean(
      request &&
        app &&
        request.compareDocumentPosition(app) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(requestsFirst).toBe(true);
  await row(browser, grant)
    .getByRole("button", "Approve", { exact: true })
    .click();
  await expect(row(browser, grant)).toHaveCount(0);
  await expect(gmailRow.getByText("1 request", { exact: true })).toBeVisible();
  await row(browser, enable)
    .getByRole("button", "Dismiss", { exact: true })
    .click();
  await expect(row(browser, enable)).toHaveCount(0);
  await expect(gmailRow.getByText(/requests?/)).toHaveCount(0);
  await browser.reload();
  await expect(row(browser, slack)).toBeVisible();
  await expect(row(browser, grant)).toHaveCount(0);
  await expect(row(browser, enable)).toHaveCount(0);
  await expect(gmailRow.getByText(/requests?/)).toHaveCount(0);
  expect(reads).toContain(api);
  expect(writes).toEqual([
    { method: "POST", path: `${api}/${grant}/approve`, body: null },
    { method: "POST", path: `${api}/${enable}/dismiss`, body: null },
  ]);
});

for (const scenario of [
  {
    id: connect,
    kind: "connect_shared",
    error:
      "The shared Gmail account is not connected yet. Connect it on Gmail's page under Plugins, then approve this request.",
  },
  {
    id: grant,
    kind: "grant",
    error:
      "Gmail has no read-only actions to grant. Choose which actions Expenses may use on its page under Gmail.",
  },
] as const) {
  test(`an approval refusal for ${scenario.kind} stays on the right request and can be retried`, async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveInbox(browser, {
      initial: [request(scenario.id, scenario.kind), request(enable, "enable")],
      approvalFailures: { [scenario.id]: scenario.error },
    });
    await app.open(appPath);
    const current = row(browser, scenario.id);
    const other = row(browser, enable);
    const approve = current.getByRole("button", "Approve", { exact: true });
    await approve.click();
    const error = current.getByRole("alert");
    await error.getByRole("button", "Details", { exact: true }).click();
    await expect(error).toContainText(scenario.error);
    await expect(approve).toBeEnabled();
    await expect(other.getByRole("alert")).toHaveCount(0);
    await approve.click();
    await expect(current).toHaveCount(0);
    await expect(other).toBeVisible();
    await expect(
      screen.getByRole("heading", "Requests", { exact: true }),
    ).toBeVisible();
    const expected = {
      method: "POST",
      path: `${api}/${scenario.id}/approve`,
      body: null,
    };
    expect(writes).toEqual([expected, expected]);
  });
}

test("an App with no pending access requests omits the inbox section", async ({
  app,
  browser,
  screen,
}) => {
  const { reads, writes } = await serveInbox(browser, { initial: [] });
  await app.open(appPath);
  await expect(
    screen.getByRole("heading", "Gmail", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => reads.includes(`${api}?app=${gmail}`)).toBe(true);
  await expect(
    screen.getByRole("heading", "Requests", { exact: true }),
  ).toHaveCount(0);
  await expect(browser.locator("[data-request]")).toHaveCount(0);
  expect(writes).toEqual([]);
});
