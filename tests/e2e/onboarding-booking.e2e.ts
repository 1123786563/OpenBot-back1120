import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { serveOnboarding } from "./onboarding-fixture";

const calendarPath =
  /^https:\/\/calendly\.com\/d\/dwfr-k64-8d2\/openbot-for-business\?/;
const businessUrl = "https://open.bot/business";
const calendarFrame = 'iframe[title="Booking calendar"]';
const illustration = '[data-demo="self-host"]';
const businessStep = "/onboarding?step=selfhost";
const businessPage = /\/onboarding\?step=selfhost$/;
const namePage = /\/onboarding\?step=name$/;
const calendarFixture = `<!doctype html>
<html lang="en">
  <button type="button" id="booking">Confirm fixture booking</button>
  <script>
    const send = (event, payload = {}) => parent.postMessage({ event, payload }, "*");
    send("calendly.page_height", { height: "520px" });
    document.querySelector("#booking").onclick = () => send("calendly.event_scheduled");
  </script>
</html>`;

function serveCalendar(browser: Browser, ready?: Promise<unknown>) {
  return browser.route(calendarPath, async (route) => {
    await ready;
    return route.fulfill({ contentType: "text/html", body: calendarFixture });
  });
}

async function verifyCalendarSrc(browser: Browser) {
  const url = await browser.evaluate((selector) => {
    const iframe = document.querySelector<HTMLIFrameElement>(selector);
    if (!iframe) throw new Error("Missing the booking calendar");
    return { source: iframe.src, host: location.host };
  }, calendarFrame);
  expect(url.source).toMatch(calendarPath);
  const params = new URL(url.source).searchParams;
  expect(params.get("embed_domain")).toBe(url.host);
  expect(params.get("embed_type")).toBe("Inline");
  expect(params.get("hide_event_type_details")).toBe("1");
  expect(params.get("hide_gdpr_banner")).toBe("1");
  for (const key of ["background_color", "text_color", "primary_color"])
    expect(params.get(key)).toMatch(/^[0-9a-f]{6}$/);
}

test("an evaluator can open the calendar from Welcome and skip it without opening a tab", async ({
  app,
  browser,
  screen,
}) => {
  const { savedSteps, writes } = await serveOnboarding(browser, {
    step: 1,
    evaluateLocally: true,
  });
  const response = Promise.withResolvers<void>();
  await serveCalendar(browser, response.promise);
  await app.open("/onboarding?step=welcome");
  const tabs = browser.tabs().length;
  await screen.getByRole("button", "Continue", { exact: true }).tap();
  await expect(browser).toHaveURL(businessPage);
  await expect(
    screen.getByRole("heading", /OpenBot for Business/),
  ).toBeVisible();
  await expect(browser.locator(illustration)).toBeVisible();
  await expect(browser.locator(calendarFrame)).toHaveCount(0);
  const skip = screen.getByRole("button", "Not now", { exact: true });
  await expect(skip).toBeVisible();
  await screen.getByRole("button", "Book a demo", { exact: true }).tap();
  try {
    await expect(
      screen.getByRole("status").getByText("Loading the calendar"),
    ).toBeAttached();
    await verifyCalendarSrc(browser);
    await expect(browser.locator(illustration)).toHaveCount(0);
    await expect(browser.locator("[data-onboarding-primary]")).toHaveCount(0);
    await expect(skip).toBeVisible();
    response.resolve();
    await expect(browser.locator("[data-booking-calendar]")).toHaveAttribute(
      "data-ready",
      "",
    );
    await expect
      .poll(() =>
        browser.evaluate(
          (selector) =>
            document.querySelector(selector)?.getBoundingClientRect().height ??
            0,
          calendarFrame,
        ),
      )
      .toBe(520);
    await skip.tap();
    await expect(browser).toHaveURL(namePage);
    await expect.poll(savedSteps).toEqual([2, 3]);
    expect(writes.some((write) => "completed" in write)).toBe(false);
    expect(browser.tabs()).toHaveLength(tabs);
  } finally {
    response.resolve();
  }
});

test("only the embedded Calendly frame can replace Not now with Continue", async ({
  app,
  browser,
  screen,
}) => {
  const { savedSteps, writes } = await serveOnboarding(browser, {
    step: 2,
    evaluateLocally: true,
  });
  await serveCalendar(browser);
  await app.open(businessStep);
  await screen.getByRole("button", "Book a demo", { exact: true }).tap();
  const confirm = browser
    .frameLocator(calendarFrame)
    .getByRole("button", "Confirm fixture booking", { exact: true });
  await expect(confirm).toBeVisible();
  await expect(browser.locator("[data-booking-calendar]")).toHaveAttribute(
    "data-ready",
    "",
  );
  await browser.evaluate((selector) => {
    const iframe = document.querySelector<HTMLIFrameElement>(selector);
    if (!iframe?.contentWindow) throw new Error("Missing the calendar window");
    const data = { event: "calendly.event_scheduled", payload: {} };
    dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: location.origin,
        source: iframe.contentWindow,
      }),
    );
    dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: "https://calendly.com",
        source: window,
      }),
    );
    return null;
  }, calendarFrame);
  const skip = screen.getByRole("button", "Not now", { exact: true });
  const proceed = screen.getByRole("button", "Continue", { exact: true });
  await expect(skip).toBeVisible();
  await expect(proceed).toHaveCount(0);
  await confirm.tap();
  await expect(proceed).toBeVisible();
  await expect(skip).toHaveCount(0);
  await expect(browser.locator("[data-onboarding-secondary-slot]")).toHaveCount(
    0,
  );
  await expect(browser).toHaveURL(businessPage);
  expect(writes.some((write) => "completed" in write)).toBe(false);
  await proceed.tap();
  await expect(browser).toHaveURL(namePage);
  await expect.poll(savedSteps).toEqual([3]);
});

for (const knownName of [false, true]) {
  test(`a calendar error opens the business page separately and ${knownName ? "finishes onboarding" : "continues to the name"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveOnboarding(browser, {
      name: knownName ? "Maya" : undefined,
      step: 2,
      evaluateLocally: true,
    });
    await serveCalendar(browser);
    await browser.route(businessUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>OpenBot Business fixture</title>",
      }),
    );
    await app.open(businessStep);
    await screen.getByRole("button", "Book a demo", { exact: true }).tap();
    await expect(browser.locator("[data-booking-calendar]")).toHaveAttribute(
      "data-ready",
      "",
    );
    await browser.evaluate((selector) => {
      const iframe = document.querySelector(selector);
      if (!iframe) throw new Error("Missing the booking calendar");
      iframe.dispatchEvent(new Event("error"));
      return null;
    }, calendarFrame);
    await expect(
      screen.getByText(
        "Couldn't load the calendar. Book a call opens it in your browser.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(browser.locator(illustration)).toBeVisible();
    await expect(browser.locator(calendarFrame)).toHaveCount(0);
    await expect(
      screen.getByRole("button", "Not now", { exact: true }),
    ).toBeVisible();
    const tab = await browser.waitForPopup(() =>
      screen.getByRole("button", "Book a call", { exact: true }).tap(),
    );
    expect(await tab.url()).toBe(businessUrl);
    await expect.poll(() => tab.title()).toBe("OpenBot Business fixture");
    expect(await browser.evaluate(() => window.opener === null)).toBe(true);
    await tab.close();
    await expect(browser).toHaveURL(knownName ? /\/$/ : namePage);
    await expect
      .poll(() => writes.slice())
      .toEqual(knownName ? [{ completed: true }] : [{ step: 3 }]);
  });
}

test("an offline evaluator immediately gets Book a call and the calendar is removed", async ({
  app,
  browser,
  screen,
}) => {
  await serveOnboarding(browser, { step: 2, evaluateLocally: true });
  await browser.route(calendarPath, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Silent calendar</title>",
    }),
  );
  await browser.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", { get: () => false });
  });
  await app.open(businessStep);
  await screen.getByRole("button", "Book a demo", { exact: true }).tap();
  await expect(
    screen.getByRole("button", "Book a call", { exact: true }),
  ).toBeVisible({ timeout: 4000 });
  await expect(browser.locator(calendarFrame)).toHaveCount(0);
});

for (const knownName of [false, true]) {
  test(`Not now advances ${knownName ? "a known-name evaluator to Home" : "to the name step without opening anything"}`, async ({
    app,
    browser,
    screen,
  }) => {
    const { writes } = await serveOnboarding(browser, {
      name: knownName ? "Maya" : undefined,
      step: knownName ? 1 : 2,
      evaluateLocally: true,
    });
    if (knownName) {
      await app.open("/onboarding?step=welcome");
      await screen.getByRole("button", "Continue", { exact: true }).tap();
    } else {
      await app.open(businessStep);
    }
    await expect(browser).toHaveURL(businessPage);
    const tabs = browser.tabs().length;
    await expect(
      screen.getByRole("button", "Book a demo", { exact: true }),
    ).toBeVisible();
    await screen.getByRole("button", "Not now", { exact: true }).tap();
    await expect(browser).toHaveURL(knownName ? /\/$/ : namePage);
    expect(browser.tabs()).toHaveLength(tabs);
    await expect
      .poll(() => writes.slice(-1))
      .toEqual(knownName ? [{ completed: true }] : [{ step: 3 }]);
  });
}

test("opening the final step's calendar keeps the evaluator on the booking step", async ({
  app,
  browser,
  screen,
}) => {
  const { writes } = await serveOnboarding(browser, {
    name: "Maya",
    step: 2,
    evaluateLocally: true,
  });
  await serveCalendar(browser);
  await app.open(businessStep);
  await screen.getByRole("button", "Book a demo", { exact: true }).tap();
  await expect(browser.locator("[data-booking-calendar]")).toHaveAttribute(
    "data-ready",
    "",
  );
  await verifyCalendarSrc(browser);
  await expect(
    screen.getByRole("button", "Not now", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Continue", { exact: true }),
  ).toHaveCount(0);
  await expect(browser).toHaveURL(businessPage);
  expect(writes).toEqual([]);
});
