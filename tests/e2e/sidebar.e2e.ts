import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const name = "Maya Chen";
const footerSelector = '[data-sidebar="footer"]';

test("sidebar shortcuts honor the keyboard layout and require Ctrl or Cmd", async ({
  app,
  browser,
}) => {
  await app.open("/bots");
  const sidebar = browser.locator('[data-slot="sidebar"][data-state]');
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  for (const [key, code, ctrlKey, metaKey, expected] of [
    ["и", "KeyB", true, false, "collapsed"],
    ["β", "KeyB", false, true, "expanded"],
    ["b", "KeyN", true, false, "collapsed"],
    ["x", "KeyB", true, false, "collapsed"],
    ["b", "KeyN", true, false, "expanded"],
    ["т", "KeyN", true, false, "expanded"],
    ["и", "KeyB", false, false, "expanded"],
  ] as const) {
    await browser.evaluate(
      (event) =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            ...event,
            bubbles: true,
            cancelable: true,
          }),
        ),
      { key, code, ctrlKey, metaKey },
    );
    await expect(sidebar).toHaveAttribute("data-state", expected);
  }
});

async function serveSidebar(
  browser: Browser,
  role: "admin" | "user",
  version?: string | null,
  signedOut = () => false,
) {
  await browser.route(/\/api\/me$/, (route) => {
    if (signedOut()) return route.fulfill({ status: 401, json: {} });
    return route.fulfill({
      json: {
        user: {
          id: "maya",
          name,
          email: "maya@example.test",
          role,
          onboarding: null,
        },
        ...(version === undefined ? {} : { version }),
      },
    });
  });
  await browser.route(/\/api\/capabilities$/, async (route) => {
    const capabilities = await (await route.fetch()).json<
      Record<string, boolean | string | string[] | null>
    >();
    return route.fulfill({
      json: { ...capabilities, localEvaluation: personal },
    });
  });
  await browser.route(/\/api\/browser$/, (route) =>
    route.fulfill({ json: { available: false } }),
  );
  await browser.route(/\/api\/bots\/attention$/, (route) =>
    route.fulfill({
      json: {
        bots: [
          {
            agentId: "expenses",
            name: "Expenses",
            questions: 1,
            approvals: 0,
            handoffs: 0,
            unread: 0,
            paused: false,
            notify: "all",
            items: 0,
            tasks: { needsInput: 0, ready: 0, failed: 0 },
          },
        ],
        lastPingId: null,
      },
    }),
  );
}

if (personal) {
  test("personal navigation offers OpenBot for Business from the account menu", async ({
    app,
    browser,
    screen,
  }) => {
    await serveSidebar(browser, "admin");
    await app.open("/");
    const footer = browser.locator(footerSelector);
    const trigger = footer.getByRole("button", /Maya Chen/);
    await expect(trigger).toBeVisible();
    const links = await browser.evaluate(
      (selector) =>
        Array.from(document.querySelectorAll(`${selector} a[href]`), (link) =>
          link.getAttribute("href"),
        ),
      footerSelector,
    );
    expect(links).toEqual(["/bots", "/routines", "/connections"]);
    await trigger.tap();
    const menu = screen.getByRole("menu");
    const business = menu.getByRole("menuitem", "OpenBot for Business", {
      exact: true,
    });
    const settings = menu.getByRole("menuitem", "Settings", { exact: true });
    await expect(business).toBeVisible();
    await expect(settings).toHaveAttribute("href", "/settings");
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await expect(menu.getByRole("menuitem", "Admin")).toHaveCount(0);
    await expect(menu.getByRole("menuitem", "Sign out")).toHaveCount(0);
    await expect(browser.locator('[role="menuitem"] svg image')).toHaveCount(1);
    const businessSize = await business.boundingBox();
    const settingsSize = await settings.boundingBox();
    if (!businessSize || !settingsSize)
      throw new Error("Account menu items are not visible");
    expect(Math.abs(businessSize.width - settingsSize.width)).toBeLessThan(1);
    await business.tap();
    const dialog = screen.getByRole("dialog", "OpenBot for Business");
    await expect(
      dialog.getByRole("heading", "OpenBot for Business", { exact: true }),
    ).toBeVisible();
  });
} else {
  const unfinished = "Signing out did not finish. Try again.";
  for (const [provider, error] of [
    ["Better Auth", { code: "SERVICE_UNAVAILABLE", message: unfinished }],
    ["organization sign-in", { error: unfinished }],
  ] as const) {
    test(`a refused ${provider} sign-out keeps the session and can be retried`, async ({
      app,
      browser,
      screen,
    }) => {
      let signedOut = false;
      const requests: string[] = [];
      await serveSidebar(browser, "user", undefined, () => signedOut);
      await browser.route(/\/api\/auth\/sign-out$/, (route) => {
        requests.push(route.request.method);
        if (requests.length === 1)
          return route.fulfill({ status: 503, json: error });
        signedOut = true;
        return route.fulfill({ json: { success: true } });
      });
      await app.open("/bots");
      const account = browser
        .locator(footerSelector)
        .getByRole("button", /Maya Chen/);
      const signOut = screen.getByRole("menuitem", "Sign out", { exact: true });
      const notification = browser.locator('[data-slot="toast"]');
      await account.click();
      await signOut.click();
      await expect(notification).toHaveCount(1);
      await expect(notification).toHaveText(unfinished);
      await expect(browser).toHaveURL("/bots");
      await expect(account).toBeVisible();
      expect(requests).toEqual(["POST"]);

      await account.click();
      await expect(signOut).toBeEnabled();
      await signOut.click();
      await expect(browser).toHaveURL("/sign");
      await expect(screen.getByRole("heading", /^Sign in to /)).toBeVisible();
      await expect(notification).toHaveCount(0);
      expect(requests).toEqual(["POST", "POST"]);
    });
  }

  for (const role of ["user", "admin"] as const) {
    test(`team navigation shows the sidebar and account menu for the ${role} role`, async ({
      app,
      browser,
      screen,
    }) => {
      await serveSidebar(browser, role);
      await app.open("/");
      const footer = browser.locator(footerSelector);
      const bots = footer.getByRole("link", /^Bots/);
      const badge = bots.getByRole("img", "1 thing needs you", { exact: true });
      await expect(badge).toBeVisible();
      const links = await browser.evaluate(
        (selector) =>
          Array.from(
            document.querySelectorAll(`${selector} a[href]`),
            (link) => ({
              label: link.textContent?.trim().replace(/\d+$/, ""),
              href: link.getAttribute("href"),
            }),
          ),
        footerSelector,
      );
      expect(links).toEqual([
        { label: "Bots", href: "/bots" },
        { label: "Routines", href: "/routines" },
        { label: "Capabilities", href: "/capabilities" },
        { label: "Connections", href: "/connections" },
      ]);
      await expect(bots).toHaveAttribute("href", "/bots");
      await footer.getByRole("button", /Maya Chen/).tap();
      const menu = screen.getByRole("menu");
      await expect(
        menu.getByRole("menuitem", "Sign out", { exact: true }),
      ).toBeVisible();
      const items = await browser.evaluate(() =>
        Array.from(
          document.querySelectorAll('[role="menu"] [role="menuitem"]'),
          (item) => ({
            label: item.textContent?.trim(),
            href: item.getAttribute("href"),
          }),
        ),
      );
      expect(items).toEqual([
        ...(role === "admin" ? [{ label: "Admin", href: "/admin" }] : []),
        { label: "Settings", href: "/settings" },
        { label: "Sign out", href: null },
      ]);
    });
  }

  test("the server release appears beside the person's name in the same row", async ({
    app,
    browser,
  }) => {
    await serveSidebar(browser, "user", "v0.3.1");
    await app.open("/");
    const account = browser
      .locator(footerSelector)
      .getByRole("button", /Maya Chen/);
    const person = account.getByText(name, { exact: true });
    const version = account.getByText("v0.3.1", { exact: true });
    await expect(version).toBeVisible();
    const nameBox = await person.boundingBox();
    const versionBox = await version.boundingBox();
    if (!nameBox || !versionBox)
      throw new Error("The account name or release is missing");
    expect(versionBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width);
    expect(
      Math.abs(
        versionBox.y + versionBox.height / 2 - (nameBox.y + nameBox.height / 2),
      ),
    ).toBeLessThan(2);
  });

  for (const version of [null, undefined]) {
    test(`the account menu omits the release when the server sends ${version === null ? "null" : "no version"}`, async ({
      app,
      browser,
    }) => {
      await serveSidebar(browser, "user", version);
      await app.open("/");
      await expect(
        browser.locator(footerSelector).getByRole("button", /Maya Chen/),
      ).toBeVisible();
      await expect(
        browser.locator('[data-slot="openbot-version"]'),
      ).toHaveCount(0);
    });
  }
}

test(`the ${personal ? "personal" : "team"} homepage shows the Business offer for its edition`, async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await expect(
    screen.getByRole("button", "New conversation", { exact: true }),
  ).toBeVisible();
  const offer = screen.getByRole("link", "Meet OpenBot for Business", {
    exact: true,
  });
  if (!personal) {
    await expect(offer).toHaveCount(0);
    return;
  }

  const url = "https://open.bot/business";
  await browser.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Business offer</title>",
    }),
  );
  await expect(offer).toHaveAttribute("href", url);
  await expect(offer).toHaveAttribute("target", "_blank");
  const popup = await browser.waitForPopup(() => offer.click());
  await expect.poll(() => popup.title()).toBe("Business offer");
  await popup.close();

  const close = browser
    .locator("span")
    .filter({ has: offer })
    .filter({
      has: screen.getByRole("button", "Close", { exact: true }),
    })
    .getByRole("button", "Close", { exact: true });
  await close.click();
  await expect(offer).toHaveCount(0);
  await browser.reload();
  await expect(
    screen.getByRole("button", "New conversation", { exact: true }),
  ).toBeVisible();
  await expect(offer).toHaveCount(0);

  const tab = await browser.newTab();
  await app.open("/");
  await expect(offer).toBeVisible();
  await tab.close();
});

if (personal) {
  async function openNarrowSidebar(fixtures: Parameters<typeof createBot>[0]) {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const currentTitle = `AI Model and Agent Framework ${bot.name}`;
    const otherTitle = `Hacker News Top Stories ${bot.name}`;
    const current = await createConversation(browser, bot.id, currentTitle);
    const other = await createConversation(browser, bot.id, otherTitle);
    const currentPath = `/channel/${current}`;
    await serveSidebar(browser, "admin");
    await browser.route(/\/api\/browser$/, (route) =>
      route.fulfill({
        json: { available: true, computerId: "", open: false, tabs: [] },
      }),
    );
    await browser.setViewport({ width: 390, height: 570 });
    await app.open(currentPath);
    await screen.getByRole("button", "Show sidebar", { exact: true }).click();
    const sheet = screen.getByRole("dialog", "Sidebar", { exact: true });
    await expect(sheet).toBeVisible();
    return {
      sheet,
      currentPath,
      otherPath: `/channel/${other}`,
      currentTitle,
      otherTitle,
    };
  }

  for (const item of [
    { label: /Hacker News Top Stories/, role: "link", destination: "other" },
    {
      label: /AI Model and Agent Framework/,
      role: "link",
      destination: "current",
    },
    { label: /^Bots/, role: "link", destination: "/bots" },
    { label: /^Connections/, role: "link", destination: "/connections" },
    { label: /^Teach a Bot/, role: "link", destination: "/browser" },
    { label: "New conversation", role: "button", destination: "/channel/new" },
  ] as const) {
    test(`the narrow sidebar closes after selecting ${item.label}`, async (fixtures) => {
      const { browser } = fixtures;
      const { sheet, currentPath, otherPath, currentTitle, otherTitle } =
        await openNarrowSidebar(fixtures);
      const label =
        item.destination === "current"
          ? new RegExp(RegExp.escape(currentTitle))
          : item.destination === "other"
            ? new RegExp(RegExp.escape(otherTitle))
            : item.label;
      await sheet.getByRole(item.role, label).click();
      const path =
        item.destination === "current"
          ? currentPath
          : item.destination === "other"
            ? otherPath
            : item.destination;
      await expect(browser).toHaveURL(path);
      await expect(
        browser.locator('[data-mobile="true"][data-sidebar="sidebar"]'),
      ).toHaveCount(0);
    });
  }

  test("searching the narrow sidebar keeps it open and filters conversations", async (fixtures) => {
    const { browser } = fixtures;
    const { sheet, currentPath, currentTitle, otherTitle } =
      await openNarrowSidebar(fixtures);
    const search = sheet.getByRole("textbox", "Search conversations", {
      exact: true,
    });
    await search.fill("hacker");
    await expect(search).toHaveValue("hacker");
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole("link", new RegExp(RegExp.escape(otherTitle))),
    ).toBeVisible();
    await expect(
      sheet.getByRole("link", new RegExp(RegExp.escape(currentTitle))),
    ).toHaveCount(0);
    await expect(browser).toHaveURL(currentPath);
  });

  test("Settings in the narrow sidebar account menu opens Settings and closes the sheet", async (fixtures) => {
    const { browser, screen } = fixtures;
    const { sheet } = await openNarrowSidebar(fixtures);
    await sheet.getByRole("button", /Maya Chen/).click();
    const menu = screen.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(
      browser.locator('[data-mobile="true"][data-sidebar="sidebar"]'),
    ).toBeVisible();
    await menu.getByRole("menuitem", "Settings", { exact: true }).click();
    await expect(browser).toHaveURL("/settings");
    await expect(
      browser.locator('[data-mobile="true"][data-sidebar="sidebar"]'),
    ).toHaveCount(0);
  });

  test("Business features open at the title and close the narrow sidebar", async (fixtures) => {
    const { browser, screen } = fixtures;
    const { sheet, currentPath } = await openNarrowSidebar(fixtures);
    const dialog = screen.getByRole("dialog", "OpenBot for Business", {
      exact: true,
    });
    await expect(dialog).toHaveCount(0);
    await sheet.getByRole("button", /Maya Chen/).click();
    await screen
      .getByRole("menuitem", "OpenBot for Business", { exact: true })
      .click();
    await expect(
      browser.locator('[data-mobile="true"][data-sidebar="sidebar"]'),
    ).toHaveCount(0);
    await expect(browser).toHaveURL(currentPath);
    const heading = dialog.getByRole("heading", "OpenBot for Business", {
      exact: true,
    });
    await expect(heading).toBeVisible();
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const panel = document.activeElement;
          return (
            panel instanceof HTMLElement &&
            panel.closest('[role="dialog"]') !== null &&
            panel.querySelector("h2") !== null &&
            panel.querySelector('a[href="https://open.bot/business"]') !==
              null &&
            panel.scrollTop === 0
          );
        }),
      )
      .toBe(true);
    const talk = dialog.getByRole("link", "Talk to us", { exact: true });
    await expect(talk).toHaveAttribute("href", "https://open.bot/business");
    await expect(talk).toHaveAttribute("target", "_blank");
    await expect(dialog.getByRole("link")).toHaveCount(1);
    await expect(dialog.getByRole("listitem")).toHaveCount(11);
    expect(
      await browser.evaluate(() =>
        Array.from(
          document.querySelectorAll('[role="dialog"] section'),
          (section) => ({
            title: section.querySelector("h3")?.textContent?.trim() ?? "",
            features: Array.from(section.querySelectorAll("li"), (feature) =>
              feature.textContent.trim(),
            ),
          }),
        ),
      ),
    ).toEqual([
      {
        title: "For your whole team",
        features: [
          "Sign-in with Google, Microsoft or Okta",
          "People, roles and admins",
          "Bots shared with your whole team",
          "Learning shared across the team",
        ],
      },
      {
        title: "Where your Bots work",
        features: [
          "Bots in Slack and Microsoft Teams",
          "A computer for each Bot",
        ],
      },
      {
        title: "In control",
        features: [
          "Controls over models, apps and networks",
          "Rules every Bot follows",
          "Policies in plain English, tested on past activity",
          "Governance for everyone",
          "A full audit trail, with export",
        ],
      },
    ]);
    await expect(dialog.getByRole("button")).toHaveCount(1);
    await dialog.getByRole("button", "Close", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(browser).toHaveURL(currentPath);
  });
}

test(`a ${personal ? "personal" : "team"} workspace resolves the Admin People address`, async ({
  app,
  browser,
  screen,
}) => {
  await serveSidebar(browser, "admin");
  await app.open("/admin/people");
  await expect(browser).toHaveURL(personal ? "/settings" : "/admin/people");
  await expect(
    screen.getByRole("heading", personal ? "General" : "People", {
      exact: true,
    }),
  ).toBeVisible();
  if (personal) {
    await app.open("/admin/plugins/notion/tools/search");
    await expect(browser).toHaveURL("/connections/notion");
  }
});
