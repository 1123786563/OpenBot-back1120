import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

test("GitHub repository events show the webhook address and save a new repository with its secret", async ({
  app,
  browser,
  screen,
}) => {
  const initial = {
    id: "g1",
    source: "github",
    repository: "acme/app",
    createdAt: "2026-10-09T10:00:00Z",
  };
  const bindings = [initial];
  const repository = "acme/web";
  const secret = "fixture-webhook-secret";
  const writes: { method: string; path: string; body: unknown }[] = [];
  await browser.route(/\/api\/responsibilities\/sources\/github$/, (route) => {
    const method = route.request.method;
    if (method === "GET") return route.fulfill({ json: { bindings } });
    const body = JSON.parse(route.request.postData ?? "null");
    writes.push({ method, path: new URL(route.request.url).pathname, body });
    const binding = { ...initial, id: "g2", repository: body.repository };
    bindings.push(binding);
    return route.fulfill({ status: 201, json: { binding } });
  });
  await app.open("/connections/github");
  await expect(screen.getByText("acme/app", { exact: true })).toBeVisible();
  const origin = new URL(await browser.url()).origin;
  await expect(
    screen.getByText(`${origin}/api/events/github/g1`, { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", "Add a repository", { exact: true }).click();
  const dialog = screen.getByRole("dialog", "Add a repository");
  await dialog
    .getByRole("textbox", "Repository", { exact: true })
    .fill(repository);
  await dialog.getByLabel("Webhook secret", { exact: true }).fill(secret);
  await dialog.getByRole("button", "Connect events", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/api/responsibilities/sources/github",
      body: { repository, secret },
    },
  ]);
  await expect(screen.getByText(repository, { exact: true })).toBeVisible();
  await expect(
    screen.getByText(`${origin}/api/events/github/g2`, { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(secret, { exact: true })).toHaveCount(0);
  await browser.reload();
  await expect(screen.getByText(repository, { exact: true })).toBeVisible();
});

function entry(
  key: string,
  title: string,
  auth: "none" | "deployment-bearer" | "user-oauth" | "builtin",
  oneStep: boolean,
) {
  return {
    key,
    title,
    vendor: title,
    summary: `${title} for your Bots.`,
    docsUrl: "",
    auth,
    perInstance: false,
    oneStep,
  };
}

/** Notion registers its own OAuth client; Google Drive needs one typed in. */
const CATALOGUE = [
  entry("notion", "Notion", "user-oauth", true),
  entry("google-drive", "Google Drive", "user-oauth", false),
  entry("exa", "Exa Search", "none", true),
  entry(
    "exa-authenticated",
    "Exa Search (API key)",
    "deployment-bearer",
    false,
  ),
  entry("routines", "Routines", "builtin", true),
];

/** A server row as the plugin list returns it. Notion registers its own client; Drive needs one. */
function server(key: string) {
  return {
    id: key,
    title: CATALOGUE.find((item) => item.key === key)?.title ?? key,
    vendor: key,
    url: `https://${key}.example/mcp`,
    summary: "",
    docsUrl: "",
    provenance: "first-party",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: "me",
    dynamicClient: key === "notion",
    authScheme: null,
    tools: [],
    withdrawn: [],
    accountMode: null,
    sharedVendorConnected: false,
    ownerGrants: "any",
    ownerGrantsChosen: null,
  };
}

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const plugins = "/api/plugins";

async function serveConnections(
  browser: Browser,
  { connected = false, broker = false } = {},
) {
  const servers = [server("notion")];
  let notionConnected = connected;
  const writes: { path: string; body: unknown }[] = [];
  await browser.route(/\/api\/plugins$/, (route) =>
    route.fulfill({
      json: {
        catalogue: CATALOGUE,
        servers,
        skills: [],
        botsMayCallBack: true,
        redirectUri: null,
        composioConfigured: broker,
        authorizesPerAction: false,
      },
    }),
  );
  await browser.route(/\/api\/plugins\/connections$/, (route) =>
    route.fulfill({
      json: {
        connections: notionConnected
          ? [{ serverId: "notion", status: "connected" }]
          : [],
      },
    }),
  );
  await browser.route(
    /\/api\/plugins\/servers(?:\/notion\/connect)?(?:\?|$)/,
    (route) => {
      const url = new URL(route.request.url);
      const body: unknown = JSON.parse(route.request.postData ?? "null");
      if (route.request.method === "POST") {
        writes.push({ path: url.pathname + url.search, body });
        if (url.pathname === `${plugins}/servers/notion/connect`) {
          notionConnected = true;
          return route.fulfill({ json: { connected: true } });
        }
        if (
          body &&
          typeof body === "object" &&
          "key" in body &&
          typeof body.key === "string"
        ) {
          servers.push(server(body.key));
          return route.fulfill({ json: { ok: true } });
        }
      }
      return route.fulfill({
        status: 404,
        json: { error: "Unexpected app request" },
      });
    },
  );
  return writes;
}

const tile = (browser: Browser, key: string) =>
  browser.locator(`[data-testid="account-${key}"]`);

if (personal) {
  test("personal Connections shows one searchable list and links to saved logins and keys", async ({
    app,
    browser,
    screen,
  }) => {
    await serveConnections(browser);
    await app.open("/connections");
    await expect(tile(browser, "notion")).toContainText("Connect");
    await expect(tile(browser, "exa")).toContainText("Add");
    const search = screen.getByRole("textbox", "Search connections");
    await expect(search).toBeVisible();
    await expect(screen.getByText("Your apps", { exact: true })).toHaveCount(0);
    await expect(screen.getByText("Add an app", { exact: true })).toHaveCount(
      0,
    );
    await expect(screen.getByRole("link", /Saved logins/)).toHaveAttribute(
      "href",
      "/settings/passwords",
    );
    await expect(screen.getByRole("link", /^Keys/)).toHaveAttribute(
      "href",
      "/settings/credentials",
    );

    const drive = tile(browser, "google-drive");
    const exaKey = tile(browser, "exa-authenticated");
    await expect(drive).toHaveCount(0);
    await expect(exaKey).toHaveCount(0);
    await search.fill("drive");
    await expect(drive).toBeVisible();
    await expect(exaKey).toHaveCount(0);
    await search.fill("");
    await expect(drive).toHaveCount(0);
    await screen.getByRole("button", "Show 2 apps that need setup").tap();
    await expect(drive).toBeVisible();
    await expect(exaKey).toContainText("Set up");
  });

  test("Connect starts an existing Notion app's own authorization", async ({
    app,
    browser,
  }) => {
    const writes = await serveConnections(browser);
    await app.open("/connections");
    const notion = tile(browser, "notion");
    await notion.tap();
    await expect(notion.getByText("Connected", { exact: true })).toBeVisible();
    expect(writes).toEqual([
      {
        path: `${plugins}/servers/notion/connect?returnTo=settings`,
        body: null,
      },
    ]);
  });

  for (const { key, name, endpoint } of [
    {
      key: "google-drive",
      name: "Google Drive",
      endpoint: `${plugins}/servers`,
    },
    { key: "exa-authenticated", name: "Exa Search (API key)", endpoint: null },
  ]) {
    test(`opens ${name} setup from the Connections list`, async ({
      app,
      browser,
      screen,
    }) => {
      const writes = await serveConnections(browser);
      await app.open("/connections");
      await screen.getByRole("button", /apps that need setup/).tap();
      await tile(browser, key).tap();
      await expect(browser).toHaveURL(`/connections/${key}`);
      await expect(
        screen.getByRole("heading", name, { exact: true }),
      ).toBeVisible();
      expect(writes).toEqual(
        endpoint ? [{ path: endpoint, body: { key } }] : [],
      );
    });
  }

  test("Add enables an app that requires no account", async ({
    app,
    browser,
  }) => {
    const writes = await serveConnections(browser);
    await app.open("/connections");
    const exa = tile(browser, "exa");
    await exa.tap();
    await expect(exa.getByText("On", { exact: true })).toBeVisible();
    await expect(browser).toHaveURL("/connections");
    expect(writes).toEqual([
      { path: `${plugins}/servers`, body: { key: "exa" } },
    ]);
  });

  test("connected Notion opens app settings without starting another authorization", async ({
    app,
    browser,
    screen,
  }) => {
    const writes = await serveConnections(browser, { connected: true });
    await app.open("/connections");
    const notion = tile(browser, "notion");
    await expect(notion.getByText("Connected", { exact: true })).toBeVisible();
    await notion.tap();
    await expect(browser).toHaveURL("/connections/notion");
    await expect(screen.getByText("Turned on", { exact: true })).toBeVisible();
    await expect(
      screen.getByText("Your account", { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([]);
  });

  test("personal Connections links to the app directory when a broker is configured", async ({
    app,
    browser,
  }) => {
    await serveConnections(browser, { broker: true });
    await app.open("/connections");
    const browse = tile(browser, "browse");
    await expect(browse).toContainText("Browse apps");
    await expect(browse).not.toContainText(/composio/i);
    await expect(browse).toHaveAttribute(
      "href",
      "/connections/browse/composio",
    );
  });

  test("Routines is always on and links to Your routines", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/connections/routines");
    await expect(
      screen.getByText(
        "Routines are work your Bots do on a schedule. Every Bot can set one up for you.",
      ),
    ).toBeVisible();
    const link = screen.getByRole("link", /Your routines/);
    await expect(link).toHaveAttribute("href", "/routines");
    await expect(screen.getByRole("switch")).toHaveCount(0);
    await expect(screen.getByText("Turned on", { exact: true })).toHaveCount(0);
    await link.tap();
    await expect(browser).toHaveURL("/routines");
  });
} else {
  test("team Connections lists enabled Apps and opens the account page", async ({
    app,
    browser,
    screen,
  }) => {
    await serveConnections(browser);
    await app.open("/connections");
    const notion = tile(browser, "notion");
    await expect(notion).toBeVisible();
    await expect(screen.getByText("Sign-ins and keys")).toHaveCount(0);
    await expect(tile(browser, "google-drive")).toHaveCount(0);
    await expect(tile(browser, "exa")).toHaveCount(0);
    await notion.tap();
    await expect(browser).toHaveURL("/connections/notion");
    await expect(
      screen.getByRole("heading", "Notion", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText("Turned on", { exact: true })).toHaveCount(0);
  });
}
