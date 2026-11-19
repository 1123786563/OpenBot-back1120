import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { appConfig } from "../../app/src/lib/generated/application-config";

const aboutYou = "About you";
const settings = "/settings";
const desktop = "plugin:openbot-desktop|";
const defaultConnection = {
  kind: "claude-plan",
  model: null,
  endpointHost: null,
};

type DesktopSettings = {
  calls: { command: string; args: Record<string, boolean> | null }[];
};

async function useDesktop(
  browser: Browser,
  options: {
    connection?: {
      kind: string;
      model: string | null;
      endpointHost: string | null;
    };
    usageData?: { shared: boolean; offByEnvironment: boolean };
    legacy?: boolean;
  } = {},
) {
  await browser.addInitScript(
    ({ prefix, connection, initialUsageData, legacy }) => {
      const settings: DesktopSettings = { calls: [] };
      Object.assign(window, { desktopSettingsFixture: settings });
      const saved = window.localStorage.getItem("fixture-usage-data");
      let usage =
        saved === null
          ? initialUsageData
          : { ...initialUsageData, shared: saved === "true" };
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          transformCallback: () => 0,
          async invoke(command: string, args?: Record<string, boolean>) {
            settings.calls.push({ command, args: args ?? null });
            switch (command) {
              case `${prefix}ai_connection`:
                return connection;
              case `${prefix}change_ai_connection`:
                return null;
              case `${prefix}usage_data`:
                if (legacy) throw new Error("usage_data is unavailable");
                return usage;
              case `${prefix}set_usage_data`:
                usage = { ...usage, shared: args?.share === true };
                window.localStorage.setItem(
                  "fixture-usage-data",
                  String(usage.shared),
                );
                return usage;
              default:
                return null;
            }
          },
        },
      });
    },
    {
      prefix: desktop,
      connection: options.connection ?? defaultConnection,
      initialUsageData: options.usageData ?? {
        shared: true,
        offByEnvironment: false,
      },
      legacy: options.legacy ?? false,
    },
  );
  return () =>
    browser.evaluate(() => {
      const page = window as Window & {
        desktopSettingsFixture?: DesktopSettings;
      };
      if (!page.desktopSettingsFixture)
        throw new Error("Desktop settings fixture was not installed");
      return page.desktopSettingsFixture.calls;
    });
}

test("standing instructions show the empty state and preserve saved instructions across reload", async ({
  app,
  browser,
  screen,
}) => {
  let instructions = "";
  const requests: unknown[] = [];
  await browser.route(/\/api\/settings\/instructions$/, (route) => {
    if (route.request.method !== "GET") {
      const body = JSON.parse(route.request.postData ?? "null");
      requests.push({ method: route.request.method, body });
      instructions = body.instructions.trim();
    }
    return route.fulfill({ json: { instructions } });
  });
  await app.open(settings);
  const row = screen.getByRole("button", /^Standing instructions/);
  await expect(row).toContainText(
    "None yet. Tell every Bot how you want things done.",
  );
  await row.click();
  const dialog = screen.getByRole("dialog", "Standing instructions");
  const editor = dialog.getByRole("textbox", "Standing instructions");
  const draft = "  Write in British English.  ";
  await expect(editor).toHaveValue("");
  await editor.fill(draft);
  await dialog.getByRole("button", "Save", { exact: true }).click();
  await expect(dialog.getByText("Saved", { exact: true })).toBeVisible();
  await expect(editor).toHaveValue("Write in British English.");
  expect(requests).toEqual([{ method: "PUT", body: { instructions: draft } }]);
  await browser.reload();
  await expect(row).toContainText("Write in British English.");
});

for (const variant of [
  {
    connection: defaultConnection,
    provider: "Anthropic",
    summary: "Signed in with your Claude plan.",
    signIn: "Claude plan",
  },
  {
    connection: {
      ...defaultConnection,
      kind: "open-ai-api-key",
      apiKey: "sk-fixture-not-for-display",
    },
    provider: "OpenAI",
    summary: "Uses your OpenAI API key.",
    signIn: "API key",
  },
  {
    connection: {
      kind: "compatible-endpoint",
      model: "gemini-3.8-flash",
      endpointHost: "generativelanguage.googleapis.com",
    },
    provider: "Google Gemini",
    summary: "Uses your Google Gemini API key. Model: gemini-3.8-flash",
    signIn: "API key",
  },
]) {
  test(`Desktop settings describe ${variant.provider} and its sign-in method`, async ({
    app,
    browser,
    screen,
  }) => {
    await useDesktop(browser, { connection: variant.connection });
    await app.open(settings);
    await expect(
      screen.getByRole("heading", "AI model", { exact: true }),
    ).toBeVisible();
    const row = screen.getByRole("button", new RegExp(`^${variant.provider}`));
    await expect(row).toContainText(variant.summary);
    await expect(row).not.toContainText("sk-fixture");
    await row.click();
    const dialog = screen.getByRole("dialog", "AI connection");
    await expect(
      dialog.getByText(variant.signIn, { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        `Your Bots use ${variant.provider}. Your key or sign-in stays on this computer.`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(dialog).not.toContainText("sk-fixture");
  });
}

test("changing the AI connection asks the Desktop shell and disables the button while stopping", async ({
  app,
  browser,
  screen,
}) => {
  const calls = await useDesktop(browser);
  await app.open(settings);
  await screen.getByRole("button", /^Anthropic/).click();
  const dialog = screen.getByRole("dialog", "AI connection");
  await dialog.getByRole("button", "Change AI connection").click();
  await expect(dialog.getByRole("button", "Stopping OpenBot…")).toBeDisabled();
  expect(
    (await calls()).filter(
      ({ command }) => command === `${desktop}change_ai_connection`,
    ),
  ).toHaveLength(1);
});

test("Desktop privacy explains usage data and persists opting out across reload", async ({
  app,
  browser,
  screen,
}) => {
  const calls = await useDesktop(browser);
  await app.open(settings);
  const toggle = screen.getByRole("switch", "Share usage data", {
    exact: true,
  });
  await expect(
    screen.getByRole("heading", "Privacy", { exact: true }),
  ).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(
    screen.getByText(
      /It never sends your conversations, files or keys\. Changes apply the next time OpenBot starts\./,
    ),
  ).toBeVisible();
  await expect(screen.getByRole("link", "What OpenBot sends")).toHaveAttribute(
    "href",
    "https://github.com/CopilotKit/OpenBot/blob/main/desktop/TELEMETRY.md",
  );
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const writes = async () =>
    (await calls()).filter(
      ({ command }) => command === `${desktop}set_usage_data`,
    );
  expect(await writes()).toEqual([
    { command: `${desktop}set_usage_data`, args: { share: false } },
  ]);
  await browser.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await writes()).toEqual([
    { command: `${desktop}set_usage_data`, args: { share: true } },
  ]);
});

test("Desktop privacy is disabled when usage data is turned off by the environment", async ({
  app,
  browser,
  screen,
}) => {
  const calls = await useDesktop(browser, {
    usageData: { shared: false, offByEnvironment: true },
  });
  await app.open(settings);
  const toggle = screen.getByRole("switch", "Share usage data", {
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeDisabled();
  await expect(screen.getByText(/Turned off on this computer/)).toBeVisible();
  expect(
    (await calls()).filter(
      ({ command }) => command === `${desktop}set_usage_data`,
    ),
  ).toEqual([]);
});

test("an older Desktop shell without the privacy command omits the privacy controls", async ({
  app,
  browser,
  screen,
}) => {
  const calls = await useDesktop(browser, { legacy: true });
  await app.open(settings);
  await expect(
    screen.getByRole("heading", "AI model", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await calls()).some(({ command }) => command === `${desktop}usage_data`),
    )
    .toBe(true);
  await expect(
    screen.getByRole("heading", "Privacy", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("switch", "Share usage data", { exact: true }),
  ).toHaveCount(0);
});

test("General settings in a regular browser omit Desktop settings", async ({
  app,
  screen,
}) => {
  await app.open(settings);
  await expect(
    screen.getByRole("heading", aboutYou, { exact: true }),
  ).toBeVisible();
  for (const heading of ["AI model", "Privacy"])
    await expect(
      screen.getByRole("heading", heading, { exact: true }),
    ).toHaveCount(0);
});

for (const refused of [false, true]) {
  test(`the account skin changes optimistically and ${refused ? "rolls back on refusal" : "persists after reload"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const previous = refused ? "openduet" : "openbot";
    const selected = refused ? "openmuse" : "opendots";
    const name = refused ? "OpenFuse" : "OpenDots";
    let stored = previous;
    const writes: unknown[] = [];
    const pending = Promise.withResolvers<void>();
    await browser.route(/\/api\/settings\/preferences$/, async (route) => {
      if (route.request.method === "PATCH") {
        writes.push(JSON.parse(route.request.postData ?? "null"));
        await pending.promise;
        if (refused)
          return route.fulfill({
            status: 503,
            json: { error: "Storage down" },
          });
        stored = selected;
      }
      return route.fulfill({
        json: { preferences: { messageListEmphasis: "thread", skin: stored } },
      });
    });
    const html = browser.locator("html");
    try {
      await app.open(settings);
      const picker = screen.getByRole("combobox", "Skin", { exact: true });
      await expect(picker).toBeEnabled();
      await expect(picker).toHaveText(
        refused ? "OpenDuet" : appConfig.brand.productName,
      );
      await picker.click();
      const option = screen.getByRole("option", new RegExp(`^${name}`));
      if (!refused)
        await expect(option).toContainText(
          "A compact sidebar of your Bots, with each Bot's computer beside the conversation.",
        );
      await option.click();
      await expect(html).toHaveAttribute("data-skin", selected);
      await expect(picker).toBeDisabled();
      await expect.poll(() => writes).toEqual([{ skin: selected }]);
      const readCache = () =>
        browser.evaluate(() => localStorage.getItem("openbot-skin"));
      expect(await readCache()).toBe(selected);
      pending.resolve();
      if (refused) {
        await expect(screen.getByRole("alert")).toHaveText(
          "Couldn't save that skin to your account, so OpenDuet is back. Try again.",
        );
        await expect(html).toHaveAttribute("data-skin", previous);
      } else {
        await expect(picker).toBeEnabled();
        await expect(screen.getByRole("alert")).toHaveCount(0);
        await browser.reload();
        await expect(picker).toHaveText("OpenDots");
        await expect(html).toHaveAttribute("data-skin", selected);
      }
      expect(await readCache()).toBe(refused ? previous : selected);
      expect(writes).toEqual([{ skin: selected }]);
    } finally {
      pending.resolve();
    }
  });
}

test("saved account preferences replace a cached skin and return an unsupported screen to Home", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    if (window.top === window && /^https?:$/.test(location.protocol))
      localStorage.setItem("openbot-skin", "openduet");
  });
  const prefs = Promise.withResolvers<void>();
  const writes: string[] = [];
  await browser.route(/\/api\/settings\/preferences$/, async (route) => {
    if (route.request.method !== "GET") writes.push(route.request.method);
    await prefs.promise;
    return route.fulfill({
      json: {
        preferences: { messageListEmphasis: "thread", skin: "opendots" },
      },
    });
  });
  try {
    await app.open("/s/tasks");
    await expect(browser.locator("[data-openduet-frame]")).toBeVisible();
    await expect(browser).toHaveURL("/s/tasks");
    await expect(browser.locator("html")).toHaveAttribute(
      "data-skin",
      "openduet",
    );
    prefs.resolve();
    await expect(browser).toHaveURL("/");
    await expect(browser.locator("html")).toHaveAttribute(
      "data-skin",
      "opendots",
    );
    await expect(browser.locator("[data-openduet-frame]")).toHaveCount(0);
    await expect(browser.locator("[data-opendots-main]")).toBeVisible();
    await expect(
      screen.getByRole("textbox", "Message", { exact: true }),
    ).toBeVisible();
    expect(
      await browser.evaluate(() => localStorage.getItem("openbot-skin")),
    ).toBe("opendots");
    expect(writes).toEqual([]);
  } finally {
    prefs.resolve();
  }
});

test("a refused sign-out keeps the account skin and a successful retry clears it", async ({
  app,
  browser,
  screen,
}) => {
  let signedOut = false;
  await browser.route(/\/api\/me$/, (route) =>
    signedOut ? route.fulfill({ status: 401, json: {} }) : route.continue(),
  );
  await browser.route(/\/api\/capabilities$/, async (route) => {
    const result = await (await route.fetch()).json<Record<string, unknown>>();
    return route.fulfill({ json: { ...result, localEvaluation: false } });
  });
  await browser.route(/\/api\/settings\/preferences$/, (route) =>
    route.fulfill({
      json: {
        preferences: { messageListEmphasis: "thread", skin: "openduet" },
      },
    }),
  );
  const attempts: string[] = [];
  await browser.route(/\/api\/auth\/sign-out$/, (route) => {
    attempts.push(route.request.method);
    if (attempts.length === 1)
      return route.fulfill({ status: 503, json: { error: "Try again" } });
    signedOut = true;
    return route.fulfill({ json: { success: true } });
  });
  await app.open("/");
  const html = browser.locator("html");
  await expect(html).toHaveAttribute("data-skin", "openduet");
  const menu = screen.getByRole("button", "Menu", { exact: true });
  await menu.click();
  const signOut = screen.getByRole("button", "Sign out", { exact: true });
  await signOut.click();
  await expect.poll(() => attempts).toEqual(["POST"]);
  await expect(signOut).toBeEnabled();
  const cached = () =>
    browser.evaluate(() => localStorage.getItem("openbot-skin"));
  expect(await cached()).toBe("openduet");
  await expect(html).toHaveAttribute("data-skin", "openduet");
  await signOut.click();
  await expect(browser).toHaveURL("/sign");
  await expect(screen.getByRole("heading", /^Sign in to /)).toBeVisible();
  await expect(html).not.toHaveAttribute("data-skin", /.+/);
  expect(await cached()).toBeNull();
  expect(attempts).toEqual(["POST", "POST"]);
});
