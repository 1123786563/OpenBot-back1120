import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { serveOnboarding } from "./onboarding-fixture";

const welcome = "/onboarding?step=welcome";
const policies = '[aria-labelledby="onboarding-permissions"]';
const reel = "[data-intro-reel]";
const updatePath = /\/api\/approvals\/preferences$/;

test("Welcome explains Extra vigilant beside the illustration and saves the preference without advancing", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveOnboarding(browser, { step: 1 });
  const changes: { enabled: boolean }[] = [];
  let enabled = false;
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({ json: { enabled, rules: [], pending: [] } }),
  );
  await browser.route(updatePath, (route) => {
    expect(route.request.method).toBe("PATCH");
    const body = JSON.parse(route.request.postData ?? "null") as {
      enabled: boolean;
    };
    changes.push(body);
    enabled = body.enabled;
    return route.fulfill({ json: { enabled } });
  });

  await browser.setViewport({ width: 1280, height: 850 });
  await app.open(welcome);
  const preferences = screen.getByRole("region", "Choose when Bots ask", {
    exact: true,
  });
  await expect(
    preferences.getByRole("heading", "Choose when Bots ask", {
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  const always =
    "Bots ask before they delete, send, share, post, or pay in your apps or on websites.";
  const routine =
    "Require your approval for every change to your apps, websites, and files, including routine edits and updates.";
  const later = "You can change this anytime in Settings.";
  for (const text of [always, routine, later])
    await expect(preferences.getByText(text, { exact: true })).toBeVisible();
  const vigilant = preferences.getByRole("switch", "Extra vigilant", {
    exact: true,
  });
  await expect(vigilant).toBeEnabled();
  await expect(vigilant).toHaveAttribute("aria-checked", "false");
  await expect(browser.locator(`[data-onboarding-demo] ${reel}`)).toBeVisible();

  const ordered = await browser.evaluate(
    ({ policies, always, routine, later }) => {
      const section = document.querySelector(policies);
      const control = section?.querySelector('[role="switch"]');
      if (!section || !control)
        throw new Error("Missing the Extra vigilant control");
      const above = [...section.querySelectorAll("p")].find(
        (p) => p.textContent === always,
      );
      const below = [...section.querySelectorAll("p")].find(
        (p) => p.textContent === later,
      );
      return {
        inIntro: Boolean(control.closest("[data-onboarding-intro]")),
        inIllustration: Boolean(
          control.closest("[data-onboarding-demo], [inert]"),
        ),
        above: Boolean(
          above &&
            above.compareDocumentPosition(control) &
              Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        below: Boolean(
          below &&
            control.compareDocumentPosition(below) &
              Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        description:
          control
            .closest('[data-slot="item"]')
            ?.textContent?.includes(routine) ?? false,
      };
    },
    { policies, always, routine, later },
  );
  expect(ordered).toEqual({
    inIntro: true,
    inIllustration: false,
    above: true,
    below: true,
    description: true,
  });
  for (const detail of [/payments/, /own workspace/, /always wait for you/])
    await expect(screen.getByText(detail)).toHaveCount(0);
  await expect(
    screen.getByText(
      "Give work to Bots in plain words. They tell you when it's done.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(screen.getByText(/Hand work to Bots/)).toHaveCount(0);

  await vigilant.tap();
  await expect.poll(() => changes.slice()).toEqual([{ enabled: true }]);
  await expect(vigilant).toHaveAttribute("aria-checked", "true");
  await expect(browser).toHaveURL(/\/onboarding\?step=welcome$/);
  expect(writes).toEqual([]);
  await browser.reload();
  await expect(vigilant).toHaveAttribute("aria-checked", "true");
  expect(changes).toEqual([{ enabled: true }]);
});

for (const computer of [false, true]) {
  test(`the Welcome reel shows ${computer ? "all three scenes when a Bot computer is ready" : "only the relevant scenes without a Bot computer"}`, async ({
    app,
    browser,
  }) => {
    await serveOnboarding(browser, { step: 1 });
    await browser.route(/\/api\/setup$/, (route) =>
      route.fulfill({
        json: {
          checklist: {
            audience: computer ? "admin" : "member",
            rows: [
              {
                id: "computer",
                scope: "deployment",
                title: "Bot computer",
                required: false,
                status: computer ? "ready" : "needs_setup",
                ready: computer,
                detail: "Your admin sets this up.",
                fix: null,
              },
            ],
          },
        },
      }),
    );
    const response = browser.waitForResponse(/\/api\/setup$/);
    await app.open(welcome);
    await response;
    await expect(
      browser.locator(`${reel} [data-scene="welcome"]`),
    ).toBeVisible();
    await expect(
      browser
        .locator(reel)
        .getByText(
          "Ask in plain words. A Bot does the work and tells you when it's done.",
          { exact: true },
        ),
    ).toBeVisible();
    await expect(
      browser.locator(`${reel} :is(button, a, input, textarea, [tabindex])`),
    ).toHaveCount(0);
    await expect(browser.locator(`${reel} > [aria-hidden] > span`)).toHaveCount(
      computer ? 3 : 2,
    );
    const computerScene = browser.locator(`${reel} [data-scene="computer"]`);
    if (computer) {
      await expect(computerScene).toBeVisible();
      await expect(
        computerScene.getByText(
          "Bots use a browser and files of their own, apart from yours.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(browser.locator(reel)).not.toContainText(
        /its own computer/i,
      );
    } else {
      await expect(computerScene).toHaveCount(0);
    }
  });
}

test("Welcome waits for deployment setup and offers a retry when the request fails", async ({
  app,
  browser,
  screen,
}) => {
  const capabilities = Promise.withResolvers<void>();
  let unavailable = true;
  let attempts = 0;
  await serveOnboarding(browser, {
    step: 1,
    beforeCapabilities: async () => {
      attempts += 1;
      await capabilities.promise;
      return unavailable ? "unavailable" : undefined;
    },
  });
  try {
    await app.open(welcome);
    const next = screen.getByRole("button", "Continue", { exact: true });
    const warning = screen.getByText(
      "Couldn't load your setup. Try again to continue.",
      { exact: true },
    );
    await expect(next).toBeDisabled();
    await expect(warning).toHaveCount(0);
    capabilities.resolve();
    await expect(warning).toHaveAttribute("role", "alert");
    await expect(next).toBeDisabled();
    const before = attempts;

    unavailable = false;
    await screen.getByRole("button", "Try again", { exact: true }).tap();
    await expect(next).toBeEnabled();
    expect(attempts).toBeGreaterThan(before);
    await expect(warning).toHaveCount(0);
    await next.tap();
    await expect(browser).toHaveURL(/\/onboarding\?step=name$/);
  } finally {
    capabilities.resolve();
  }
});

test("a direct Business link waits for setup without showing the Welcome step", async ({
  app,
  browser,
  screen,
}) => {
  const capabilities = Promise.withResolvers<void>();
  await serveOnboarding(browser, {
    step: 0,
    evaluateLocally: true,
    beforeCapabilities: async () => {
      await capabilities.promise;
      return undefined;
    },
  });
  try {
    await app.open("/onboarding?step=selfhost");
    const first = screen.getByRole("heading", "Welcome to OpenBot", {
      exact: true,
    });
    const business = screen.getByRole("heading", /OpenBot for Business/);
    await expect(first).toHaveCount(0);
    await expect(business).toHaveCount(0);
    await expect(browser).toHaveURL(/\/onboarding\?step=selfhost$/);
    capabilities.resolve();
    await expect(business).toBeVisible();
    await expect(first).toHaveCount(0);
  } finally {
    capabilities.resolve();
  }
});
