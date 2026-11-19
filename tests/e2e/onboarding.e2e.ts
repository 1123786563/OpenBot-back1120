import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { serveOnboarding } from "./onboarding-fixture";

const nameStep = "/onboarding?step=name";
const finishedOrb = "[data-onboarding-finish] [data-orb]";
const frame = "[data-onboarding-frame]";

test("a placeholder profile starts with a blank name and cannot continue", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveOnboarding(browser);
  await browser.setViewport({ width: 1280, height: 850 });
  await app.open(nameStep);
  const field = screen.getByRole("textbox", "Name", { exact: true });
  const start = screen.getByRole("button", "Get started", { exact: true });
  const back = screen.getByRole("button", "Back", { exact: true });
  await expect(
    screen.getByRole("heading", "What should we call you?", { exact: true }),
  ).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(start).toBeDisabled();
  await expect(start).toHaveAttribute("type", "submit");
  await expect(back).toBeVisible();
  const placement = await browser.evaluate(() => {
    const back = document.querySelector('[data-onboarding-back="desktop"]');
    const submit = document.querySelector("[data-onboarding-primary]");
    if (!back || !submit) throw new Error("Missing onboarding controls");
    const first = back.getBoundingClientRect();
    const second = submit.getBoundingClientRect();
    return (
      first.right <= second.left &&
      Math.abs(first.top - second.top) <= 1 &&
      back.parentElement === submit.parentElement
    );
  });
  expect(placement).toBe(true);
  const orb = browser.locator(`${frame} [data-orb]`);
  await expect(orb).toHaveAttribute("data-orb", "openbot");
  await expect(orb).toHaveAttribute("data-state", "listening");
  await expect(browser.locator(finishedOrb)).toHaveCount(0);
  await field.fill("   ");
  await expect(start).toBeDisabled();
  expect(writes).toEqual([]);
});

test("the name step restores a previously saved display name", async ({
  app,
  browser,
  screen,
}) => {
  await serveOnboarding(browser, { name: "Sam" });
  await app.open("/tests/browser/onboarding.html?step=listening");
  await expect(
    screen.getByRole("textbox", "Name", { exact: true }),
  ).toHaveValue("Sam");
  await expect(
    screen.getByRole("button", "Get started", { exact: true }),
  ).toBeEnabled();
});

test("Get started saves the name before completion, plays the finish once, and opens Home", async ({
  app,
  browser,
  screen,
}) => {
  const allowProfile = Promise.withResolvers<void>();
  const allowCompletion = Promise.withResolvers<void>();
  const { writes } = await serveOnboarding(browser, {
    saveName: async () => {
      await allowProfile.promise;
      return undefined;
    },
    finish: async () => {
      await allowCompletion.promise;
      return undefined;
    },
  });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.setViewport({ width: 1000, height: 800 });
  try {
    await app.open(nameStep);
    const name = screen.getByRole("textbox", "Name", { exact: true });
    await expect(name).toBeVisible();
    await expect(
      screen.getByRole("button", "Continue", { exact: true }),
    ).toHaveCount(0);
    const pictureComesFirst = await browser.evaluate(() => {
      const picture = document.querySelector("[data-onboarding-demo]");
      const intro = document.querySelector("[data-onboarding-intro]");
      if (!picture || !intro) throw new Error("Missing the name step layout");
      return (
        picture.getBoundingClientRect().bottom <=
        intro.getBoundingClientRect().top
      );
    });
    expect(pictureComesFirst).toBe(true);
    await name.fill("  Sam  ");
    await screen.getByRole("button", "Get started", { exact: true }).tap();
    const saving = screen.getByRole("button", "Saving…", { exact: true });
    await expect(saving).toBeDisabled();
    await expect(name).toBeDisabled();
    await expect.poll(() => writes.slice()).toEqual([{ name: "Sam" }]);

    allowProfile.resolve();
    await expect
      .poll(() => writes.slice())
      .toEqual([{ name: "Sam" }, { completed: true }]);
    await expect(saving).toBeDisabled();
    await expect(browser.locator(finishedOrb)).toHaveCount(0);
    allowCompletion.resolve();

    const done = screen.getByRole("button", "All set", { exact: true });
    await expect(done).toBeEnabled();
    await expect(done).toHaveAttribute("data-done", "");
    await expect(browser.locator(finishedOrb)).toHaveAttribute(
      "data-state",
      "done",
    );
    await expect(
      browser.locator("[data-onboarding-primary][data-done] svg"),
    ).toBeVisible();
    await done.tap();
    await expect(browser).toHaveURL(/\/$/);
    await expect(browser.locator(frame)).toHaveCount(0);
    expect(writes).toEqual([{ name: "Sam" }, { completed: true }]);
    await browser.reload();
    await expect(browser).toHaveURL(/\/$/);
    await expect(browser.locator(frame)).toHaveCount(0);
  } finally {
    allowProfile.resolve();
    allowCompletion.resolve();
  }
});

for (const failing of ["profile", "completion"] as const) {
  test(`an onboarding ${failing} error keeps the draft and can be retried`, async ({
    app,
    browser,
    screen,
  }) => {
    let saveAttempts = 0;
    let finishAttempts = 0;
    const message =
      failing === "profile" ? "Save failed" : "Onboarding could not be saved";
    const { writes } = await serveOnboarding(browser, {
      saveName: async () =>
        ++saveAttempts === 1 && failing === "profile" ? message : undefined,
      finish: async () =>
        ++finishAttempts === 1 && failing === "completion"
          ? message
          : undefined,
    });
    await app.open(nameStep);
    const field = screen.getByRole("textbox", "Name", { exact: true });
    await field.fill("Sam");
    const start = screen.getByRole("button", "Get started", { exact: true });
    await start.tap();
    const alert = browser.locator(frame).getByRole("alert");
    await expect(alert).toBeVisible();
    await alert.getByRole("button", "Details", { exact: true }).tap();
    await expect(alert.getByText(message, { exact: true })).toBeVisible();
    await expect(field).toHaveValue("Sam");
    await expect(start).toBeEnabled();
    await expect(browser).toHaveURL(/\/onboarding\?step=name$/);
    expect(writes).toEqual(
      failing === "profile"
        ? [{ name: "Sam" }]
        : [{ name: "Sam" }, { completed: true }],
    );

    await start.tap();
    await expect(browser).toHaveURL(/\/$/);
    expect(writes.slice(-2)).toEqual([{ name: "Sam" }, { completed: true }]);
  });
}

test("an unfinished account is sent to Welcome and can retrace saved steps after reloading", async ({
  app,
  browser,
  screen,
}) => {
  const { savedSteps } = await serveOnboarding(browser, { step: 0 });
  await browser.setViewport({ width: 1000, height: 800 });
  await app.open("/bots");
  const welcome = screen.getByRole("heading", "Welcome to OpenBot", {
    exact: true,
  });
  const name = screen.getByRole("heading", "What should we call you?", {
    exact: true,
  });
  const progress = screen.getByRole("progressbar", "Onboarding progress", {
    exact: true,
  });
  await expect(welcome).toBeVisible();
  await expect(browser).toHaveURL(/\/onboarding\?step=welcome$/);
  await expect(
    screen.getByText(
      "Give work to Bots in plain words. They tell you when it's done.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuetext", "Step 1 of 2");
  await expect.poll(savedSteps).toEqual([1]);
  const entries = () => browser.evaluate(() => history.length);
  const before = await entries();

  await screen.getByRole("button", "Continue", { exact: true }).tap();
  await expect(browser).toHaveURL(/\/onboarding\?step=name$/);
  await expect(name).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuetext", "Step 2 of 2");
  await expect.poll(savedSteps).toEqual([1, 3]);
  expect(await entries()).toBe(before + 1);

  await browser.reload();
  await expect(name).toBeVisible();
  await screen.getByRole("button", "Back", { exact: true }).tap();
  await expect(welcome).toBeVisible();
  await expect(browser).toHaveURL(/\/onboarding\?step=welcome$/);
  await expect.poll(savedSteps).toEqual([1, 3, 1]);
  expect(await entries()).toBe(before + 1);

  await browser.forward();
  await expect(name).toBeVisible();
  await expect(browser).toHaveURL(/\/onboarding\?step=name$/);
  await expect.poll(savedSteps).toEqual([1, 3, 1, 3]);
  await browser.back();
  await expect(welcome).toBeVisible();
  await expect(browser).toHaveURL(/\/onboarding\?step=welcome$/);
});

for (const { title, path, stored, evaluateLocally, step, heading } of [
  {
    title: "an unknown step resolves to Welcome",
    path: "/onboarding?step=nonsense",
    stored: 0,
    evaluateLocally: false,
    step: 1,
    heading: "Welcome to OpenBot",
  },
  {
    title: "a bare link restores OpenBot for Business for an evaluator",
    path: "/onboarding",
    stored: 2,
    evaluateLocally: true,
    step: 2,
    heading: /OpenBot for Business/,
  },
  {
    title: "an organization skips a business step from a link",
    path: "/onboarding?step=selfhost",
    stored: 0,
    evaluateLocally: false,
    step: 3,
    heading: "What should we call you?",
  },
  {
    title: "an organization skips a business step from saved progress",
    path: "/onboarding",
    stored: 2,
    evaluateLocally: false,
    step: 3,
    heading: "What should we call you?",
  },
]) {
  test(title, async ({ app, browser, screen }) => {
    const { savedSteps } = await serveOnboarding(browser, {
      step: stored,
      evaluateLocally,
    });
    await browser.route(/https:\/\/calendly\.com\//, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<p>Booking fixture</p>",
      }),
    );
    await app.open(path);
    await expect(screen.getByRole("heading", heading)).toBeVisible();
    const stepId = ["welcome", "selfhost", "name"][step - 1];
    await expect(browser).toHaveURL(
      new RegExp(`/onboarding\\?step=${stepId}$`),
    );
    await expect.poll(savedSteps).toEqual(step === stored ? [] : [step]);
  });
}

test("Back from a direct name link replaces that history entry", async ({
  app,
  browser,
  screen,
}) => {
  const { savedSteps } = await serveOnboarding(browser);
  await app.open(nameStep);
  await expect(
    screen.getByRole("heading", "What should we call you?"),
  ).toBeVisible();
  const before = await browser.evaluate(() => history.length);
  await screen.getByRole("button", "Back", { exact: true }).tap();
  await expect(browser).toHaveURL(/\/onboarding\?step=welcome$/);
  await expect(screen.getByRole("heading", "Welcome to OpenBot")).toBeVisible();
  expect(await browser.evaluate(() => history.length)).toBe(before);
  await expect.poll(savedSteps).toEqual([1]);
});

test("a known organization name skips the name step and retries a failed finish from Welcome", async ({
  app,
  browser,
  screen,
}) => {
  let attempts = 0;
  const { writes } = await serveOnboarding(browser, {
    name: "Maya",
    step: 1,
    finish: async () =>
      ++attempts === 1 ? "Onboarding could not be saved" : undefined,
  });
  await browser.setViewport({ width: 1280, height: 850 });
  await app.open(nameStep);
  await expect(browser).toHaveURL(/\/onboarding\?step=welcome$/);
  await expect(screen.getByRole("heading", "Welcome to OpenBot")).toBeVisible();
  await expect(screen.getByRole("textbox", "Name")).toHaveCount(0);
  await expect(browser.locator("[data-onboarding-steps]")).toHaveCount(0);
  await expect(screen.getByRole("progressbar")).toHaveCount(0);
  await expect(
    screen.getByRole("button", "Continue", { exact: true }),
  ).toHaveCount(0);
  const start = screen.getByRole("button", "Get started", { exact: true });
  await start.tap();
  await expect(browser.locator(frame).getByRole("alert")).toHaveText(
    "Couldn't finish setting up. Try again.",
  );
  await expect(browser).toHaveURL(/\/onboarding\?step=welcome$/);
  expect(writes).toEqual([{ completed: true }]);

  await start.tap();
  await expect(browser).toHaveURL(/\/$/);
  await expect(browser.locator(frame)).toHaveCount(0);
  expect(writes).toEqual([{ completed: true }, { completed: true }]);
});

test("a fresh onboarding link adds Welcome to the URL without a second history entry", async ({
  app,
  browser,
  screen,
}) => {
  const { savedSteps } = await serveOnboarding(browser, { step: 0 });
  await browser.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        if (location.pathname === "/onboarding")
          performance.mark("onboarding-initial-entry", {
            detail: history.length,
          });
      },
      { once: true },
    );
  });
  await app.open("/onboarding");
  await expect(screen.getByRole("heading", "Welcome to OpenBot")).toBeVisible();
  await expect(browser).toHaveURL(/\/onboarding\?step=welcome$/);
  const entries = await browser.evaluate(() => {
    const start = performance.getEntriesByName("onboarding-initial-entry")[0] as
      | PerformanceMark
      | undefined;
    return {
      initial: Number(start?.detail ?? -1),
      current: window.history.length,
    };
  });
  expect(entries.initial).toBeGreaterThan(0);
  expect(entries.current).toBe(entries.initial);
  await expect.poll(savedSteps).toEqual([1]);
});

for (const evaluateLocally of [false, true]) {
  test(`the step list matches the current headings for ${evaluateLocally ? "an evaluator" : "an organization"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { savedSteps } = await serveOnboarding(browser, {
      step: 1,
      evaluateLocally,
    });
    await browser.setViewport({ width: 1280, height: 850 });
    await app.open("/onboarding?step=welcome");
    const titles = [
      "Welcome to OpenBot",
      ...(evaluateLocally ? ["OpenBot for Business"] : []),
      "What should we call you?",
    ];
    for (const [index, title] of titles.entries()) {
      const heading = screen.getByRole("heading", title, { exact: true });
      await expect(heading).toBeVisible();
      const trigger = screen.getByRole(
        "button",
        `Step ${index + 1} of ${titles.length}`,
        { exact: true },
      );
      await trigger.tap();
      const menu = screen.getByRole("navigation", "Onboarding steps", {
        exact: true,
      });
      await expect(menu.getByRole("listitem")).toHaveCount(titles.length);
      for (const entry of titles) {
        const displayed =
          entry === "OpenBot for Business" ? `${entry}™` : entry;
        await expect(menu.getByText(displayed, { exact: true })).toBeVisible();
      }
      const current = browser.locator(
        '[aria-label="Onboarding steps"] [aria-current="step"]',
      );
      await expect(current).toBeVisible();
      const label = (await current.textContent())
        ?.replace(/^\d+\s*/, "")
        .trim();
      expect(label ?? "").toBe((await heading.textContent())?.trim() ?? "");
      const nextTitle = titles[index + 1];
      if (nextTitle)
        await expect(
          menu.getByRole("button", new RegExp(nextTitle.replace("?", "\\?"))),
        ).toHaveCount(0);
      await trigger.press("Escape");
      await expect(menu).toHaveCount(0);
      if (nextTitle) {
        await screen
          .getByRole("button", index === 0 ? "Continue" : "Not now", {
            exact: true,
          })
          .tap();
      }
    }
    await expect.poll(savedSteps).toEqual(evaluateLocally ? [2, 3] : [3]);
  });
}

test("a desktop evaluator can revisit the two reached steps from its step list", async ({
  app,
  browser,
  screen,
}) => {
  await serveOnboarding(browser, { step: 2, evaluateLocally: true });
  await browser.setViewport({ width: 1280, height: 850 });
  await app.open("/onboarding?step=selfhost");
  const menu = screen.getByRole("navigation", "Onboarding steps", {
    exact: true,
  });
  await screen.getByRole("button", "Step 2 of 3", { exact: true }).tap();
  await expect(menu.getByRole("button", /What should we call you/)).toHaveCount(
    0,
  );
  await menu.getByRole("button", /Welcome to OpenBot/).tap();
  await expect(browser).toHaveURL(/\/onboarding\?step=welcome$/);
  await screen.getByRole("button", "Step 1 of 3", { exact: true }).tap();
  await menu.getByRole("button", /OpenBot for Business/).tap();
  await expect(browser).toHaveURL(/\/onboarding\?step=selfhost$/);
  await expect(
    screen.getByRole("heading", /OpenBot for Business/),
  ).toBeVisible();
});

test("Continue and Back focus the new heading and reset the scrollable picture pane", async ({
  app,
  browser,
  screen,
}) => {
  await serveOnboarding(browser, { step: 1 });
  await browser.setViewport({ width: 1280, height: 780 });
  await app.open("/onboarding?step=welcome");
  const start = screen.getByRole("heading", "Welcome to OpenBot", {
    exact: true,
  });
  const name = screen.getByRole("heading", "What should we call you?", {
    exact: true,
  });
  const scrollDemo = () =>
    browser.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(
        "[data-onboarding-demo]",
      );
      const picture = pane?.firstElementChild as HTMLElement | undefined;
      if (!pane || !picture) throw new Error("Missing the demo pane");
      picture.style.minHeight = `${pane.clientHeight + 300}px`;
      picture.style.flexShrink = "0";
      pane.scrollTop = 120;
      return pane.scrollTop;
    });
  const scrollPosition = () =>
    browser.evaluate(
      () => document.querySelector("[data-onboarding-demo]")?.scrollTop ?? -1,
    );
  await expect(start).toBeVisible();
  expect(await scrollDemo()).toBe(120);
  await screen.getByRole("button", "Continue", { exact: true }).tap();
  await expect(name).toBeFocused();
  expect(await scrollPosition()).toBe(0);
  expect(await scrollDemo()).toBe(120);
  await screen.getByRole("button", "Back", { exact: true }).tap();
  await expect(start).toBeFocused();
  expect(await scrollPosition()).toBe(0);
});
