import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const themes = ["light", "dark"] as const;
const release = "1.0.1";
const internal = "1.0.1-internal.1008.g6e5f485bc71c";
const widths = [650, 370];
const shotDirectory = process.env.OPENBOT_APP_SHOTS;
const notice =
  "OpenBot couldn't find a microphone. Connect one, then try again.";

type Offer = {
  version: string;
  current: string;
  installing: { downloaded: number; total: number; restarting: boolean } | null;
  updatesItself: boolean;
  ready:
    | { state: "preparing"; done: number; total: number }
    | { state: "ready" }
    | null;
};

function updateStates(version: string) {
  const offer = (
    ready: Offer["ready"],
    installing: Offer["installing"] = null,
  ): Offer => ({
    version,
    current: "1.0.0",
    installing,
    updatesItself: true,
    ready,
  });
  return [
    { name: "available", offer: offer(null), text: "is available" },
    {
      name: "downloading",
      offer: offer({ state: "preparing", done: 40, total: 100 }),
      text: "(40%)",
    },
    {
      name: "almost",
      offer: offer({ state: "preparing", done: 99, total: 100 }),
      text: "(99%)",
    },
    {
      name: "ready",
      offer: offer({ state: "ready" }),
      text: "ready to install",
    },
    {
      name: "installing",
      offer: offer(
        { state: "ready" },
        { downloaded: 50, total: 200, restarting: false },
      ),
      text: "Downloading… 25%",
    },
  ];
}

async function applyOffer(browser: Browser, offer: Offer) {
  await browser.evaluate(async (offer) => {
    const shell = window as Window & {
      __show?: (offer: unknown) => Promise<void>;
    };
    if (!shell.__show)
      throw new Error("The desktop update fixture did not start");
    await shell.__show(offer);
    return null;
  }, offer);
}

function bannerLayout(browser: Browser) {
  return browser.evaluate(async () => {
    await document.fonts.ready;
    const banner = document.querySelector('[aria-label="OpenBot update"]');
    const page = document.querySelector("[data-below]");
    const message = banner?.querySelector("p");
    if (!banner || !page || !message)
      throw new Error("Missing update banner layout");
    return {
      bannerHeight: banner.getBoundingClientRect().height,
      pageTop: page.getBoundingClientRect().top,
      clipped: message.scrollWidth > message.clientWidth,
      fullText: message.textContent,
      title: message.title,
    };
  });
}

async function saveScreenshot(path: string, name: string) {
  if (!shotDirectory) return;
  await mkdir(shotDirectory, { recursive: true });
  await copyFile(path, join(shotDirectory, `${name}.png`));
}

for (const width of widths) {
  for (const version of [release, internal]) {
    test(`the update banner keeps the page steady at ${width}px for ${version}`, async ({
      app,
      browser,
      screen,
    }) => {
      await browser.setViewport({ width: Math.max(width, 400), height: 300 });
      await app.open(`/tests/browser/update-banner-layout.html?width=${width}`);
      await expect(
        screen.getByRole("heading", "Start a conversation"),
      ).toBeVisible();
      const banner = screen.getByRole("complementary", "OpenBot update");
      const measurements: [number, number][] = [];
      for (const state of updateStates(version)) {
        await applyOffer(browser, state.offer);
        await expect(banner).toContainText(state.text);
        const measured = await bannerLayout(browser);
        expect(measured.bannerHeight).toBeGreaterThan(0);
        expect(measured.pageTop).toBeGreaterThan(0);
        expect(measured.title).toBe(measured.fullText);
        if (width === 650 && version === release)
          expect(measured.clipped).toBe(false);
        measurements.push([measured.bannerHeight, measured.pageTop]);
      }
      expect(measurements).toEqual(measurements.map(() => measurements[0]));
    });
  }
}

if (shotDirectory) {
  test("captures release and internal update progress in both themes", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width: 650, height: 300 });
    for (const theme of themes) {
      await app.open(
        `/tests/browser/update-banner-layout.html?width=650&theme=${theme}`,
      );
      await expect(
        screen.getByRole("heading", "Start a conversation"),
      ).toBeVisible();
      const banner = screen.getByRole("complementary", "OpenBot update");
      for (const [label, version] of [
        ["release", release],
        ["internal", internal],
      ]) {
        for (const state of updateStates(version)) {
          await applyOffer(browser, state.offer);
          await expect(banner).toContainText(state.text);
          const name = `update-banner-${label}-${state.name}-${theme}`;
          await saveScreenshot(await app.screenshot(name), name);
        }
      }
    }
  });
}

async function emulateDesktop(browser: Browser) {
  await browser.setViewport({ width: 1000, height: 760 });
  await browser.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    });
  });
}

function dictationLayout(browser: Browser) {
  return browser.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    const rect = (element: Element | null | undefined) => {
      if (!element) return null;
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    const box = rect(document.querySelector('form[data-slot="composer"]'));
    if (!box) throw new Error("Missing the message box");
    const hint = [...document.querySelectorAll("p")].find((p) =>
      p.textContent?.startsWith("OpenBot picks the right Bot"),
    );
    return {
      box,
      notice: rect(document.querySelector('[role="alert"]')),
      greeting: rect(document.querySelector("h1")),
      tasks: rect(document.querySelector('[aria-label="Starter tasks"]')),
      hint: rect(hint),
    };
  });
}

for (const chips of [false, true]) {
  for (const theme of themes) {
    const label = `home${chips ? "-tasks" : ""}-${theme}`;
    test(`the microphone notice leaves the Home composer fixed (${label})`, async ({
      app,
      browser,
      screen,
    }) => {
      await emulateDesktop(browser);
      await app.open(
        `/tests/browser/composer-dictation-notice.html?layout=home&theme=${theme}&chips=${Number(chips)}`,
      );
      const dictate = screen.getByRole("button", "Dictate a message", {
        exact: true,
      });
      await expect(dictate).toBeVisible();
      const tasks = screen.getByRole("region", "Starter tasks", {
        exact: true,
      });
      await expect(tasks).toHaveCount(chips ? 1 : 0);
      const before = await dictationLayout(browser);
      if (shotDirectory)
        await saveScreenshot(
          await app.screenshot(`${label}-idle`),
          `${label}-idle`,
        );
      await dictate.tap();
      await expect(screen.getByRole("alert")).toHaveText(notice);
      const after = await dictationLayout(browser);
      if (shotDirectory)
        await saveScreenshot(
          await app.screenshot(`${label}-notice`),
          `${label}-notice`,
        );
      expect(after.box).toEqual(before.box);
      const above = after.tasks ?? after.greeting;
      if (!after.notice || !above || !after.hint)
        throw new Error("Missing Home layout");
      expect(after.notice.top).toBeGreaterThanOrEqual(above.bottom);
      expect(after.notice.top).toBeGreaterThanOrEqual(
        after.greeting?.bottom ?? above.bottom,
      );
      expect(after.notice.bottom).toBeLessThanOrEqual(after.box.top);
      expect(after.notice.bottom).toBeLessThanOrEqual(after.hint.top);
    });
  }
}

test("the microphone notice grows above the pinned conversation composer", async ({
  app,
  browser,
  screen,
}) => {
  await emulateDesktop(browser);
  await app.open("/tests/browser/composer-dictation-notice.html?layout=thread");
  const dictate = screen.getByRole("button", "Dictate a message", {
    exact: true,
  });
  await expect(dictate).toBeVisible();
  const before = await dictationLayout(browser);
  await dictate.tap();
  await expect(screen.getByRole("alert")).toHaveText(notice);
  const after = await dictationLayout(browser);
  expect(after.box).toEqual(before.box);
  if (!after.notice)
    throw new Error("Missing the conversation's microphone notice");
  expect(after.notice.top).toBeLessThan(after.box.top);
});

const updateFixture = "/tests/browser/update-banner-layout.html";
const readOffer = "plugin:openbot-desktop|update_offer";

function updateTraffic(browser: Browser) {
  return browser.evaluate(() => {
    const page = window as Window & {
      __updateCalls?: { command: string; args?: Record<string, string> }[];
    };
    return {
      calls: (page.__updateCalls ?? []).map(({ command, args }) => ({
        command,
        args: args ?? null,
      })),
      fetches: performance
        .getEntriesByType("resource")
        .filter((entry) =>
          ["fetch", "xmlhttprequest"].includes(
            (entry as PerformanceResourceTiming).initiatorType,
          ),
        )
        .map((entry) => entry.name),
    };
  });
}

test("Desktop offers an update, remembers dismissal across reload, and offers a newer version", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${updateFixture}?version=1.0.1`);
  const banner = screen.getByRole("complementary", "OpenBot update");
  const install = screen.getByRole("button", "Update and restart", {
    exact: true,
  });
  const dismiss = screen.getByRole("button", "Dismiss", { exact: true });
  await expect(banner).toContainText("OpenBot 1.0.1 is available.");
  await expect(install).toBeVisible();
  await expect(dismiss).toBeVisible();
  expect(await updateTraffic(browser)).toEqual({
    calls: [{ command: readOffer, args: null }],
    fetches: [],
  });

  const [available, downloading, , ready] = updateStates(release);
  await applyOffer(browser, downloading.offer);
  await expect(banner).toContainText(
    "OpenBot 1.0.1 is downloading in the background (40%).",
  );
  await expect(install).toBeVisible();
  await applyOffer(browser, ready.offer);
  await expect(banner).toContainText(
    "OpenBot 1.0.1 is ready to install. It takes a few minutes.",
  );
  await expect(install).toBeVisible();
  await dismiss.tap();
  await expect(banner).toHaveCount(0);
  const traffic = await updateTraffic(browser);
  const dismissCommand = "plugin:openbot-desktop|dismiss_update";
  expect(
    traffic.calls.filter(({ command }) => command === dismissCommand),
  ).toEqual([
    {
      command: dismissCommand,
      args: { version: release },
    },
  ]);
  expect(traffic.fetches).toEqual([]);

  await browser.reload();
  await expect
    .poll(async () => (await updateTraffic(browser)).calls)
    .toEqual([{ command: readOffer, args: null }]);
  await expect(banner).toHaveCount(0);
  await applyOffer(browser, { ...available.offer, version: "1.0.2" });
  await expect(banner).toContainText("OpenBot 1.0.2 is available.");
});

test("Desktop replaces update actions with download and restart progress after installation starts", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${updateFixture}?version=1.0.1`);
  const install = screen.getByRole("button", "Update and restart", {
    exact: true,
  });
  await install.tap();
  const progress = screen.getByRole("status");
  await expect(progress).toHaveText("Downloading…");
  await expect(install).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Dismiss", { exact: true }),
  ).toHaveCount(0);
  const installCommand = "plugin:openbot-desktop|install_update";
  expect(
    (await updateTraffic(browser)).calls.filter(
      ({ command }) => command === installCommand,
    ),
  ).toEqual([
    {
      command: installCommand,
      args: null,
    },
  ]);
  const installing = updateStates(release).find(
    (state) => state.name === "installing",
  );
  if (!installing) throw new Error("Missing install progress");
  await applyOffer(browser, installing.offer);
  await expect(progress).toHaveText("Downloading… 25%");
  await applyOffer(browser, {
    ...installing.offer,
    installing: { downloaded: 200, total: 200, restarting: true },
  });
  await expect(progress).toHaveText("Restarting…");
});

test("Desktop reports a failed installation and leaves a retry available", async ({
  app,
  screen,
}) => {
  await app.open(`${updateFixture}?version=1.0.1&install=fail`);
  const install = screen.getByRole("button", "Update and restart", {
    exact: true,
  });
  await install.tap();
  await expect(screen.getByRole("alert")).toHaveText(
    "Couldn't install the update: signature verification failed",
  );
  await expect(install).toBeEnabled();
});

for (const { mode, path, offers } of [
  { mode: "with no newer version", path: "", offers: 1 },
  { mode: "with an older shell", path: "?shell=old&version=1.0.1", offers: 1 },
  {
    mode: "in a self-hosted browser",
    path: "?shell=web&version=1.0.1",
    offers: 0,
  },
]) {
  test(`the update banner stays absent ${mode}`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(`${updateFixture}${path}`);
    await expect(
      screen.getByRole("heading", "Start a conversation"),
    ).toBeVisible();
    if (offers) {
      await expect
        .poll(async () => (await updateTraffic(browser)).calls.length)
        .toBe(offers);
    }
    await expect(
      screen.getByRole("complementary", "OpenBot update"),
    ).toHaveCount(0);
    expect(await updateTraffic(browser)).toEqual({
      calls: Array.from({ length: offers }, () => ({
        command: readOffer,
        args: null,
      })),
      fetches: [],
    });
  });
}
