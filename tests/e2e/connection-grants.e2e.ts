import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { gmailServer } from "./fixtures/app-details";

const page = "/connections/gmail";
const consent = "/fixture-action-consent";
const send = "Gmail.SendEmail";
const list = "Gmail.ListEmails";
const verifierRefusal =
  "Couldn't start connecting Gmail. Arcade would send you back somewhere else after you sign in. Ask an admin to set the custom verifier in Arcade's dashboard to https://openbotproductiondeployment.examplecompany.com/api/plugins/arcade/verify";
type Action =
  | {
      action: string;
      state: "authorized";
      scopes: string[];
      authorization: "held" | "not-required";
    }
  | { action: string; state: "needs-consent"; scopes: string[] }
  | { action: string; state: "needs-operator"; missing: string[] }
  | { action: string; state: "unknown"; reason: string };

const held = (action: string, scopes: string[] = []): Action => ({
  action,
  state: "authorized",
  scopes,
  authorization: "held",
});
const needsConsent = (action: string, scopes: string[] = []): Action => ({
  action,
  state: "needs-consent",
  scopes,
});
const needsOperator = (action: string): Action => ({
  action,
  state: "needs-operator",
  missing: ["GOOGLE_CLIENT_SECRET"],
});
const unknown = (action: string): Action => ({
  action,
  state: "unknown",
  reason: "Try again in a moment.",
});
const gmail = [
  held(list, ["gmail.readonly"]),
  held("Gmail.ListThreads", ["gmail.readonly"]),
  needsConsent(send, ["gmail.send"]),
  needsOperator("Gmail.Setup"),
  unknown("Gmail.Flaky"),
];

async function serveGrants(
  browser: Browser,
  options: {
    provider?: "composio" | "arcade";
    perAction?: boolean;
    role?: "admin" | "user";
    shared?: boolean;
    connected?: boolean;
    configured?: boolean;
    actions?: () => Action[];
    waitForGrants?: Promise<void>;
    refuseConnect?: boolean;
  } = {},
) {
  const provider = options.provider ?? "arcade";
  const connected = options.connected ?? !options.shared;
  const requests: { method: string; path: string; body: unknown }[] = [];
  await browser.route(/\/api\/me$/, async (route) => {
    const data = await (await route.fetch()).json<{ user: { role: string } }>();
    return route.fulfill({
      json: { ...data, user: { ...data.user, role: options.role ?? "admin" } },
    });
  });
  await browser.route(/\/api\/plugins$/, (route) =>
    route.fulfill({
      json: {
        catalogue: [],
        servers: [
          {
            ...gmailServer,
            id: "gmail",
            url: `${provider}://gmail`,
            tools: [],
            provenance: provider,
            accountMode: options.shared ? "shared" : "personal",
          },
        ],
        skills: [],
        botsMayCallBack: true,
        redirectUri: null,
        composioConfigured: options.configured ?? true,
        authorizesPerAction: options.perAction ?? provider === "arcade",
        provider,
      },
    }),
  );
  await browser.route(/\/api\/plugins\/connections$/, (route) =>
    route.fulfill({
      json: {
        connections: connected
          ? [
              {
                serverId: "gmail",
                scope: "",
                connectedAt: "2026-09-10T00:00:00.000Z",
                holder: "person",
                verified: true,
                verifiedAt: null,
                checkable: false,
              },
            ]
          : [],
      },
    }),
  );
  await browser.route(
    /\/api\/plugins\/servers\/gmail\/(?:grants|authorize|connect|connection\/(?:confirm|siblings))(?:\?|$)/,
    async (route) => {
      const url = new URL(route.request.url);
      const method = route.request.method;
      requests.push({
        method,
        path: url.pathname + url.search,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      if (url.pathname.endsWith("/grants")) {
        await options.waitForGrants;
        return route.fulfill({
          json: { actions: options.actions?.() ?? gmail },
        });
      }
      if (url.pathname.endsWith("/authorize"))
        return route.fulfill({
          json: { authorizationUrl: new URL(consent, url).href },
        });
      if (url.pathname.endsWith("/connect"))
        return options.refuseConnect
          ? route.fulfill({ status: 503, json: { error: verifierRefusal } })
          : route.fulfill({
              json: { authorizationUrl: new URL(consent, url).href },
            });
      if (url.pathname.endsWith("/confirm"))
        return route.fulfill({ json: { connected } });
      return route.fulfill({
        json: { siblings: ["googledocs"], unanswered: 0 },
      });
    },
  );
  await browser.route(/\/fixture-action-consent$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><h1>Provider consent</h1>",
    }),
  );
  return requests;
}

const actionRow = (browser: Browser, action: string) =>
  browser.locator(`[data-action="${action}"]`);
const visibleActions = (browser: Browser) =>
  browser.evaluate(() =>
    Array.from(document.querySelectorAll("[data-action]"), (row) =>
      row.getAttribute("data-action"),
    ),
  );

test("per-action grants group by permission and offer the action appropriate to each state", async ({
  app,
  browser,
  screen,
}) => {
  let retrySucceeded = false;
  const calls = await serveGrants(browser, {
    actions: () =>
      retrySucceeded
        ? gmail.map((action) =>
            action.action === "Gmail.Flaky" ? held(action.action) : action,
          )
        : gmail,
  });
  await app.open(page);
  await expect(
    screen.getByLabel("Search actions", { exact: true }),
  ).toHaveValue("");
  await expect(
    actionRow(browser, send).getByRole("button", "Authorize", { exact: true }),
  ).toBeVisible();
  await expect(actionRow(browser, list).getByRole("button")).toHaveCount(0);
  const operator = actionRow(browser, "Gmail.Setup");
  await expect(operator).toContainText("GOOGLE_CLIENT_SECRET");
  await expect(operator).toContainText("An admin has to set it");
  await expect(operator.getByRole("button")).toHaveCount(0);
  const flaky = actionRow(browser, "Gmail.Flaky");
  await expect(
    flaky.getByRole("button", "Authorize", { exact: true }),
  ).toHaveCount(0);
  const readonly = browser.locator('[data-grant-group="gmail.readonly"]');
  await expect(readonly.getByText(list, { exact: true })).toBeVisible();
  await expect(
    readonly.getByText("Gmail.ListThreads", { exact: true }),
  ).toBeVisible();
  await expect(readonly.getByText(send, { exact: true })).toHaveCount(0);
  await expect(
    browser
      .locator('[data-grant-group="gmail.send"]')
      .getByText(send, { exact: true }),
  ).toBeVisible();
  const readsBeforeRetry = calls.filter(({ path }) =>
    path.endsWith("/grants"),
  ).length;
  retrySucceeded = true;
  await flaky.getByRole("button", "Retry", { exact: true }).click();
  await expect(flaky).toHaveAttribute("data-state", "authorized");
  expect(
    calls.filter(({ path }) => path.endsWith("/grants")).length,
  ).toBeGreaterThan(readsBeforeRetry);
  expect(calls.filter(({ path }) => path.includes("/authorize"))).toEqual([]);
});

test("a toolkit-wide failure is a status, with Retry recovering the action list", async ({
  app,
  browser,
  screen,
}) => {
  let failed = true;
  await serveGrants(browser, {
    actions: () => (failed ? [unknown("Gmail")] : gmail),
  });
  await app.open(page);
  const status = screen
    .getByRole("status")
    .filter({ hasText: "Couldn't read what this account allows right now." });
  await expect(status).toBeVisible();
  await expect(browser.locator("[data-action]")).toHaveCount(0);
  failed = false;
  await status.getByRole("button", "Retry", { exact: true }).click();
  await expect(status).toHaveCount(0);
  await expect(actionRow(browser, send)).toBeVisible();
});

test("an all-or-nothing app groups every action and lists authorized entries first", async ({
  app,
  browser,
  screen,
}) => {
  await serveGrants(browser, {
    actions: () => [
      needsConsent("Github.B"),
      held("Github.C"),
      held("Github.A"),
      unknown("Github.D"),
    ],
  });
  await app.open(page);
  const whole = browser.locator('[data-grant-group="whole-app"]');
  await expect(whole.getByText("Github.B", { exact: true })).toBeVisible();
  const members = await browser.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-grant-group="whole-app"] [data-action]'),
      (row) => row.getAttribute("data-action"),
    ),
  );
  await expect(browser.locator("[data-grant-group]")).toHaveCount(1);
  expect(members).toEqual(["Github.A", "Github.C", "Github.B", "Github.D"]);
  expect(await visibleActions(browser)).toEqual([
    "Github.A",
    "Github.C",
    "Github.B",
    "Github.D",
  ]);
  await expect(screen.getByText(/more actions not yet authorized/)).toHaveCount(
    0,
  );
});

for (const mixed of [false, true]) {
  test(`the first ten unauthorized actions apply the ${mixed ? "state order" : "default limit and search"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const actions = mixed
      ? [
          ...Array.from({ length: 4 }, (_, i) => unknown(`Gmail.A${i}`)),
          ...Array.from({ length: 3 }, (_, i) => needsOperator(`Gmail.B${i}`)),
          ...Array.from({ length: 6 }, (_, i) =>
            needsConsent(`Gmail.C${i}`, ["gmail.send"]),
          ),
        ]
      : [
          held(list, ["gmail.readonly"]),
          ...Array.from({ length: 12 }, (_, i) =>
            needsConsent(`Gmail.Send${String.fromCharCode(97 + i)}`, [
              "gmail.send",
            ]),
          ),
        ];
    await serveGrants(browser, { actions: () => actions });
    await app.open(page);
    await expect(
      screen.getByText(
        new RegExp(`${mixed ? 3 : 2} more actions not yet authorized`),
      ),
    ).toBeVisible();
    if (mixed) {
      expect((await visibleActions(browser)).sort()).toEqual([
        "Gmail.A0",
        "Gmail.B0",
        "Gmail.B1",
        "Gmail.B2",
        "Gmail.C0",
        "Gmail.C1",
        "Gmail.C2",
        "Gmail.C3",
        "Gmail.C4",
        "Gmail.C5",
      ]);
    } else {
      await expect(actionRow(browser, list)).toBeVisible();
      await expect(actionRow(browser, "Gmail.Senda")).toBeVisible();
      await expect(actionRow(browser, "Gmail.Sendj")).toBeVisible();
      await expect(actionRow(browser, "Gmail.Sendk")).toHaveCount(0);
      await expect(actionRow(browser, "Gmail.Sendl")).toHaveCount(0);
      await screen.getByLabel("Search actions", { exact: true }).fill("sendk");
      await expect(actionRow(browser, "Gmail.Sendk")).toBeVisible();
      expect(await visibleActions(browser)).toEqual(["Gmail.Sendk"]);
    }
  });
}

for (const shared of [false, true]) {
  test(`a late grant list keeps the consent landing highlight on the ${shared ? "shared" : "personal"} account page`, async ({
    app,
    browser,
    screen,
  }) => {
    const grants = Promise.withResolvers<void>();
    const calls = await serveGrants(browser, {
      shared,
      waitForGrants: grants.promise,
    });
    const notice = screen
      .getByRole("status")
      .filter({ hasText: `You just authorized ${list}.` });
    try {
      await app.open(`${page}?action=${list}`);
      await expect(browser).toHaveURL(page);
      await expect(notice).toHaveAttribute("data-landed-action", list);
      await expect(actionRow(browser, list)).toHaveCount(0);
      if (shared)
        await expect(
          screen.getByText("Team account", { exact: true }),
        ).toBeVisible();
    } finally {
      grants.resolve();
    }
    await expect(actionRow(browser, list)).toHaveAttribute("data-landed", "");
    await expect(browser.locator("[data-landed]")).toHaveCount(1);
    await expect(actionRow(browser, send)).toBeVisible();
    await browser.reload();
    await expect(actionRow(browser, list)).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(browser.locator("[data-landed]")).toHaveCount(0);
    if (shared)
      expect(calls.filter(({ path }) => path.endsWith("/confirm"))).toEqual([]);
  });
}

test("shared grant status is visible to members and only an admin can mint consent", async ({
  app,
  browser,
  screen,
}) => {
  await serveGrants(browser, { shared: true, role: "user" });
  await app.open(page);
  await expect(actionRow(browser, list)).toContainText("Authorized");
  await expect(actionRow(browser, send)).toContainText(
    "An admin can authorize it.",
  );
  await expect(
    screen.getByRole("button", "Authorize", { exact: true }),
  ).toHaveCount(0);
  await serveGrants(browser, { shared: true, role: "admin" });
  await browser.reload();
  await expect(
    actionRow(browser, send).getByRole("button", "Authorize", { exact: true }),
  ).toBeVisible();
});

for (const kind of ["scope", "whole app", "shared permission"] as const) {
  test(`consent explains ${kind} before sending an authorization request`, async ({
    app,
    browser,
    screen,
  }) => {
    const a = "Tk.A";
    const other = "Github.CreateIssue";
    const first =
      kind === "scope"
        ? send
        : kind === "whole app"
          ? a
          : "Github.CountStargazers";
    const actions =
      kind === "scope"
        ? gmail
        : kind === "whole app"
          ? [
              needsConsent(a),
              needsConsent("Tk.B"),
              held("Tk.C"),
              ...["Tk.X", "Tk.Y", "Tk.Z"].map(
                (action): Action => ({
                  action,
                  state: "authorized",
                  scopes: [],
                  authorization: "not-required",
                }),
              ),
            ]
          : [needsConsent(first, ["repo"]), needsConsent(other, ["repo"])];
    const calls = await serveGrants(browser, { actions: () => actions });
    await app.open(page);
    await actionRow(browser, first)
      .getByRole("button", "Authorize", { exact: true })
      .click();
    const panel = screen.getByRole("group", `Before you authorize ${first}`);
    const text =
      kind === "scope"
        ? "Approving Gmail.SendEmail asks the provider for the permission gmail.send."
        : kind === "whole app"
          ? "approving this approves all 3."
          : `It also enables this other action requiring it: ${other}.`;
    await expect(panel).toContainText(text);
    await expect(panel).not.toContainText(
      /only (this|that|the named)|just this/i,
    );
    if (kind === "whole app") {
      await expect(actionRow(browser, "Tk.X")).toContainText(
        "Needs no authorization.",
      );
      await expect(
        browser.locator('[data-grant-group="whole-app"] [data-action]'),
      ).toHaveCount(3);
    }
    expect(
      await browser.evaluate(
        () => document.querySelector("main")?.innerHTML ?? "",
      ),
    ).not.toMatch(/composio/i);
    expect(calls.filter(({ path }) => path.includes("/authorize"))).toEqual([]);
    await panel
      .getByRole("button", "Continue to consent", { exact: true })
      .click();
    await expect(browser).toHaveURL(consent);
    await expect(
      screen.getByRole("heading", "Provider consent", { exact: true }),
    ).toBeVisible();
    expect(calls.filter(({ path }) => path.includes("/authorize"))).toEqual([
      {
        method: "POST",
        path: "/api/plugins/servers/gmail/authorize?returnTo=settings",
        body: { action: first },
      },
    ]);
  });
}

for (const [provider, perAction] of [
  ["composio", false],
  ["arcade", false],
  ["composio", true],
] as const) {
  test(`the grants request follows the declared capability with ${provider} and perAction=${perAction}`, async ({
    app,
    browser,
    screen,
  }) => {
    const calls = await serveGrants(browser, { provider, perAction });
    await app.open(page);
    await expect(
      screen.getByRole("button", "Disconnect", { exact: true }),
    ).toBeVisible();
    const search = screen.getByLabel("Search actions", { exact: true });
    if (perAction) {
      await expect(search).toBeVisible();
      await expect(actionRow(browser, send)).toBeVisible();
    } else {
      await expect(search).toHaveCount(0);
      await expect(browser.locator("[data-action]")).toHaveCount(0);
      expect(calls.filter(({ path }) => path.endsWith("/grants"))).toEqual([]);
    }
  });
}

test("a refused connection shows its full verifier address without horizontal clipping", async ({
  app,
  browser,
  screen,
}) => {
  await serveGrants(browser, { connected: false, refuseConnect: true });
  await browser.setViewport({ width: 420, height: 840 });
  await app.open(page);
  await screen.getByRole("button", "Connect", { exact: true }).click();
  const alert = screen
    .getByRole("alert")
    .filter({ hasText: "Couldn't start connecting Gmail" });
  await expect(alert).toHaveText(verifierRefusal);
  await expect(browser).toHaveURL(page);
  const geometry = await browser.evaluate((text) => {
    const node = Array.from(
      document.querySelectorAll<HTMLElement>("[role=alert]"),
    ).find((element) => element.textContent === text);
    if (!node) throw new Error("Missing the connection warning");
    const box = node.getBoundingClientRect();
    return {
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
      right: box.right,
      viewport: innerWidth,
    };
  }, verifierRefusal);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
});

test("Connections opens a shared account without offering or issuing a personal confirmation", async ({
  app,
  browser,
  screen,
}) => {
  const calls = await serveGrants(browser, {
    shared: true,
    provider: "composio",
  });
  await app.open("/connections");
  const tile = screen.getByTestId("account-gmail");
  await expect(tile).toContainText(
    "Your organisation's account. Bots act as the team here.",
  );
  await expect(tile).not.toContainText("Not connected");
  await tile.click();
  await expect(browser).toHaveURL(page);
  await expect(screen.getByText("Team account", { exact: true })).toBeVisible();
  await expect(
    screen.getByRole("button", "Connect", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Disconnect", { exact: true }),
  ).toHaveCount(0);
  expect(calls.filter(({ path }) => path.endsWith("/confirm"))).toEqual([]);
});

test("a Composio App without deployment configuration is hidden from the list and gives an actionable account page", async ({
  app,
  browser,
  screen,
}) => {
  await serveGrants(browser, {
    provider: "composio",
    configured: false,
    connected: false,
  });
  await app.open("/connections");
  await expect(
    screen.getByRole("heading", "Connections", { exact: true }),
  ).toBeVisible();
  const tile = screen.getByTestId("account-gmail");
  await expect(tile).toHaveCount(0);
  await app.open(page);
  await expect(screen.getByText(/An admin has to turn on Gmail/)).toBeVisible();
  await expect(
    screen.getByText("Not set up yet", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(/COMPOSIO_API_KEY/)).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Connect", { exact: true }),
  ).toHaveCount(0);

  await serveGrants(browser, {
    provider: "composio",
    configured: true,
    connected: false,
  });
  await browser.reload();
  await expect(
    screen.getByRole("button", "Connect", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("Not set up yet", { exact: true })).toHaveCount(
    0,
  );
  await app.open("/connections");
  await expect(tile).toBeVisible();
});
