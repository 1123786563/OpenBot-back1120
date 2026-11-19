import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { gmailServer } from "./fixtures/app-details";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const connection = "/connections/gmail";
const admin = "/admin/plugins/gmail";
const connectionOrigin = personal ? "admin" : "settings";
const consent = "/test-gmail-consent";
const defaultCopy =
  "Default. Bots use this account unless you ask for another.";
const work = {
  id: "work",
  identity: "dana@work.example",
  label: "dana@work.example",
  isDefault: true,
  connectedAt: "2026-10-01T12:00:00.000Z",
};
const home = {
  id: "home",
  identity: "dana.home@gmail.example",
  label: "dana.home@gmail.example",
  isDefault: false,
  connectedAt: "2026-10-20T12:00:00.000Z",
};

async function serveAccounts(
  browser: Browser,
  {
    accounts = [],
    configured = true,
    recorded = accounts.length > 0,
    provider = "composio",
    mode = "consent",
  }: {
    accounts?: (typeof work)[];
    configured?: boolean;
    recorded?: boolean;
    provider?: "arcade" | "composio";
    mode?: "consent" | "typed-drift" | "desktop";
  } = {},
) {
  const writes: string[] = [];
  const confirmations: string[] = [];
  let held = accounts;
  let known = recorded;
  let callback = connection;
  let another = false;
  await browser.route(/\/api\/plugins$/, (route) =>
    route.fulfill({
      json: {
        catalogue: [],
        servers: [
          {
            ...gmailServer,
            id: "gmail",
            url: `${provider}://gmail`,
            provenance: provider,
            authScheme: mode === "typed-drift" ? "API_KEY_HEADER" : "OAUTH2",
            tools: [],
          },
        ],
        skills: [],
        provider,
        composioConfigured: configured,
        authorizesPerAction: provider === "arcade",
      },
    }),
  );
  await browser.route(/\/api\/plugins\/connections$/, (route) =>
    route.fulfill({
      json: {
        connections: known
          ? [
              {
                serverId: "gmail",
                holder: "person",
                scope: "",
                connectedAt: work.connectedAt,
                verified: true,
                verifiedAt: null,
              },
            ]
          : [],
      },
    }),
  );
  await browser.route(
    /\/api\/plugins\/servers\/gmail\/connection\/siblings$/,
    (route) => route.fulfill({ json: { siblings: [], unanswered: 0 } }),
  );
  await browser.route(
    /\/api\/plugins\/servers\/gmail\/connection\/confirm$/,
    (route) => {
      confirmations.push(route.request.method);
      return route.fulfill({ json: { connected: held.length > 0 } });
    },
  );
  await browser.route(/\/api\/plugins\/servers\/gmail\/accounts$/, (route) =>
    route.fulfill({ json: { accounts: held, canAddAnother: true } }),
  );
  await browser.route(
    /\/api\/plugins\/servers\/gmail\/accounts\/(?:work|home)(?:\/default)?$/,
    (route) => {
      const { pathname } = new URL(route.request.url);
      const method = route.request.method;
      writes.push(`${method} ${pathname.split("/gmail")[1]}`);
      const id = pathname.split("/accounts/")[1]?.split("/")[0];
      if (method === "POST" && pathname.endsWith("/default")) {
        held = held.map((record) => ({
          ...record,
          isDefault: record.id === id,
        }));
      } else if (method === "DELETE" && !pathname.endsWith("/default")) {
        held = held.filter((record) => record.id !== id);
        known = held.length > 0;
      } else {
        return route.fulfill({
          status: 405,
          json: { error: "Unexpected account mutation." },
        });
      }
      return route.fulfill({ json: { ok: true } });
    },
  );
  await browser.route(
    /\/api\/plugins\/servers\/gmail\/connection$/,
    (route) => {
      writes.push(`${route.request.method} /connection`);
      held = [];
      known = false;
      return route.fulfill({ json: { ok: true } });
    },
  );
  await browser.route(/\/api\/plugins\/servers\/gmail\/connect\?/, (route) => {
    const url = new URL(route.request.url);
    writes.push(`${route.request.method} /connect${url.search}`);
    callback =
      url.searchParams.get("returnTo") === "admin" ? admin : connection;
    another = url.searchParams.get("another") === "1";
    if (mode === "typed-drift")
      return route.fulfill({ json: { fields: [{ name: "api_key" }] } });
    // A fragment keeps the simulated desktop document mounted for the focus event.
    const destination =
      mode === "desktop" ? `${connection}#vendor-opened` : consent;
    return route.fulfill({
      json: { authorizationUrl: new URL(destination, url).href },
    });
  });
  await browser.route(/\/test-gmail-consent$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Gmail consent</title><h1>Gmail consent</h1><a href="/test-gmail-consent/accepted">Allow Gmail</a>',
    }),
  );
  await browser.route(/\/test-gmail-consent\/accepted$/, (route) => {
    if (another) held = [...held, home];
    else if (held.length === 0) held = [work];
    known = true;
    return route.fulfill({ status: 302, headers: { location: callback } });
  });
  return {
    writes,
    confirmations,
    completeDesktopConsent: () => {
      held = [work];
      known = true;
    },
  };
}

test("Gmail lists a single named account and adds a second through consent", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveAccounts(browser, { accounts: [work] });
  await app.open(connection);
  const disconnect = screen.getByRole("button", "Disconnect", { exact: true });
  await expect(screen.getByText("Your account", { exact: true })).toBeVisible();
  await expect(
    screen.getByText(/Signed in with Gmail as dana@work\.example\./),
  ).toBeVisible();
  await expect(disconnect).toHaveCount(1);
  await screen.getByRole("button", /Connect another account/).click();
  await expect(browser).toHaveURL(consent);
  await expect(screen.getByRole("heading", "Gmail consent")).toBeVisible();
  await screen.getByRole("link", "Allow Gmail").click();
  await expect(browser).toHaveURL(connection);
  await expect(
    screen.getByText("Your accounts", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(work.label, { exact: true })).toBeVisible();
  await expect(screen.getByText(home.label, { exact: true })).toBeVisible();
  await expect(disconnect).toHaveCount(2);
  expect(writes).toEqual([
    `POST /connect?returnTo=${connectionOrigin}&another=1`,
  ]);
});

test("Gmail changes the default and disconnects only the selected account", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveAccounts(browser, { accounts: [work, home] });
  await app.open(connection);
  const workRow = browser
    .locator('[data-slot="item"]')
    .filter({ hasText: work.label });
  const homeRow = browser
    .locator('[data-slot="item"]')
    .filter({ hasText: home.label });
  const makeDefault = homeRow.getByRole("button", "Make default", {
    exact: true,
  });
  const disconnect = screen.getByRole("button", "Disconnect", { exact: true });
  await expect(
    screen.getByText("Your accounts", { exact: true }),
  ).toBeVisible();
  await expect(workRow).toContainText(defaultCopy);
  await expect(disconnect).toHaveCount(2);
  await expect(
    screen.getByRole("button", "Make default", { exact: true }),
  ).toHaveCount(1);
  await makeDefault.click();
  await expect(homeRow).toContainText(defaultCopy);
  await expect(workRow).not.toContainText(defaultCopy);
  await browser.reload();
  await expect(homeRow).toContainText(defaultCopy);
  await workRow.getByRole("button", "Disconnect", { exact: true }).click();
  await expect(
    screen.getByText(/Signed in with Gmail as dana\.home@gmail\.example\./),
  ).toBeVisible();
  await expect(screen.getByText(work.label, { exact: true })).toHaveCount(0);
  await expect(disconnect).toHaveCount(1);
  expect(writes).toEqual([
    "POST /accounts/home/default",
    "DELETE /accounts/work",
  ]);
});

for (const path of personal ? [connection] : [connection, admin]) {
  const returnTo = path === admin ? "admin" : connectionOrigin;
  test(`${path} sends Connect to Gmail and Disconnect clears the account`, async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveAccounts(browser);
    const connect = screen.getByRole("button", "Connect", { exact: true });
    const disconnect = screen.getByRole("button", "Disconnect", {
      exact: true,
    });
    const connected = screen.getByText("Connected", { exact: true });
    await app.open(path);
    await expect(screen.getByTestId("account-not-connected")).toHaveText(
      "Not connected",
    );
    await connect.click();
    await expect(browser).toHaveURL(consent);
    await screen.getByRole("link", "Allow Gmail").click();
    await expect(browser).toHaveURL(path);
    await expect(connected).toBeVisible();
    await disconnect.click();
    await expect(connect).toBeVisible();
    await expect(connected).toHaveCount(0);
    await expect(disconnect).toHaveCount(0);
    expect(writes).toEqual([
      `POST /connect?returnTo=${returnTo}`,
      "DELETE /connection",
    ]);
  });
}

test("a recorded consent that the vendor did not complete reads as disconnected", async ({
  app,
  browser,
  screen,
}) => {
  const { confirmations, writes } = await serveAccounts(browser, {
    recorded: true,
  });
  await app.open(connection);
  await expect.poll(() => confirmations.length).toBeGreaterThan(0);
  await expect(screen.getByTestId("account-not-connected")).toHaveText(
    "Not connected",
  );
  await expect(
    screen.getByRole("button", "Connect", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Disconnect", { exact: true }),
  ).toHaveCount(0);
  await expect(screen.getByRole("alert")).toHaveCount(0);
  expect(confirmations.every((method) => method === "POST")).toBe(true);
  expect(writes).toEqual([]);
});

test("a typed scheme returned by the vendor keeps the browser on the App and explains what happened", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveAccounts(browser, { mode: "typed-drift" });
  await app.open(connection);
  await screen.getByRole("button", "Connect", { exact: true }).click();
  await expect(screen.getByRole("alert")).toContainText(
    "This app connects with a key, not a sign-in page",
  );
  await expect(browser).toHaveURL(connection);
  await expect(screen.getByRole("dialog")).toHaveCount(0);
  expect(writes).toEqual([`POST /connect?returnTo=${connectionOrigin}`]);
});

for (const path of personal ? [connection] : [connection, admin]) {
  test(`${path} hides account actions when the deployment loses its broker key`, async ({
    app,
    browser,
    screen,
  }) => {
    const { confirmations, writes } = await serveAccounts(browser, {
      accounts: [work],
      configured: false,
    });
    await app.open(path);
    if (path === admin) {
      await expect(
        screen.getByText(/Set COMPOSIO_API_KEY on this deployment/),
      ).toBeVisible();
      await expect(
        screen.getByText("Key missing", { exact: true }),
      ).toBeVisible();
      await expect(
        screen.getByText("How this is reached", { exact: true }),
      ).toBeVisible();
    } else {
      const setup = personal
        ? /Connecting apps isn't set up yet.*Set it up in Settings under Setup/
        : "Not set up yet";
      await expect(screen.getByText(setup)).toBeVisible();
      await expect(screen.getByText(/COMPOSIO_API_KEY/)).toHaveCount(0);
    }
    await expect(screen.getByText("Connected", { exact: true })).toHaveCount(0);
    await expect(
      screen.getByRole("button", "Connect", { exact: true }),
    ).toHaveCount(0);
    await expect(
      screen.getByRole("button", "Disconnect", { exact: true }),
    ).toHaveCount(0);
    expect(confirmations).toEqual([]);
    expect(writes).toEqual([]);
  });
}

for (const provider of ["arcade", "composio"] as const) {
  test(`Gmail offers in-place reconnection on ${provider} according to the provider capability`, async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveAccounts(browser, {
      provider,
      accounts: [work],
    });
    const reconnect = screen.getByRole("button", "Reconnect", { exact: true });
    await app.open(connection);
    await expect(
      screen.getByRole("button", "Disconnect", { exact: true }),
    ).toBeVisible();
    if (provider === "composio") {
      await expect(reconnect).toHaveCount(0);
      expect(writes).toEqual([]);
      return;
    }
    await reconnect.click();
    await expect(browser).toHaveURL(consent);
    await expect(screen.getByRole("heading", "Gmail consent")).toBeVisible();
    expect(writes).toEqual([`POST /connect?returnTo=${connectionOrigin}`]);
  });
}

test("Desktop consent checks the account once when focus returns", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async () => null,
        transformCallback: () => 0,
      },
    });
  });
  const { confirmations, writes, completeDesktopConsent } = await serveAccounts(
    browser,
    { mode: "desktop" },
  );
  await app.open(connection);
  await expect.poll(() => confirmations.length).toBeGreaterThan(0);
  await screen.getByRole("button", "Connect", { exact: true }).click();
  await expect
    .poll(() => browser.evaluate(() => location.hash))
    .toBe("#vendor-opened");
  const confirmationsBeforeFocus = confirmations.length;
  completeDesktopConsent();
  await browser.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    return null;
  });
  await expect(
    screen.getByRole("button", "Disconnect", { exact: true }),
  ).toBeVisible();
  expect(confirmations.slice(confirmationsBeforeFocus)).toEqual(["POST"]);
  expect(writes).toEqual([
    `POST /connect?returnTo=${connectionOrigin}&from=desktop`,
  ]);
});
