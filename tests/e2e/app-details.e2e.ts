import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  CONNECT_APP_MARKER,
  connectAppRefusal,
} from "../../shared/connect-prompt";
import {
  catalogueNotion,
  exaServer,
  gmailNamedLikeIds,
  gmailServer,
  gmailToolsForModels,
  notionServer,
} from "./fixtures/app-details";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const root = personal ? "/connections" : "/admin/plugins";
const api = "/api/plugins";
const notionConsent = "/test-notion-consent";
const notionConsentCallback = "/test-notion-consent/accepted";
const teamWords =
  /each person|deployment|admin|token to paste|whoever|that person|everybody/i;
const skippedToolServer = {
  ...notionServer,
  tools: [
    {
      serverId: "notion",
      name: "notion-fetch",
      ref: "notion/notion-fetch",
      description: "Reads a page.",
      inputSchema: {},
      effect: "read" as const,
      destructive: false,
      grantedTo: [],
    },
  ],
  toolsRefreshedAt: "2026-10-21T00:00:00.000Z",
};

function connected(serverId: string) {
  return {
    serverId,
    status: "connected",
    holder: "person",
    scope: "",
    connectedAt: "2026-11-07T00:00:00.000Z",
    verified: true,
    verifiedAt: "2026-11-07T00:00:00.000Z",
  };
}

async function serveApp(
  browser: Browser,
  {
    server,
    connection,
    configured = true,
    redirectUri = null,
    provider = "composio",
    catalogueUnavailable,
  }: {
    server?: Omit<
      typeof gmailServer,
      "accountMode" | "authScheme" | "lastError" | "toolsRefreshedAt"
    > & {
      accountMode: string | null;
      authScheme: string | null;
      lastError: string | null;
      toolsRefreshedAt: string | null;
      skippedTools?: string[];
    };
    connection?: ReturnType<typeof connected>;
    configured?: boolean;
    redirectUri?: string | null;
    provider?: "arcade" | "composio";
    catalogueUnavailable?: () => boolean;
  } = {},
) {
  let currentServer = server;
  let currentConnection = connection;
  const writes: { method: string; url: string; body: unknown }[] = [];
  await browser.route(/\/api\/plugins$/, (route) => {
    if (catalogueUnavailable?.()) {
      return route.fulfill({
        status: 500,
        json: { error: "The App catalogue could not be read." },
      });
    }
    return route.fulfill({
      json: {
        catalogue: [catalogueNotion],
        servers: currentServer ? [currentServer] : [],
        skills: [],
        botsMayCallBack: true,
        redirectUri,
        composioConfigured: configured,
        authorizesPerAction: provider === "arcade",
        provider,
      },
    });
  });
  await browser.route(/\/api\/plugins\/connections$/, (route) =>
    route.fulfill({
      json: { connections: currentConnection ? [currentConnection] : [] },
    }),
  );
  await browser.route(/\/test-notion-consent$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Test Notion consent</title><h1>Test Notion consent</h1><a href="${notionConsentCallback}">Allow Notion</a>`,
    }),
  );
  await browser.route(/\/test-notion-consent\/accepted$/, (route) => {
    currentConnection = connected("notion");
    return route.fulfill({
      status: 302,
      headers: { location: `${root}/notion` },
    });
  });
  await browser.route(
    /\/api\/plugins\/servers(?:\/(?:notion|composio-exa)(?:\/(?:connect|connection))?)?(?:\?|$)/,
    (route) => {
      const url = new URL(route.request.url);
      const method = route.request.method;
      const body: unknown = JSON.parse(route.request.postData ?? "null");
      if (method !== "GET")
        writes.push({ method, url: url.pathname + url.search, body });
      if (method === "POST" && url.pathname === `${api}/servers`) {
        currentServer = notionServer;
        return route.fulfill({ json: { ok: true } });
      }
      if (
        method === "POST" &&
        url.pathname === `${api}/servers/notion/connect`
      ) {
        return route.fulfill({
          json: { authorizationUrl: new URL(notionConsent, url).href },
        });
      }
      if (method === "DELETE" && currentServer) {
        const serverUrl = `${api}/servers/${currentServer.id}`;
        if (url.pathname === serverUrl) {
          currentConnection = undefined;
          currentServer = undefined;
          return route.fulfill({ json: { ok: true } });
        }
        if (url.pathname === `${serverUrl}/connection`) {
          currentConnection = undefined;
          return route.fulfill({ json: { ok: true } });
        }
      }
      return route.fulfill({
        status: 404,
        json: { error: "Unexpected App request" },
      });
    },
  );
  return writes;
}

for (const skippedTools of [
  [],
  ["notion.export"],
  ["notion.export", "notion.import"],
]) {
  test(`Notion displays the available action and reports ${skippedTools.length} skipped tools`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveApp(browser, { server: { ...skippedToolServer, skippedTools } });
    await app.open(`${root}/notion`);
    await expect(
      screen.getByText(personal ? "Fetch" : "notion-fetch", { exact: true }),
    ).toBeVisible();
    const notice = screen.getByRole("status").filter({
      hasText: /app lists (was|were) left out|Your Bots can't use/,
    });
    if (skippedTools.length === 0) {
      await expect(notice).toHaveCount(0);
    } else {
      await expect(notice).toBeVisible();
      if (personal) {
        await expect(notice).toHaveText(
          skippedTools.length === 1
            ? "Your Bots can't use one action this app lists, because of how it's named: Export."
            : "Your Bots can't use 2 actions this app lists, because of how they're named: Export, Import.",
        );
      } else {
        await expect(notice).toContainText(
          skippedTools.length === 1
            ? "One action this app lists was left out"
            : "2 actions this app lists were left out",
        );
        for (const name of skippedTools)
          await expect(notice).toContainText(name);
      }
      await expect(
        screen
          .getByRole("alert")
          .filter({ hasText: /left out|Your Bots can't use/ }),
      ).toHaveCount(0);
    }
  });
}

if (!personal) {
  test("the Bot grant page reports the skipped tool alongside the available tool", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    await serveApp(browser, {
      server: { ...skippedToolServer, skippedTools: ["notion.export"] },
    });
    await app.open(`${root}/notion/bots/${bot.id}`);
    await expect(
      screen.getByText("notion-fetch", { exact: true }),
    ).toBeVisible();
    const notice = screen
      .getByRole("status")
      .filter({ hasText: "One action this app lists was left out" });
    await expect(notice).toContainText("notion.export");
  });

  for (const provider of ["arcade", "composio"] as const) {
    for (const accountMode of ["personal", "shared"] as const) {
      test(`the admin ${accountMode} account shows the ${provider} deployment key requirement`, async ({
        app,
        browser,
        screen,
      }) => {
        await serveApp(browser, {
          provider,
          configured: false,
          server: {
            ...gmailServer,
            id: "gmail",
            url: `${provider}://gmail`,
            provenance: provider,
            accountMode,
            tools: [],
          },
        });
        await app.open(`${root}/gmail`);
        const keyName = `${provider.toUpperCase()}_API_KEY`;
        await expect(
          screen.getByText(
            `Set ${keyName} on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.`,
            { exact: true },
          ),
        ).toBeVisible();
        if (provider === "arcade")
          expect(
            await browser.evaluate(
              () => document.querySelector("main")?.innerHTML ?? "",
            ),
          ).not.toMatch(/composio/i);
      });
    }
  }

  for (const accountMode of ["personal", "shared"] as const) {
    test(`a shared-only App in ${accountMode} mode offers only valid account actions`, async ({
      app,
      browser,
      screen,
    }) => {
      await serveApp(browser, {
        server: {
          ...gmailServer,
          id: "store",
          title: "Store",
          url: "composio://store",
          authScheme: "S2S_OAUTH2",
          sharedOnly: true,
          accountMode,
          tools: [],
        },
      });
      await app.open(`${root}/store`);
      if (accountMode === "personal") {
        await expect(
          screen.getByText(/connects only as one shared account/),
        ).toBeVisible();
        await expect(screen.getByRole("button", /^Connect/)).toHaveCount(0);
        await expect(
          screen.getByRole("button", "Make shared", { exact: true }),
        ).toBeVisible();
      } else {
        await expect(
          screen.getByText(/so it can't be made personal/),
        ).toBeVisible();
        await expect(
          screen.getByRole("button", "Make personal", { exact: true }),
        ).toHaveCount(0);
      }
    });
  }
}

const gmailWithoutTools = { ...gmailServer, tools: [] };

const brokerNotes: {
  name: string;
  scheme: string;
  messages: string[];
  absent?: RegExp;
  configured?: boolean;
  connection?: ReturnType<typeof connected>;
}[] = personal
  ? [
      {
        name: "OAuth",
        scheme: "OAUTH2",
        messages: [
          "Connect your Gmail account through OpenBot.",
          "You sign in to Gmail in your browser. OpenBot never sees your password.",
          "Connect your Gmail account so your Bots can use it.",
        ],
      },
      {
        name: "API key",
        scheme: "API_KEY",
        messages: [
          "You connect with a key from your Gmail account. Your Bots use it as you.",
        ],
        absent: /never sees your password/,
      },
      {
        name: "App with no sign-in",
        scheme: "NO_AUTH",
        messages: [
          "Gmail works through OpenBot without an account.",
          "There's nothing to sign in to.",
        ],
        absent: /Connect your Gmail account/,
      },
      {
        name: "missing configuration",
        scheme: "OAUTH2",
        configured: false,
        messages: [
          "Connecting apps isn't set up yet, so you can't connect or disconnect this account here. Set it up in Settings under Setup.",
        ],
        absent: /grant/i,
      },
      {
        name: "connected account",
        scheme: "OAUTH2",
        connection: connected(gmailServer.id),
        messages: [
          "Signed in with Gmail. Connected. Your Bots use your Gmail as you. Disconnecting also removes OpenBot's access to your account.",
        ],
      },
    ]
  : [
      {
        name: "OAuth",
        scheme: "OAUTH2",
        messages: [
          "Each person connects their own account through OpenBot.",
          "This deployment holds one key for every app like this. Each person connects their own account, and a Bot sees only what that person can see. There is no token to paste.",
          "Through OpenBot",
        ],
      },
      {
        name: "missing configuration",
        scheme: "OAUTH2",
        configured: false,
        messages: [
          "Set COMPOSIO_API_KEY on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.",
        ],
      },
      {
        name: "connected account",
        scheme: "OAUTH2",
        connection: connected(gmailServer.id),
        messages: [
          "Signed in with Gmail. Connected. A Bot with these tools uses your Gmail as you. Disconnecting also removes OpenBot's access to your account.",
        ],
      },
    ];

for (const {
  name,
  scheme,
  messages,
  absent,
  configured,
  connection,
} of brokerNotes) {
  test(`Gmail describes ${name} in ${personal ? "personal Connections" : "team Admin"}`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveApp(browser, {
      server: { ...gmailWithoutTools, authScheme: scheme },
      configured,
      connection,
    });
    await app.open(`${root}/${gmailServer.id}`);
    await expect(
      screen.getByRole("heading", "Gmail", { exact: true }),
    ).toBeVisible();
    for (const message of messages) {
      await expect(screen.getByText(message)).toBeVisible();
    }
    if (personal) {
      await expect(screen.getByText(teamWords)).toHaveCount(0);
      await expect(screen.getByText(/composio/i)).toHaveCount(0);
    }
    if (absent) await expect(screen.getByText(absent)).toHaveCount(0);
  });
}

test("Notion shows its OAuth account instructions for this edition", async ({
  app,
  browser,
  screen,
}) => {
  await serveApp(browser, {
    server: notionServer,
    redirectUri: "https://openbot.example/callback",
  });
  await app.open(`${root}/notion`);
  await expect(
    screen.getByText(
      personal
        ? "Connect your Notion account through OpenBot. OpenBot registers an OAuth client, and your Bots see only what you can see."
        : "This vendor answers as whoever is asking. The deployment registers an OAuth client, and each person connects their own account. A Bot only sees what that person can see.",
    ),
  ).toBeVisible();
  if (personal) await expect(screen.getByText(teamWords)).toHaveCount(0);
});

const refusal =
  "You have not connected your Notion account. Connect it and ask again.";
const notConnectedYet = connectAppRefusal({
  serverId: "notion",
  title: "Notion",
  message: refusal,
});

test("Notion's empty tools explain how to connect without displaying a chat card marker", async ({
  app,
  browser,
  screen,
}) => {
  await serveApp(browser, {
    server: { ...notionServer, lastError: notConnectedYet },
  });
  await app.open(`${root}/notion`);
  await expect(screen.getByText("No tools listed")).toBeVisible();
  await expect(
    screen.getByText(
      personal
        ? "Connect your Notion account above to list its tools."
        : refusal,
    ),
  ).toBeVisible();
  await expect(screen.getByText(CONNECT_APP_MARKER)).toHaveCount(0);
  await expect(screen.getByText("serverId")).toHaveCount(0);
  if (personal) await expect(screen.getByText(teamWords)).toHaveCount(0);
});

if (personal) {
  test("Notion displays an ordinary tools error as reported", async ({
    app,
    browser,
    screen,
  }) => {
    const error = "Notion took too long to answer.";
    await serveApp(browser, { server: { ...notionServer, lastError: error } });
    await app.open(`${root}/notion`);
    await expect(screen.getByText(error)).toBeVisible();
  });

  test("Connect Notion adds the App and starts personal authorization in one press", async ({
    app,
    browser,
    screen,
  }) => {
    const writes = await serveApp(browser);
    await app.open(`${root}/notion`);
    const connect = screen.getByRole("button", "Connect Notion");
    await expect(connect).toBeVisible();
    await expect(screen.getByText("Enable for this deployment")).toHaveCount(0);
    await connect.tap();
    await expect
      .poll(() => writes)
      .toEqual([
        { method: "POST", url: `${api}/servers`, body: { key: "notion" } },
        {
          method: "POST",
          url: `${api}/servers/notion/connect?returnTo=admin`,
          body: null,
        },
      ]);
    await expect(browser).toHaveURL(notionConsent);
    await expect(
      screen.getByRole("heading", "Test Notion consent"),
    ).toBeVisible();
    await screen.getByRole("link", "Allow Notion").tap();
    await expect(browser).toHaveURL(`${root}/notion`);
    const enabled = screen.getByRole("switch", "Turn Notion on or off");
    const signedIn = screen.getByText(
      "Connected. Your Bots use your Notion as you.",
      { exact: true },
    );
    await expect(enabled).toHaveAttribute("aria-checked", "true");
    await expect(signedIn).toBeVisible();
    await browser.reload();
    await expect(enabled).toHaveAttribute("aria-checked", "true");
    await expect(signedIn).toBeVisible();
  });

  test("turning off a catalogue App keeps its details available", async ({
    app,
    browser,
    screen,
  }) => {
    const writes = await serveApp(browser, { server: notionServer });
    await app.open(`${root}/notion`);
    await screen.getByRole("switch", "Turn Notion on or off").tap();
    await expect(screen.getByRole("button", "Connect Notion")).toBeVisible();
    await expect(browser).toHaveURL(`${root}/notion`);
    await expect(screen.getByText("Not an app")).toHaveCount(0);
    expect(writes).toEqual([
      { method: "DELETE", url: `${api}/servers/notion`, body: null },
    ]);
  });

  test("turning off an App added from the directory returns to Connections", async ({
    app,
    browser,
    screen,
  }) => {
    const writes = await serveApp(browser, { server: exaServer });
    await app.open(`${root}/composio-exa`);
    await screen.getByRole("switch", "Turn Exa on or off").tap();
    await expect(browser).toHaveURL(root);
    await expect(
      screen.getByRole("heading", "Connections", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText("Not an app")).toHaveCount(0);
    expect(writes).toEqual([
      { method: "DELETE", url: `${api}/servers/composio-exa`, body: null },
    ]);
  });

  test("disconnecting Exa leaves the App on and offers Connect", async ({
    app,
    browser,
    screen,
  }) => {
    const writes = await serveApp(browser, {
      server: exaServer,
      connection: connected(exaServer.id),
    });
    await app.open(`${root}/composio-exa`);
    await screen.getByRole("button", "Disconnect", { exact: true }).tap();
    await expect(
      screen.getByRole("button", "Connect", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("switch", "Turn Exa on or off"),
    ).toHaveAttribute("aria-checked", "true");
    await expect(browser).toHaveURL(`${root}/composio-exa`);
    expect(writes).toEqual([
      {
        method: "DELETE",
        url: `${api}/servers/composio-exa/connection`,
        body: null,
      },
    ]);
  });
}

if (personal) {
  test("Notion lists tools for every Bot and returns to Connections", async ({
    app,
    browser,
    screen,
  }) => {
    const server = {
      ...notionServer,
      tools: [
        {
          serverId: "notion",
          ref: "notion/search",
          name: "search",
          description: "Search your pages.",
          inputSchema: {},
          effect: "read" as const,
          destructive: false,
          grantedTo: [],
        },
      ],
    };
    await serveApp(browser, { server });
    await app.open(`${root}/notion`);
    await expect(screen.getByText("Your account")).toBeVisible();
    await expect(screen.getByText("Search", { exact: true })).toBeVisible();
    await expect(screen.getByText(/Every Bot can use these/)).toContainText(
      "While Extra vigilant is on,",
    );
    await expect(
      screen.getByText(
        /Ask before acting|Bot owners can give it to their Bots|Whose account|this deployment|By Bot/i,
      ),
    ).toHaveCount(0);
    await expect(screen.getByRole("button", "Grant tools…")).toHaveCount(0);
    await expect(screen.getByRole("link", /search/i)).toHaveCount(0);
    const back = screen.getByRole("button", "Connections", { exact: true });
    await expect(back).toHaveAttribute("href", root);
    await back.tap();
    await expect(browser).toHaveURL(root);
    await expect(
      screen.getByRole("heading", "Connections", { exact: true }),
    ).toBeVisible();
  });

  test("Gmail shows readable names, descriptions and effects", async ({
    app,
    browser,
    screen,
  }) => {
    await serveApp(browser, { server: gmailServer });
    await app.open(`${root}/${gmailServer.id}`);
    await expect(
      screen.getByText("Connect your Gmail account so your Bots can use it."),
    ).toBeVisible();
    const add = browser.locator('[data-slot="item"]').filter({
      has: screen.getByText("Add label to email", { exact: true }),
    });
    await expect(add).toContainText(
      "Adds and/or removes specified Gmail labels for a message.",
    );
    await expect(add).toContainText("changes things");
    await expect(screen.getByText("Send email", { exact: true })).toBeVisible();
    await expect(screen.getByText("Get draft", { exact: true })).toBeVisible();
    await expect(
      screen.getByText("Retrieves a single Gmail draft."),
    ).toBeVisible();
    const profile = browser.locator('[data-slot="item"]').filter({
      has: screen.getByText("Get profile", { exact: true }),
    });
    await expect(profile).toHaveText(/^(?:Get profile)\s*reads$/);
    await expect(
      screen.getByText("changes things", { exact: true }),
    ).toHaveCount(2);
    await expect(screen.getByText("reads", { exact: true })).toHaveCount(3);
    await expect(
      screen.getByText(
        /documents|connector|composio|GMAIL_|\w_\w|listLabels|historyId|\x60/i,
      ),
    ).toHaveCount(0);
  });

  test("Gmail turns provider descriptions into readable sentences", async ({
    app,
    browser,
    screen,
  }) => {
    await serveApp(browser, { server: gmailToolsForModels });
    await app.open(`${root}/${gmailServer.id}`);
    for (const [name, description] of [
      [
        "Create filter",
        "Creates a new Gmail filter with specified criteria and actions.",
      ],
      ["Delete filter", "Permanently deletes a Gmail filter."],
      [
        "Delete thread",
        "Immediately and permanently deletes a specified thread and all its messages.",
      ],
      [
        "Delete label",
        "Permanently deletes a user-created Gmail label from the account (not from a message).",
      ],
      [
        "Batch delete messages",
        "Permanently deletes multiple Gmail messages, bypassing Trash.",
      ],
      [
        "Insert message",
        "Inserts a message into the user's mailbox similar to IMAP append.",
      ],
    ] satisfies [string, string][]) {
      const row = browser
        .locator('[data-slot="item"]')
        .filter({ has: screen.getByText(name, { exact: true }) });
      await expect(row).toContainText(description);
    }
    await expect(screen.getByText(/Tool to|DELETES|by (its )?ID/)).toHaveCount(
      0,
    );
    await expect(
      screen.getByText("changes things", { exact: true }),
    ).toHaveCount(6);
  });

  test("Gmail sorts Actions by their readable names", async ({
    app,
    browser,
    screen,
  }) => {
    await serveApp(browser, { server: gmailNamedLikeIds });
    await app.open(`${root}/${gmailServer.id}`);
    await expect(screen.getByText("Who am I", { exact: true })).toBeVisible();
    const names = await browser.evaluate(() =>
      Array.from(
        document.querySelectorAll('[data-slot="item-title"]'),
        (title) => title.textContent,
      ).slice(-13),
    );
    expect(names).toEqual([
      "Fetch message",
      "Fetch thread messages",
      "Get IMAP settings",
      "Get POP settings",
      "Get send-as settings",
      "List CSE identities",
      "List CSE keypairs",
      "Stop watching",
      "Untrash message",
      "Update contact",
      "Update IMAP settings",
      "Update POP settings",
      "Who am I",
    ]);
    for (const [name, description] of [
      [
        "Who am I",
        "Returns the identity (email, name) of the connected Gmail account.",
      ],
      ["Update IMAP settings", "Updates IMAP settings for a Gmail account."],
      [
        "Get send-as settings",
        "Retrieves a specific send-as alias configuration for a Gmail user.",
      ],
      [
        "Stop watching",
        "Stops receiving push notifications for a Gmail mailbox.",
      ],
      ["Untrash message", "Removes a message from trash in Gmail."],
      [
        "Update contact",
        "Replaces selected fields on an existing saved Google contact.",
      ],
    ] satisfies [string, string][]) {
      const row = browser
        .locator('[data-slot="item"]')
        .filter({ has: screen.getByText(name, { exact: true }) });
      await expect(row).toContainText(description);
    }
  });
} else {
  test("team Admin keeps Notion deployment settings and Bot grant controls", async ({
    app,
    browser,
    screen,
  }) => {
    await serveApp(browser, { server: notionServer });
    await app.open(`${root}/notion`);
    await expect(screen.getByText("Enable for this deployment")).toBeVisible();
    await expect(
      screen.getByText("Bot owners can give it to their Bots"),
    ).toBeVisible();
  });

  test("team Admin shows Gmail's original tool names and names its account", async ({
    app,
    browser,
    screen,
  }) => {
    await serveApp(browser, { server: gmailServer });
    await app.open(`${root}/${gmailServer.id}`);
    await expect(screen.getByText("GMAIL_ADD_LABEL_TO_EMAIL")).toBeVisible();
    await expect(
      screen.getByText(
        /Setup is complete without it, and it reaches only your own Gmail account\./,
      ),
    ).toBeVisible();
    await expect(screen.getByText(/documents/i)).toHaveCount(0);
  });

  test("team Admin preserves Gmail's original tool descriptions", async ({
    app,
    browser,
    screen,
  }) => {
    await serveApp(browser, { server: gmailToolsForModels });
    await app.open(`${root}/${gmailServer.id}`);
    await expect(
      screen.getByText(
        /^Tool to permanently delete a Gmail filter by its ID\./,
      ),
    ).toBeVisible();
  });

  test("Routines stays enabled on the App, Action and per-Bot pages", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const routines = {
      ...notionServer,
      id: "routines",
      title: "Routines",
      url: "builtin://routines/",
      dynamicClient: false,
      tools: [
        {
          name: "schedule",
          ref: "routines/schedule",
          description: "Schedule work.",
          serverId: "routines",
          inputSchema: {},
          effect: "write" as const,
          destructive: false,
          grantedTo: [bot.id],
        },
      ],
    };
    const writes = await serveApp(browser, { server: routines });
    await app.open(`${root}/routines`);
    await expect(screen.getByText("Always on", { exact: true })).toBeVisible();
    await expect(screen.getByText("Enable for this deployment")).toHaveCount(0);
    await expect(screen.getByRole("switch", /Routines/)).toHaveCount(0);
    for (const [path, rowName] of [
      ["tools/schedule", bot.name],
      [`bots/${bot.id}`, "schedule"],
    ]) {
      await app.open(`${root}/routines/${path}`);
      const row = browser.locator('[data-slot="item"]').filter({
        has: screen.getByText(rowName, { exact: true }),
      });
      await expect(row.getByText("Always on", { exact: true })).toBeVisible();
      await expect(screen.getByRole("switch")).toHaveCount(0);
    }
    expect(writes).toEqual([]);
  });
}

if (!personal) {
  test("granting a shared action can narrow its audience and persist that grant", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const server = {
      ...gmailServer,
      accountMode: "shared",
      sharedVendorConnected: true,
      tools: gmailServer.tools.map((tool) => ({
        ...tool,
        grantedTo: [] as string[],
      })),
    };
    const read = server.tools.find((tool) => tool.name === "GMAIL_GET_DRAFT");
    if (!read) throw new Error("Expected the Gmail draft action");
    await serveApp(browser, { server });
    const writes: { method: string; body: unknown }[] = [];
    await browser.route(/\/api\/approvals\/shared-use\/bot\/[^/?]+$/, (route) =>
      route.fulfill({
        json: {
          apps: [
            {
              serverId: server.id,
              title: server.title,
              covered: false,
              approval: null,
              needed: { audience: "team", outsideInput: true, members: [] },
            },
          ],
          pending: [],
        },
      }),
    );
    await browser.route(/\/api\/plugins\/grants$/, (route) => {
      const body = JSON.parse(route.request.postData ?? "null");
      writes.push({ method: route.request.method, body });
      read.grantedTo = [bot.id];
      return route.fulfill({ json: { ok: true } });
    });
    await app.open(`${root}/${server.id}/bots/${bot.id}`);
    await expect(
      screen.getByText(
        "Anyone who can use this Bot can read what this account can read.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      screen.getByText(
        "Anyone who can use this Bot can do this as the shared account.",
        { exact: true },
      ),
    ).toBeVisible();
    const grant = screen.getByRole(
      "switch",
      `Let ${bot.name} call GMAIL_GET_DRAFT`,
      { exact: true },
    );
    const dialog = screen.getByRole(
      "dialog",
      `Let ${bot.name} use the shared Gmail account?`,
    );
    await expect(grant).toHaveAttribute("aria-checked", "false");
    await grant.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", "Cancel", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(grant).toHaveAttribute("aria-checked", "false");
    expect(writes).toEqual([]);
    await grant.click();
    const everyone = dialog.getByRole("radio", "Everyone", { exact: true });
    const owner = dialog.getByRole("radio", "Only its owner", { exact: true });
    const outside = dialog.getByRole("checkbox", /Messages from outside/);
    await expect(everyone).toBeChecked();
    await expect(outside).toBeChecked();
    await expect(dialog.getByRole("radio", /^Named/)).toHaveCount(0);
    await owner.click();
    await outside.click();
    await expect(owner).toBeChecked();
    await expect(outside).not.toBeChecked();
    await dialog.getByRole("button", "Allow", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(grant).toHaveAttribute("aria-checked", "true");
    expect(writes).toEqual([
      {
        method: "POST",
        body: {
          agentId: bot.id,
          kind: "mcp",
          ref: read.ref,
          approval: { audience: "owner", outsideInput: false, members: [] },
        },
      },
    ]);
    await browser.reload();
    await expect(grant).toHaveAttribute("aria-checked", "true");
  });
}

if (!personal) {
  test("changing a personal account to shared previews disconnects, leaves the dialog open on failure, and can retry", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const server = {
      ...gmailServer,
      id: "linear",
      title: "Linear",
      url: "composio://linear",
      accountMode: "personal",
      tools: [],
    };
    await serveApp(browser, { server });
    const writes: { method: string; body: unknown }[] = [];
    let confirmations = 0;
    await browser.route(
      /\/api\/plugins\/servers\/linear\/account-mode$/,
      (route) => {
        const body = JSON.parse(route.request.postData ?? "null");
        writes.push({ method: route.request.method, body });
        if (!body?.confirm)
          return route.fulfill({
            json: {
              changed: false,
              preview: {
                mode: "shared",
                wouldRevoke: { holder: "person", count: 14 },
                bots: [
                  {
                    botId: bot.id,
                    exposure: {
                      audience: "team",
                      outsideInput: true,
                      members: [],
                    },
                  },
                ],
              },
            },
          });
        confirmations++;
        if (confirmations === 1)
          return route.fulfill({
            status: 502,
            json: {
              changed: false,
              failures: [{ account: "u2", error: "Composio said no." }],
              error: "Composio said no.",
            },
          });
        server.accountMode = "shared";
        return route.fulfill({ json: { changed: true, revoked: 14 } });
      },
    );

    await app.open("/admin/plugins/linear");
    const launch = screen.getByRole("button", "Make shared", { exact: true });
    const makePersonal = screen.getByRole("button", "Make personal", {
      exact: true,
    });
    await launch.click();
    const dialog = screen.getByRole("dialog", "Share one Linear account?");
    const confirm = dialog.getByRole("button", "Make Linear shared", {
      exact: true,
    });
    await expect(
      dialog.getByText("14 personal accounts will be disconnected.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "Everyone using a Bot with this app will act as this one account.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      dialog.getByRole("list").getByText(bot.name, { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("list")).toContainText(
      "Everyone, and outside input",
    );
    expect(writes).toEqual([
      { method: "PUT", body: { mode: "shared", confirm: false } },
    ]);
    await confirm.click();
    const failure = dialog.getByRole("alert");
    await expect(failure).toBeVisible();
    await failure.getByRole("button", "Details", { exact: true }).click();
    await expect(
      failure.getByText("Composio said no.", { exact: true }),
    ).toBeVisible();
    await expect(confirm).toBeEnabled();
    expect(writes).toEqual([
      { method: "PUT", body: { mode: "shared", confirm: false } },
      { method: "PUT", body: { mode: "shared", confirm: true } },
    ]);

    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(makePersonal).toBeVisible();
    expect(writes).toEqual([
      { method: "PUT", body: { mode: "shared", confirm: false } },
      { method: "PUT", body: { mode: "shared", confirm: true } },
      { method: "PUT", body: { mode: "shared", confirm: true } },
    ]);
    await browser.reload();
    await expect(makePersonal).toBeVisible();
  });
}

if (!personal) {
  for (const { name, path, missing } of [
    {
      name: "App",
      path: "/admin/plugins/slack",
      missing: "Not a plugin",
    },
    {
      name: "tool",
      path: "/admin/plugins/slack/tools/list_channels",
      missing: "This connector is off",
    },
  ]) {
    test(`the Admin ${name} route distinguishes an unavailable catalogue from a missing App`, async ({
      app,
      browser,
      screen,
    }) => {
      let unavailable = true;
      const writes = await serveApp(browser, {
        catalogueUnavailable: () => unavailable,
      });
      const error = screen.getByText(
        "Couldn't load plugins. Reload the page.",
        { exact: true },
      );
      const absent = screen.getByText(missing, { exact: true });
      await app.open(path);
      await expect(error).toBeVisible();
      await expect(absent).toHaveCount(0);
      await expect(
        screen.getByText(
          /Nothing to configure|This connector has no tool with that name/,
        ),
      ).toHaveCount(0);
      unavailable = false;
      await browser.reload();
      await expect(absent).toBeVisible();
      await expect(error).toHaveCount(0);
      expect(writes).toEqual([]);
    });
  }
}

test("Connections reports an unavailable catalogue as a read failure", async ({
  app,
  browser,
  screen,
}) => {
  const writes = await serveApp(browser, { catalogueUnavailable: () => true });
  await app.open("/connections/notion");
  await expect(
    screen.getByText(
      personal
        ? "Couldn't load your apps. Reload the page."
        : /Couldn't load this app\. Reload the page/,
    ),
  ).toBeVisible();
  await expect(
    screen.getByText(/You don't connect this app yourself|Not a plugin/),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Connect", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
});

if (!personal) {
  for (const { accountMode, ownerGrants, explanation } of [
    {
      accountMode: "shared",
      ownerGrants: "any",
      explanation:
        "Bot owners who give it to their Bots let those Bots use the team account.",
    },
    {
      accountMode: "personal",
      ownerGrants: "any",
      explanation:
        "People can let Bots they own use it, on the account of whoever is asking.",
    },
    {
      accountMode: "shared",
      ownerGrants: "admin",
      explanation: "Only an admin can give it to a Bot.",
    },
  ] as const) {
    test(`Admin describes owner grants for a ${accountMode} App with the ${ownerGrants} rule`, async ({
      app,
      browser,
      screen,
    }) => {
      const writes = await serveApp(browser, {
        server: { ...gmailServer, accountMode, ownerGrants, tools: [] },
      });
      await app.open(`${root}/${gmailServer.id}`);
      await expect(
        screen.getByText(explanation, { exact: true }),
      ).toBeVisible();
      expect(writes).toEqual([]);
    });
  }
}
