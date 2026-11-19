import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { displayName } from "../../server/src/plugins/app-names";
import arcadeCatalogue from "../../server/tests/fixtures/arcade-catalogue.json";
import composioCatalogue from "../../server/tests/fixtures/composio-key-apps.json";
import { gmailServer } from "./fixtures/app-details";

type Broker = "arcade" | "composio";
type Entry = ReturnType<typeof entry>;
const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const directory = (broker: Broker) =>
  personal ? `/connections/browse/${broker}` : `/admin/plugins/${broker}`;
const pluginsPage = personal ? "/connections" : "/admin/plugins";

function entry(
  slug: string,
  name: string,
  kind: "consent" | "fields" = "consent",
  enabled = false,
) {
  return {
    slug,
    name,
    description: `${name} for your Bots.`,
    logo: null,
    categories: [],
    actionCount: 12,
    classifiedCount: null as number | null,
    permissionCount: null as number | null,
    scopedActionCount: null as number | null,
    connection: { kind },
    enabled,
  };
}

async function serveDirectory(
  browser: Browser,
  provider: Broker,
  entries: Entry[],
  options: {
    connected?: Set<string>;
    beforeAdd?: (slug: string) => Promise<string | undefined>;
    beforeReadPlugins?: () => Promise<string | undefined>;
  } = {},
) {
  const connected = options.connected ?? new Set<string>();
  const reads = { plugins: 0, directory: 0 };
  const servers = () =>
    entries
      .filter((app) => app.enabled)
      .map((app) => ({
        ...gmailServer,
        id: `${provider}-${app.slug}`,
        title: app.name,
        vendor: provider,
        url: `${provider}://${app.slug}`,
        provenance: provider,
        authScheme: app.connection.kind === "fields" ? "API_KEY" : "OAUTH2",
        tools: [],
      }));
  const writes: { path: string; body: unknown }[] = [];
  await browser.route(
    /\/api\/plugins\/composio\/apps(?:\?|$)/,
    async (route) => {
      if (route.request.method !== "POST") {
        reads.directory++;
        return route.fulfill({ json: { apps: entries } });
      }
      const body = JSON.parse(route.request.postData ?? "null");
      writes.push({ path: new URL(route.request.url).pathname, body });
      const added = entries.find((app) => app.slug === body?.slug);
      if (!added)
        return route.fulfill({
          status: 404,
          json: { error: "Unknown fixture app" },
        });
      const error = await options.beforeAdd?.(added.slug);
      if (error) return route.fulfill({ status: 409, json: { error } });
      added.enabled = true;
      return route.fulfill({
        status: 201,
        json: { server: { id: `${provider}-${added.slug}` } },
      });
    },
  );
  await browser.route(/\/api\/plugins$/, async (route) => {
    reads.plugins++;
    const error = await options.beforeReadPlugins?.();
    if (error) return route.fulfill({ status: 503, json: { error } });
    return route.fulfill({
      json: {
        catalogue: [],
        servers: servers(),
        skills: [],
        botsMayCallBack: true,
        redirectUri: null,
        composioConfigured: true,
        provider,
      },
    });
  });
  await browser.route(/\/api\/plugins\/connections$/, (route) =>
    route.fulfill({
      json: {
        connections: [...connected].map((serverId) => ({
          serverId,
          scope: "",
          connectedAt: "2026-11-09T00:00:00.000Z",
          holder: "person",
        })),
      },
    }),
  );
  await browser.route(
    /\/api\/plugins\/servers\/[^/]+\/connect(?:\?|$)/,
    (route) => {
      const url = new URL(route.request.url);
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      writes.push({
        path: url.pathname,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      if (id === "composio-posthog") {
        return route.fulfill({
          json: {
            fields: [
              {
                name: "api_key",
                label: "PostHog API key",
                help: "",
                required: true,
                secret: true,
              },
            ],
          },
        });
      }
      return route.fulfill({
        json: {
          authorizationUrl: new URL(`/fixture-app-consent/${id}`, url).href,
        },
      });
    },
  );
  await browser.route(/\/fixture-app-consent\/[^/]+(?:\/accept)?$/, (route) => {
    const parts = new URL(route.request.url).pathname.split("/");
    const id = decodeURIComponent(parts[2] ?? "");
    if (parts[3] === "accept") {
      connected.add(id);
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><h1>App consent saved</h1>",
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><h1>App consent</h1><a href="/fixture-app-consent/${encodeURIComponent(id)}/accept">Authorize app</a>`,
    });
  });
  return { writes, reads };
}

if (personal) {
  for (const [provider, slug, title] of [
    ["composio", "slack", "Slack"],
    ["composio", "github", "GitHub"],
    ["arcade", "Gmail", "Gmail"],
  ] as const) {
    test(`adding ${title} opens a consent tab and waits for the account to connect`, async ({
      app,
      browser,
      screen,
    }) => {
      const { writes } = await serveDirectory(browser, provider, [
        entry(slug, title),
      ]);
      const serverId = `${provider}-${slug}`;
      await app.open(directory(provider));
      const [original] = browser.tabs();
      if (!original) throw new Error("Expected the directory tab");
      const row = screen.getByTestId(`directory-${slug}`);
      const popup = await browser.waitForPopup(() =>
        row.getByRole("button", "Add", { exact: true }).click(),
      );
      await expect(browser).toHaveURL(`/fixture-app-consent/${serverId}`);
      await expect(
        screen.getByRole("heading", "App consent", { exact: true }),
      ).toBeVisible();
      await original.activate();
      await expect(
        row.getByText("Not connected", { exact: true }),
      ).toBeVisible();
      await expect(
        row.getByRole("button", `Waiting for ${title}…`),
      ).toBeVisible();
      await expect(row.getByText("Added", { exact: true })).toHaveCount(0);
      expect(writes.map(({ path }) => path)).toEqual([
        "/api/plugins/composio/apps",
        `/api/plugins/servers/${serverId}/connect`,
      ]);
      expect(writes[0]?.body).toMatchObject({ slug });

      await popup.activate();
      await screen.getByRole("link", "Authorize app").click();
      await expect(
        screen.getByRole("heading", "App consent saved"),
      ).toBeVisible();
      await original.activate();
      await expect(row.getByText("Connected", { exact: true })).toBeVisible();
      await expect(row.getByText("Not connected", { exact: true })).toHaveCount(
        0,
      );
      await popup.close();
    });
  }

  test("adding a key-based App opens its key form in the original tab", async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveDirectory(browser, "composio", [
      entry("posthog", "PostHog", "fields"),
    ]);
    await app.open(directory("composio"));
    const tabs = browser.tabs().length;
    await screen
      .getByTestId("directory-posthog")
      .getByRole("button", "Add", { exact: true })
      .click();
    await expect(browser).toHaveURL("/connections/composio-posthog");
    const dialog = screen.getByRole("dialog", "Connect your account", {
      exact: true,
    });
    await expect(
      dialog.getByLabel("PostHog API key", { exact: true }),
    ).toBeVisible();
    expect(browser.tabs()).toHaveLength(tabs);
    expect(writes).toEqual([
      { path: "/api/plugins/composio/apps", body: { slug: "posthog" } },
      { path: "/api/plugins/servers/composio-posthog/connect", body: null },
    ]);
    await browser.reload();
    await expect(
      screen.getByRole("heading", "PostHog", { exact: true }),
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
  });
} else {
  test("adding an App in team Admin leaves its own account disconnected", async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveDirectory(browser, "composio", [
      entry("slack", "Slack"),
    ]);
    await app.open(directory("composio"));
    const tabs = browser.tabs().length;
    const row = screen.getByTestId("directory-slack");
    await row.getByRole("button", "Add", { exact: true }).click();
    await expect(row.getByRole("button", "Connect Slack")).toBeVisible();
    await expect(
      row.getByText("Added, not connected", { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([
      { path: "/api/plugins/composio/apps", body: { slug: "slack" } },
    ]);
    expect(browser.tabs()).toHaveLength(tabs);
  });
}

test("an enabled App without an account offers Connect beside a connected App", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveDirectory(
    browser,
    "composio",
    [
      entry("slack", "Slack", "consent", true),
      entry("github", "GitHub", "consent", true),
    ],
    { connected: new Set(["composio-github"]) },
  );
  await app.open(directory("composio"));
  const slack = screen.getByTestId("directory-slack");
  const github = screen.getByTestId("directory-github");
  await expect(slack.getByTestId("directory-not-connected")).toHaveText(
    personal ? "Not connected" : "Added, not connected",
  );
  await expect(github.getByText("Connected", { exact: true })).toBeVisible();
  await expect(github.getByTestId("directory-not-connected")).toHaveCount(0);
  await browser.waitForPopup(() =>
    slack.getByRole("button", "Connect Slack").click(),
  );
  await expect(browser).toHaveURL("/fixture-app-consent/composio-slack");
  await expect(
    screen.getByRole("heading", "App consent", { exact: true }),
  ).toBeVisible();
  expect(writes.map(({ path }) => path)).toEqual([
    "/api/plugins/servers/composio-slack/connect",
  ]);
});

test("Arcade displays the classification warning and permission breadth from the recorded catalogue", async ({
  app,
  browser,
  screen,
}) => {
  const tools = Object.values(arcadeCatalogue.tools).filter(
    (tool) => tool.toolkit.name === "AirtableApi",
  );
  const scoped = tools.flatMap((tool) => {
    if (!("requirements" in tool) || !("authorization" in tool.requirements))
      return [];
    const oauth = tool.requirements.authorization.oauth2;
    const scopes = oauth && "scopes" in oauth ? oauth.scopes : [];
    return scopes.length ? [[...scopes].sort().join(" ")] : [];
  });
  const measured = {
    ...entry("airtableapi", "AirtableApi"),
    actionCount: tools.length,
    classifiedCount: tools.filter(
      (tool) => "metadata" in tool && tool.metadata?.behavior,
    ).length,
    scopedActionCount: scoped.length,
    permissionCount: new Set(scoped).size,
  };
  await serveDirectory(browser, "arcade", [
    measured,
    {
      ...measured,
      slug: "unscoped-unknown",
      name: "Unknown scoped actions",
      scopedActionCount: null,
    },
    {
      ...measured,
      slug: "permissions-unknown",
      name: "Unknown permissions",
      permissionCount: null,
    },
    {
      ...entry("apollo", "Apollo"),
      actionCount: 1,
      classifiedCount: 1,
      scopedActionCount: 0,
      permissionCount: 0,
    },
    entry("unmeasured", "Unmeasured App"),
  ]);
  await app.open(directory("arcade"));
  await expect(
    screen.getByRole("heading", "Browse apps", { exact: true }),
  ).toBeVisible();
  const row = screen.getByTestId("directory-airtableapi");
  await expect(row).toContainText(
    "This provider hasn't said which of its actions only read, so each one is treated as a change. Bots ask before using it wherever changes need approval, and check-ins can't use it.",
  );
  await expect(row).toContainText(
    "This app uses 1 separate permission across 2 actions. A further 1 requests no permission of its own and becomes callable with any approval here.",
  );
  await expect(row.getByTestId("coverage-warning")).toBeVisible();
  await expect(row.getByTestId("breadth-note")).toBeVisible();
  await expect(row.getByRole("button", "Add", { exact: true })).toBeEnabled();
  await expect(row).not.toContainText("Needs a key");
  const apollo = screen.getByTestId("directory-apollo");
  await expect(apollo).toBeVisible();
  await expect(apollo.getByTestId("coverage-warning")).toHaveCount(0);
  await expect(apollo.getByTestId("breadth-note")).toHaveText(
    "This app has a single action, and approving it approves the app.",
  );
  const unmeasured = screen.getByTestId("directory-unmeasured");
  await expect(unmeasured).toBeVisible();
  await expect(unmeasured.getByTestId("coverage-warning")).toHaveCount(0);
  for (const slug of [
    "unscoped-unknown",
    "permissions-unknown",
    "unmeasured",
  ]) {
    const row = screen.getByTestId(`directory-${slug}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("breadth-note")).toHaveCount(0);
  }
});

test("the wrong directory waits for provider discovery and redirects without requesting a catalogue", async ({
  app,
  browser,
  screen,
}) => {
  const discovered = Promise.withResolvers<void>();
  const { reads } = await serveDirectory(browser, "composio", [], {
    beforeReadPlugins: async () => {
      await discovered.promise;
      return undefined;
    },
  });
  const search = screen.getByLabel("Search apps", { exact: true });
  try {
    await app.open(directory("arcade"));
    await expect.poll(() => reads.plugins).toBeGreaterThan(0);
    await expect(browser).toHaveURL(directory("arcade"));
    await expect(search).toHaveCount(0);
    await expect(screen.getByRole("alert")).toHaveCount(0);
    expect(reads.directory).toBe(0);
  } finally {
    discovered.resolve();
  }
  await expect(browser).toHaveURL(pluginsPage);
  await expect(search).toHaveCount(0);
  expect(reads.directory).toBe(0);
});

test("a failing plugin settings read shows an error before requesting a catalogue", async ({
  app,
  browser,
  screen,
}) => {
  const { reads } = await serveDirectory(browser, "composio", [], {
    beforeReadPlugins: async () => "The service is unavailable.",
  });
  await app.open(directory("composio"));
  await expect(screen.getByRole("alert")).toContainText(
    "Couldn't load the plugin settings. Reload the page.",
  );
  await expect(browser).toHaveURL(directory("composio"));
  await expect(screen.getByLabel("Search apps", { exact: true })).toHaveCount(
    0,
  );
  expect(reads.directory).toBe(0);
});

test("sign-in Apps appear before key-based Apps, with the right prerequisites on each row", async ({
  app,
  browser,
  screen,
}) => {
  await serveDirectory(
    browser,
    "composio",
    composioCatalogue.catalogue.map((row) => ({
      ...entry(
        row.slug,
        displayName(row.slug, row.name),
        row.slug === "_1password" || row.slug === "posthog"
          ? "fields"
          : "consent",
      ),
      description: row.meta.description,
      actionCount: row.meta.tools_count,
    })),
  );
  await app.open(directory("composio"));
  const onePassword = screen.getByTestId("directory-_1password");
  await expect(onePassword).toContainText("Needs a key from 1Password");
  await expect(onePassword).not.toContainText("1password");
  await expect(screen.getByTestId("directory-posthog")).toContainText(
    "Needs a key from PostHog",
  );
  for (const slug of ["gmail", "hubspot"])
    await expect(screen.getByTestId(`directory-${slug}`)).not.toContainText(
      "Needs a key",
    );
  await expect(screen.getByRole("main").getByText(/composio/i)).toHaveCount(0);
  expect(
    await browser.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          '[data-slot="item"][data-testid^="directory-"]',
        ),
        (row) => row.getAttribute("data-testid"),
      ),
    ),
  ).toEqual([
    "directory-gmail",
    "directory-hubspot",
    "directory-_1password",
    "directory-posthog",
  ]);
});

if (!personal) {
  test("an Add refusal is shown even after a different App starts adding", async ({
    app,
    browser,
    screen,
  }) => {
    const releaseSlack = Promise.withResolvers<void>();
    const refused = "Composio would not take this deployment's key.";
    const { writes } = await serveDirectory(
      browser,
      "composio",
      [entry("slack", "Slack"), entry("gmail", "Gmail")],
      {
        beforeAdd: async (slug) => {
          if (slug !== "slack") return undefined;
          await releaseSlack.promise;
          return refused;
        },
      },
    );
    const slack = screen.getByTestId("directory-slack");
    const gmail = screen.getByTestId("directory-gmail");
    try {
      await app.open(directory("composio"));
      await slack.getByRole("button", "Add", { exact: true }).click();
      await gmail.getByRole("button", "Add", { exact: true }).click();
      await expect(gmail.getByRole("button", "Connect Gmail")).toBeVisible();
      await expect(
        slack.getByRole("button", "Adding…", { exact: true }),
      ).toBeDisabled();
    } finally {
      releaseSlack.resolve();
    }
    await expect(screen.getByRole("alert")).toContainText(refused);
    await expect(
      slack.getByRole("button", "Add", { exact: true }),
    ).toBeEnabled();
    expect(writes.map(({ body }) => body)).toEqual([
      { slug: "slack" },
      { slug: "gmail" },
    ]);
  });
}
