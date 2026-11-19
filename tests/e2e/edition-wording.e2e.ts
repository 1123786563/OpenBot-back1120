import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const notion = {
  id: "notion",
  title: "Notion",
  vendor: "Notion",
  url: "https://mcp.notion.com/mcp",
  summary: "Pages and databases.",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "me",
  dynamicClient: true,
  authScheme: null,
  tools: [],
  withdrawn: [],
  accountMode: null,
  sharedVendorConnected: false,
  ownerGrants: "any",
  ownerGrantsChosen: null,
};

const page = {
  catalogue: [
    {
      key: "notion",
      title: "Notion",
      vendor: "Notion",
      summary: "Pages and databases.",
      docsUrl: "",
      auth: "user-oauth",
      perInstance: false,
    },
  ],
  servers: [notion],
  skills: [],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
  authorizesPerAction: false,
};

const startedByOpenBot = {
  id: "e1",
  actorUserId: null,
  initiatorKind: "deployment",
  initiatorId: null,
  // Every Bot given Routines' tools at a start; Activity leaves the computer's start-up rows out.
  eventType: "configuration.changed",
  targetType: "mcp_server",
  targetId: "routines",
  payload: {
    change: "plugin_granted",
    kind: "mcp",
    refs: ["routines/create_goal", "routines/list_goals"],
    actor: "openbot:always-on",
  },
  createdAt: "2026-11-07T11:00:00Z",
};

const personal = process.env.OPENBOT_E2E_SUITE === "personal";

test(`the ${personal ? "personal Activity" : "team Audit"} page names the actor for an OpenBot event`, async ({
  app,
  browser,
  screen,
}) => {
  await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) =>
    route.fulfill({ json: { events: [startedByOpenBot] } }),
  );
  await app.open(personal ? "/settings/activity" : "/admin/audit");
  await expect(
    screen.getByText(
      personal ? "Started by OpenBot" : "Started by this deployment",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  if (personal)
    await expect(screen.getByText(/Started by this deployment/i)).toHaveCount(
      0,
    );
});

test(`the Notion connection page explains OAuth registration in ${personal ? "personal Settings" : "team Admin"}`, async ({
  app,
  browser,
  screen,
}) => {
  await browser.route(/\/api\/plugins$/, (route) =>
    route.fulfill({ json: page }),
  );
  await browser.route(/\/api\/plugins\/connections$/, (route) =>
    route.fulfill({ json: { connections: [] } }),
  );
  await app.open(
    personal ? "/connections/notion/tools/search" : "/admin/plugins/notion",
  );
  if (personal) await expect(browser).toHaveURL("/connections/notion");
  await expect(
    screen.getByRole("heading", "Notion", { exact: true }),
  ).toBeVisible();
  for (const text of personal
    ? [
        /OpenBot registers an OAuth client/,
        /OpenBot registers itself with the vendor/,
        /OpenBot has no public URL/,
      ]
    : [
        /The deployment registers an OAuth client/,
        /This deployment registers itself with the vendor/,
      ]) {
    await expect(screen.getByText(text)).toBeVisible();
  }
  if (personal) {
    await expect(
      screen.getByText(/deployment (?:registers|has no public URL)/i),
    ).toHaveCount(0);
  }
});

const personalLinks = [
  ["Saved logins", "/settings/passwords"],
  ["Keys", "/settings/credentials"],
  ["Skills", "/settings/skills"],
  ["Computer", "/settings/computer"],
  ["Activity", "/settings/activity"],
] as const;

test(`Settings shows the ${personal ? "personal" : "team"} edition links and opens Learning`, async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/settings");
  const navigation = browser.locator('[data-slot="sidebar-content"]');
  const learning = navigation.getByRole("link", "Learning", { exact: true });
  await expect(learning).toHaveAttribute("href", "/settings/learning");
  await expect(
    navigation.getByRole("link", "Apps", { exact: true }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("link", "Credentials", { exact: true }),
  ).toHaveCount(0);
  await expect(browser.locator('a[href="/settings/plugins"]')).toHaveCount(0);
  for (const [title, path] of personalLinks) {
    const link = navigation.getByRole("link", title, { exact: true });
    if (personal) await expect(link).toHaveAttribute("href", path);
    else await expect(link).toHaveCount(0);
  }
  const passwords = navigation.getByRole("link", "Passwords", { exact: true });
  if (personal) await expect(passwords).toHaveCount(0);
  else await expect(passwords).toHaveAttribute("href", "/settings/passwords");

  await learning.click();
  await expect(browser).toHaveURL("/settings/learning");
  await expect(
    screen.getByRole("heading", "Learning", { exact: true }),
  ).toBeVisible();

  if (personal) {
    await navigation.getByRole("link", "Skills", { exact: true }).click();
    await expect(browser).toHaveURL("/settings/skills");
    await expect(
      screen.getByRole("heading", "Skills", { exact: true }),
    ).toBeVisible();
    await expect(browser.locator("main")).not.toContainText("every Bot");
  } else {
    await app.open("/settings/computer");
    await expect(browser).toHaveURL("/settings");
    await expect(
      screen.getByRole("heading", "About you", { exact: true }),
    ).toBeVisible();
  }
});

if (personal) {
  test("a personal-only Settings bookmark returns to General when the edition cannot be read", async ({
    app,
    browser,
    screen,
  }) => {
    let refused = 0;
    await browser.route(/\/api\/capabilities$/, (route) => {
      refused++;
      return route.fulfill({ status: 503, body: "" });
    });
    await app.open("/settings/computer");
    await expect(browser).toHaveURL("/settings");
    await expect(
      screen.getByRole("heading", "About you", { exact: true }),
    ).toBeVisible();
    expect(refused).toBeGreaterThan(0);
  });
}
