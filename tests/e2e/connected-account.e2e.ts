import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { gmailServer } from "./fixtures/app-details";

const account = "/connections/gmail";
const action = "Gmail.ListEmails";
const pageDescription = "Bots use this as you, and see only what you can see.";
const connectedDescription =
  "Signed in with Gmail. Bots you allow use your Gmail as you. Disconnecting removes their access everywhere.";
const disconnectedDescription =
  "No Bot can use this as you. Connecting takes you to Gmail to approve access.";
const configuredAdvice =
  "Connecting apps isn't set up yet, so this account can't be connected or disconnected here. Ask an admin to set it up.";

async function serveAccount(
  browser: Browser,
  {
    provider,
    connected,
    configured = true,
    siblings = { siblings: [], unanswered: 0 },
  }: {
    provider: "composio" | "arcade";
    connected: boolean;
    configured?: boolean;
    siblings?: { siblings: string[]; unanswered: number };
  },
) {
  const siblingReads: string[] = [];
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
            tools: [],
          },
        ],
        skills: [],
        botsMayCallBack: true,
        redirectUri: null,
        composioConfigured: configured,
        authorizesPerAction: provider === "arcade",
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
    /\/api\/plugins\/servers\/gmail\/connection\/siblings$/,
    async (route) => {
      await route.fulfill({ json: siblings });
      siblingReads.push(new URL(route.request.url).pathname);
    },
  );
  return siblingReads;
}

test("Disconnect lists the Apps sharing a connected Gmail account", async ({
  app,
  browser,
  screen,
}) => {
  await serveAccount(browser, {
    provider: "arcade",
    connected: true,
    siblings: { siblings: ["googlecalendar", "googledocs"], unanswered: 2 },
  });
  await app.open(account);
  const disconnect = screen.getByRole("button", "Disconnect", { exact: true });
  await expect(disconnect).toBeVisible();
  const row = browser.locator('[data-slot="item"]').filter({ has: disconnect });
  await expect(
    row.getByText(
      "Disconnecting also ends your access to googlecalendar and googledocs, which share this connection. 2 other apps couldn't be checked and may be affected too.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(row).not.toContainText("gmail,");
});

for (const provider of ["arcade", "composio"] as const) {
  test(`a connected Gmail account on ${provider} keeps the Disconnect row when there are no related Apps`, async ({
    app,
    browser,
    screen,
  }) => {
    const reads = await serveAccount(browser, { provider, connected: true });
    await app.open(account);
    await expect(
      screen.getByText(pageDescription, { exact: true }),
    ).toBeVisible();
    const disconnect = screen.getByRole("button", "Disconnect", {
      exact: true,
    });
    await expect(disconnect).toBeVisible();
    const row = browser
      .locator('[data-slot="item"]')
      .filter({ has: disconnect });
    await expect(
      row.getByText(connectedDescription, { exact: true }),
    ).toBeVisible();
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    await expect(
      browser.locator(
        'main[data-slot="sidebar-inset"] [data-slot="item-description"]',
      ),
    ).toHaveCount(1);
    await expect(row).not.toContainText(
      /also ends|couldn't be checked|share this connection/,
    );
    const page = await browser.evaluate(
      () =>
        document.querySelector('main[data-slot="sidebar-inset"]')?.innerHTML ??
        "",
    );
    expect(page).toContain(pageDescription);
    expect(page).not.toMatch(/composio|arcade/i);
    if (provider === "arcade") {
      await expect(
        screen.getByRole("button", "Reconnect", { exact: true }),
      ).toBeVisible();
    }
    await expect(screen.getByText(/You just authorized/)).toHaveCount(0);
  });

  test(`a disconnected Gmail account on ${provider} offers Connect`, async ({
    app,
    browser,
    screen,
  }) => {
    const reads = await serveAccount(browser, {
      provider,
      connected: false,
      siblings: { siblings: ["googledocs"], unanswered: 0 },
    });
    await app.open(account);
    await expect(
      screen.getByText(pageDescription, { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", "Connect", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText(
        provider === "arcade"
          ? `${disconnectedDescription} You can also authorize only the actions you want below.`
          : disconnectedDescription,
      ),
    ).toBeVisible();
    await expect(
      screen.getByText(/Approved per action|googledocs/),
    ).toHaveCount(0);
    expect(reads).toEqual([]);
  });
}

for (const connected of [true, false]) {
  for (const configured of [true, false]) {
    test(`Gmail renders an action return without provider names (connected=${connected}, configured=${configured})`, async ({
      app,
      browser,
      screen,
    }) => {
      await serveAccount(browser, {
        provider: "arcade",
        connected,
        configured,
        siblings: { siblings: ["googledocs"], unanswered: 1 },
      });
      await app.open(`${account}?action=${action}`);
      const status = screen
        .getByRole("status")
        .filter({ hasText: `You just authorized ${action}.` });
      await expect(status).toBeVisible();
      await expect(status).toHaveAttribute("data-landed-action", action);
      await expect(browser).toHaveURL(account);
      if (connected && configured)
        await expect(
          screen.getByText(/Disconnecting also ends your access to googledocs/),
        ).toBeVisible();
      if (!configured)
        await expect(
          screen.getByText(configuredAdvice, { exact: true }),
        ).toBeVisible();
      const page = await browser.evaluate(
        () =>
          document.querySelector('main[data-slot="sidebar-inset"]')
            ?.innerHTML ?? "",
      );
      expect(page).toContain("You just authorized");
      expect(page).not.toMatch(/composio|arcade/i);
    });
  }
}

test("reloading the account clears the notice for an Action just authorized", async ({
  app,
  browser,
  screen,
}) => {
  await serveAccount(browser, { provider: "arcade", connected: true });
  await app.open(`${account}?action=${action}`);
  const status = screen
    .getByRole("status")
    .filter({ hasText: `You just authorized ${action}.` });
  await expect(status).toBeVisible();
  await expect(browser).toHaveURL(account);
  await browser.reload();
  await expect(
    screen.getByRole("button", "Disconnect", { exact: true }),
  ).toBeVisible();
  await expect(status).toHaveCount(0);
});
