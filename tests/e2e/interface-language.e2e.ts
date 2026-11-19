import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "../../shared/user-preferences";

const prefs = "/api/settings/preferences";
const storageKey = "openbot.interface-language";
const localeFixture = "/tests/browser/interface-language.html";
const name = "Maya Chen";
const unsynced = "语言尚未同步到其他设备。";
const zh = { method: "PATCH", body: { language: "zh-CN" } };
const originalError = "Vendor original English error";

async function serveLanguage(
  browser: Browser,
  {
    staleRead,
    refuseFirstWrite = false,
  }: { staleRead?: Promise<void>; refuseFirstWrite?: boolean } = {},
) {
  let signedOut = false;
  let preferences: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    language: "en",
  };
  const writes: { method: string; body: unknown }[] = [];
  const signOuts: string[] = [];
  const reads: string[] = [];
  await browser.addInitScript((key) => {
    if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
    const marker = `${key}.browser-test`;
    if (sessionStorage.getItem(marker)) return;
    localStorage.setItem(key, "en");
    sessionStorage.setItem(marker, "true");
  }, storageKey);
  await browser.route(/\/api\/me$/, (route) =>
    signedOut
      ? route.fulfill({ status: 401, json: {} })
      : route.fulfill({
          json: {
            user: {
              id: "language-person",
              email: "language@example.test",
              name,
              role: "admin",
              onboarding: null,
            },
          },
        }),
  );
  await browser.route(/\/api\/settings\/preferences$/, async (route) => {
    const { method } = route.request;
    if (method === "GET") {
      const snapshot = preferences;
      reads.push(snapshot.language ?? "system");
      if (staleRead && reads.length === 1) {
        await staleRead;
        // The browser may have cancelled this read before the delayed response arrives.
        await route
          .fulfill({ json: { preferences: snapshot } })
          .catch(() => {});
        return;
      }
      return route.fulfill({ json: { preferences } });
    }
    const body = JSON.parse(route.request.postData ?? "null");
    writes.push({ method, body });
    if (refuseFirstWrite) {
      refuseFirstWrite = false;
      return route.fulfill({
        status: 503,
        json: { error: originalError, code: "unavailable" },
      });
    }
    preferences = { ...preferences, ...body };
    return route.fulfill({ json: { preferences } });
  });
  await browser.route(/\/api\/auth\/sign-out$/, (route) => {
    signOuts.push(route.request.method);
    signedOut = true;
    return route.fulfill({ json: { success: true } });
  });
  if (process.env.OPENBOT_E2E_SUITE !== "personal") {
    await browser.route(/\/api\/capabilities$/, async (route) => {
      const response = await route.fetch();
      const capabilities = await response.json<{ localEvaluation: boolean }>();
      return route.fulfill({
        json: { ...capabilities, localEvaluation: false },
      });
    });
  }
  return { reads, writes, signOuts };
}

test("a delayed account read is cancelled when the Settings language is changed", async ({
  app,
  browser,
  screen,
}) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const { reads, writes } = await serveLanguage(browser, {
    staleRead: promise,
  });
  await browser.addInitScript((path) => {
    const original = window.fetch;
    window.fetch = Object.assign(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : input,
          location.origin,
        );
        if (url.pathname === path && (options?.method ?? "GET") === "GET") {
          options?.signal?.addEventListener(
            "abort",
            () => {
              document.documentElement.setAttribute(
                "data-stale-preferences-cancelled",
                "true",
              );
            },
            { once: true },
          );
        }
        return original.call(window, input, options);
      },
      { preconnect: original.preconnect },
    );
  }, prefs);
  try {
    await app.open("/settings");
    await expect.poll(() => reads.length).toBe(1);
    await screen
      .getByRole("combobox", "Language", { exact: true })
      .selectOption({ value: "zh-CN" });
    const language = screen.getByRole("combobox", "语言", { exact: true });
    await expect(language).toHaveValue("zh-CN");
    await expect(language).toBeEnabled();
    await expect(browser.locator("html")).toHaveAttribute(
      "data-stale-preferences-cancelled",
      "true",
    );
    expect(writes).toEqual([zh]);
    resolve();
    await expect(
      screen.getByRole("heading", "关于你", { exact: true }),
    ).toBeVisible();
    await expect(language).toHaveValue("zh-CN");
  } finally {
    resolve();
  }
  await browser.reload();
  await expect(
    screen.getByRole("combobox", "语言", { exact: true }),
  ).toHaveValue("zh-CN");
  expect(reads.at(-1)).toBe("zh-CN");
  expect(writes).toEqual([zh]);
});

test("language save failure preserves a mounted form draft while retry syncs the account", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveLanguage(browser, { refuseFirstWrite: true });
  await app.open(localeFixture);
  const field = screen.getByRole("textbox");
  await field.fill("Unsaved English text");
  await browser.evaluate(() => {
    document
      .querySelector("form input")
      ?.setAttribute("data-original-field", "true");
    return null;
  });
  const original = browser.locator("form input[data-original-field]");
  await screen
    .getByRole("combobox", "Language", { exact: true })
    .selectOption({ value: "zh-CN" });
  const alert = screen.getByRole("alert");
  await expect(alert).toContainText(unsynced);
  const language = screen.getByRole("combobox", "语言", { exact: true });
  await expect(language).toHaveValue("zh-CN");
  await expect(original).toHaveValue("Unsaved English text");
  expect(writes).toEqual([zh]);
  await alert.getByRole("button", "重试", { exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(language).toHaveValue("zh-CN");
  await expect(original).toHaveValue("Unsaved English text");
  expect(writes).toEqual([zh, zh]);
  await browser.reload();
  await expect(language).toHaveValue("zh-CN");
});

test("translated settings errors keep the original details collapsed until opened", async ({
  app,
  browser,
  screen,
}) => {
  await serveLanguage(browser);
  await browser.route(/\/api\/me\/profile$/, (route) =>
    route.fulfill({
      status: 503,
      json: { error: originalError, code: "unavailable" },
    }),
  );
  await app.open("/settings");
  await expect(
    screen.getByRole("combobox", "Language", { exact: true }),
  ).toHaveValue("en");
  await screen
    .getByRole("combobox", "Language", { exact: true })
    .selectOption({ value: "zh-CN" });
  await expect(
    screen.getByRole("heading", "关于你", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", /^姓名/).click();
  const dialog = screen.getByRole("dialog", "你的姓名", { exact: true });
  await dialog.getByRole("textbox", "姓名", { exact: true }).fill("Maya");
  await dialog.getByRole("button", "保存姓名", { exact: true }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("服务暂时不可用");
  const details = alert.getByRole("button", "详情", { exact: true });
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(browser.locator("[data-error-detail][hidden]")).toContainText(
    originalError,
  );
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(alert.getByText(originalError, { exact: true })).toBeVisible();
});

if (process.env.OPENBOT_E2E_SUITE !== "personal") {
  test("signing out restores the browser language after the account chose Chinese", async ({
    app,
    browser,
    screen,
  }) => {
    const { writes, signOuts } = await serveLanguage(browser);
    await app.open("/settings");
    await expect(
      screen.getByRole("combobox", "Language", { exact: true }),
    ).toHaveValue("en");
    await screen
      .getByRole("combobox", "Language", { exact: true })
      .selectOption({ value: "zh-CN" });
    await expect(
      screen.getByRole("combobox", "语言", { exact: true }),
    ).toBeEnabled();
    await expect(
      screen.getByRole("heading", "关于你", { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([zh]);

    await screen.getByRole("link", "返回应用", { exact: true }).click();
    const account = browser
      .locator('[data-sidebar="footer"]')
      .getByRole("button", new RegExp(name));
    await account.click();
    await screen.getByRole("menuitem", "退出登录", { exact: true }).click();
    await expect(browser).toHaveURL("/sign");
    await expect(screen.getByRole("heading", /^Sign in to /)).toBeVisible();
    await expect(
      screen.getByRole("combobox", "Language", { exact: true }),
    ).toHaveValue("en");
    expect(
      await browser.evaluate((key) => localStorage.getItem(key), storageKey),
    ).toBe("en");
    expect(signOuts).toEqual(["POST"]);
    expect(writes).toEqual([zh]);
  });
}
