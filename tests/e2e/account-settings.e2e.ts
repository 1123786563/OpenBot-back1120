import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "../../shared/user-preferences";

const settings = "/settings";
const profilePath = /\/api\/me$/;
const profileError = "Could not save your profile.";
const nameRow = /^Name(?:\s|$)/;
const emphasisLabel = "Message list emphasis";
const settingsPreferences = /\/api\/settings\/preferences$/;

async function serveProfile(
  browser: Browser,
  { name = "Sam", needsName = false, failFirst = false } = {},
) {
  let profile = { name, needsName };
  const reads: (typeof profile)[] = [];
  const writes: { method: string; body: unknown }[] = [];
  await browser.route(profilePath, async (route) => {
    const response = await route.fetch();
    const data = await response.json<{
      user: { name: string; needsName: boolean };
    }>();
    reads.push(profile);
    return route.fulfill({
      json: { ...data, user: { ...data.user, ...profile } },
    });
  });
  await browser.route(/\/api\/me\/profile$/, (route) => {
    const body: { name: string } = JSON.parse(route.request.postData ?? "null");
    writes.push({ method: route.request.method, body });
    if (failFirst) {
      failFirst = false;
      return route.fulfill({ status: 500, json: { error: profileError } });
    }
    profile = { name: body.name, needsName: false };
    return route.fulfill({ json: { profile } });
  });
  return {
    reads,
    writes,
    update(name: string) {
      profile = { name, needsName: false };
    },
  };
}

test("saving a display name trims it, refetches the account and persists on reload", async ({
  app,
  browser,
  screen,
}) => {
  const { reads, writes } = await serveProfile(browser);
  await app.open(settings);
  const row = screen.getByRole("button", nameRow);
  await expect(row).toContainText("Sam");
  await row.click();
  const dialog = screen.getByRole("dialog", "Your name", { exact: true });
  const field = dialog.getByLabel("Name", { exact: true });
  await expect(field).toHaveValue("Sam");
  await field.fill("  Samuel  ");
  await dialog.getByRole("button", "Save name", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText("Samuel");
  expect(writes).toEqual([{ method: "PATCH", body: { name: "Samuel" } }]);
  expect(reads[0]).toEqual({ name: "Sam", needsName: false });
  expect(reads.at(-1)).toEqual({ name: "Samuel", needsName: false });
  await browser.reload();
  await expect(row).toContainText("Samuel");
});

test("a failed name save shows the server error and preserves the draft for retry", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveProfile(browser, { failFirst: true });
  await app.open(settings);
  const row = screen.getByRole("button", nameRow);
  await row.click();
  const dialog = screen.getByRole("dialog", "Your name", { exact: true });
  const name = dialog.getByLabel("Name", { exact: true });
  const save = dialog.getByRole("button", "Save name", { exact: true });
  await name.fill("Sam Julien");
  await save.click();
  const alert = dialog.getByRole("alert");
  await alert.getByRole("button", "Details", { exact: true }).click();
  await expect(alert).toContainText(profileError);
  await expect(name).toHaveValue("Sam Julien");
  await expect(save).toBeEnabled();
  const write = { method: "PATCH", body: { name: "Sam Julien" } };
  expect(writes).toEqual([write]);
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText("Sam Julien");
  expect(writes).toEqual([write, write]);
});

for (const draft of ["", "Sam Julien"]) {
  test(`an account refresh ${draft ? "preserves an edited name" : "fills an untouched name"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { reads, writes, update } = await serveProfile(browser, {
      needsName: !draft,
    });
    await app.open(settings);
    const row = screen.getByRole("button", nameRow);
    await expect(row).toContainText(draft ? "Sam" : "Not set yet.");
    await row.click();
    const dialog = screen.getByRole("dialog", "Your name", { exact: true });
    const name = dialog.getByLabel("Name", { exact: true });
    await expect(name).toHaveValue(draft ? "Sam" : "");
    if (draft) await name.fill(draft);
    update("Samuel");
    const readsBefore = reads.length;

    // Reconnect with an account read older than its one-minute freshness period.
    await browser.evaluate(() => {
      const now = Date.now;
      Date.now = () => now() + 61_000;
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
      return null;
    });
    await expect.poll(() => reads.length).toBeGreaterThan(readsBefore);
    await expect(
      browser.locator("button").filter({ hasText: /^Name\s*Samuel$/ }),
    ).toHaveCount(1);
    await expect(name).toHaveValue(draft || "Samuel");
    expect(writes).toEqual([]);
  });
}

async function servePreferences(
  browser: Browser,
  {
    initial,
    readError,
    holdWrite,
    refuseFirstWrite = false,
  }: {
    initial?: Partial<UserPreferences>;
    readError?: Promise<void>;
    holdWrite?: Promise<void>;
    refuseFirstWrite?: boolean;
  } = {},
) {
  let preferences: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    language: "en",
    messageListEmphasis: "agent",
    ...initial,
  };
  const reads: string[] = [];
  const writes: { method: string; body: unknown }[] = [];
  await browser.route(settingsPreferences, async (route) => {
    const method = route.request.method;
    if (method === "GET") {
      reads.push(new URL(route.request.url).pathname);
      if (readError) {
        await readError;
        return route.fulfill({
          status: 503,
          json: { error: "Storage unavailable" },
        });
      }
    } else {
      const body = JSON.parse(route.request.postData ?? "null");
      writes.push({ method, body });
      await holdWrite;
      if (refuseFirstWrite) {
        refuseFirstWrite = false;
        return route.fulfill({
          status: 500,
          json: { error: "Could not save" },
        });
      }
      preferences = { ...preferences, ...body };
    }
    return route.fulfill({ json: { preferences } });
  });
  return {
    reads,
    writes,
    recoverRead() {
      readError = undefined;
    },
  };
}

function previewEmphasis(browser: Browser) {
  return browser.evaluate(() => {
    const preview = document.querySelector(
      'figure[aria-label="Message list preview"]',
    );
    const bot = preview?.querySelector('[title="General Assistant"]');
    const thread = preview?.querySelector('[title="Plan next week"]');
    if (!bot || !thread) return 0;
    return (
      Number.parseFloat(getComputedStyle(bot).fontSize) -
      Number.parseFloat(getComputedStyle(thread).fontSize)
    );
  });
}

test("message list preferences disable editing until the account read succeeds", async ({
  app,
  browser,
  screen,
}) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const { reads, writes, recoverRead } = await servePreferences(browser, {
    readError: promise,
  });
  const choice = screen.getByRole("combobox", emphasisLabel, { exact: true });
  const preview = screen.getByRole("figure", "Message list preview", {
    exact: true,
  });
  try {
    await app.open(settings);
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    await expect(choice).toBeDisabled();
    await expect(choice).toHaveText("Loading…");
    await expect(preview).toHaveCount(0);
  } finally {
    resolve();
  }

  const alert = screen
    .getByRole("alert")
    .filter({ hasText: "Storage unavailable" });
  await alert.getByRole("button", "Details", { exact: true }).click();
  await expect(alert).toContainText("Storage unavailable");
  await expect(choice).toBeDisabled();
  await expect(preview).toHaveCount(0);
  expect(writes).toEqual([]);
  recoverRead();
  await screen.getByRole("button", "Try again", { exact: true }).click();
  await expect(choice).toBeEnabled();
  await expect(choice).toHaveText("Bot name");
  await expect(alert).toHaveCount(0);
  await expect.poll(() => previewEmphasis(browser)).toBeGreaterThan(0);
  expect(reads).toEqual([
    "/api/settings/preferences",
    "/api/settings/preferences",
    "/api/settings/preferences",
  ]);
  expect(writes).toEqual([]);
});

test("a refused message list preference restores the saved emphasis and can be retried", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await servePreferences(browser, {
    refuseFirstWrite: true,
  });
  await app.open(settings);
  const choice = screen.getByRole("combobox", emphasisLabel, { exact: true });
  const thread = screen.getByRole("option", "Conversation title", {
    exact: true,
  });
  await expect(choice).toHaveText("Bot name");
  await expect.poll(() => previewEmphasis(browser)).toBeGreaterThan(0);
  await choice.click();
  await thread.click();
  const alert = screen.getByRole("alert").filter({ hasText: "Could not save" });
  await alert.getByRole("button", "Details", { exact: true }).click();
  await expect(alert).toContainText("Could not save");
  await expect(choice).toHaveText("Bot name");
  await expect.poll(() => previewEmphasis(browser)).toBeGreaterThan(0);
  const write = { method: "PATCH", body: { messageListEmphasis: "thread" } };
  expect(writes).toEqual([write]);

  await choice.click();
  await thread.click();
  await expect(choice).toBeEnabled();
  await expect(choice).toHaveText("Conversation title");
  await expect(alert).toHaveCount(0);
  await expect.poll(() => previewEmphasis(browser)).toBeLessThan(0);
  await browser.reload();
  await expect(choice).toHaveText("Conversation title");
  await expect.poll(() => previewEmphasis(browser)).toBeLessThan(0);
  expect(writes).toEqual([write, write]);
});

const capabilityRoute = /\/api\/capabilities$/;
const bannerLabel = "Self-host OpenBot";
const dismissWrite = {
  method: "PATCH",
  body: { selfHostBannerDismissed: true },
};

async function serveBanner(browser: Browser, enabled = true) {
  await browser.route(capabilityRoute, async (route) => {
    const response = await route.fetch();
    const capabilities = await response.json<{ selfHostBanner: boolean }>();
    return route.fulfill({
      json: { ...capabilities, selfHostBanner: enabled },
    });
  });
}

for (const { enabled, dismissed, reason } of [
  { enabled: false, dismissed: false, reason: "the deployment disabled it" },
  {
    enabled: true,
    dismissed: true,
    reason: "the person previously dismissed it",
  },
]) {
  test(`the self-host banner stays hidden when ${reason}`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveBanner(browser, enabled);
    const { writes } = await servePreferences(browser, {
      initial: { selfHostBannerDismissed: dismissed },
    });
    const [capabilities, preferences] = await Promise.all([
      browser.waitForResponse(capabilityRoute),
      browser.waitForResponse(settingsPreferences),
      app.open("/"),
    ]);
    expect(await capabilities.json()).toMatchObject({
      selfHostBanner: enabled,
    });
    expect(await preferences.json()).toMatchObject({
      preferences: { selfHostBannerDismissed: dismissed },
    });
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();
    await expect(
      screen.getByRole("complementary", bannerLabel, { exact: true }),
    ).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}

for (const refuseFirstWrite of [false, true]) {
  test(`dismissing self-hosting help hides it immediately and ${refuseFirstWrite ? "restores it after a refusal" : "persists on reload"}`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveBanner(browser);
    const { promise, resolve } = Promise.withResolvers<void>();
    const { writes } = await servePreferences(browser, {
      holdWrite: promise,
      refuseFirstWrite,
    });
    const banner = screen.getByRole("complementary", bannerLabel, {
      exact: true,
    });
    await app.open("/");
    await expect(
      banner.getByText("Self-host OpenBot for your organization.", {
        exact: true,
      }),
    ).toBeVisible();
    const link = banner.getByRole("link", "Book a call", { exact: true });
    await expect(link).toHaveAttribute("href", "https://open.bot/business");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");

    const dismiss = banner.getByRole("button", "Dismiss", { exact: true });
    let result: Awaited<ReturnType<Browser["waitForResponse"]>>;
    try {
      await dismiss.click();
      await expect.poll(() => writes.length).toBe(1);
      await expect(banner).toHaveCount(0);
      const response = browser.waitForResponse(settingsPreferences);
      resolve();
      result = await response;
    } finally {
      resolve();
    }
    expect(writes).toEqual([dismissWrite]);
    if (refuseFirstWrite) {
      expect(result.status).toBe(500);
      await expect(banner).toBeVisible();
      const [retry] = await Promise.all([
        browser.waitForResponse(settingsPreferences),
        dismiss.click(),
      ]);
      expect(retry.status).toBe(200);
      expect(writes).toEqual([dismissWrite, dismissWrite]);
    } else {
      expect(result.status).toBe(200);
    }
    await browser.reload();
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();
    await expect(banner).toHaveCount(0);
  });
}
