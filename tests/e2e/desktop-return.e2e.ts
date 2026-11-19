import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { captureNotices } from "./browser-notices";
import { gmailServer } from "./fixtures/app-details";

const fixture = "/tests/browser/desktop-return.html";
const confirmPath = "/api/plugins/servers/gmail/connection/confirm";
const protocol = "openbot://open";

function protocolAttempts(browser: Browser) {
  return browser.evaluate(() =>
    performance
      .getEntriesByName("open-desktop-attempt", "mark")
      .map((entry) => (entry as PerformanceMark).detail),
  );
}

for (const status of [200, 503]) {
  test(`browser returns to Desktop only after account confirmation settles with ${status}`, async ({
    app,
    browser,
    screen,
  }) => {
    const resolveConfirmation = Promise.withResolvers<void>();
    const requests: string[] = [];
    await browser.route(
      /\/api\/plugins\/servers\/gmail\/connection\/confirm$/,
      async (route) => {
        requests.push(
          `${route.request.method} ${new URL(route.request.url).pathname}`,
        );
        await resolveConfirmation.promise;
        await route.fulfill({
          status,
          json: status === 200 ? { connected: true } : { error: "Unavailable" },
        });
      },
    );

    try {
      await app.open(`${fixture}?app=gmail`);
      await expect(
        screen.getByRole("heading", "Back to OpenBot"),
      ).toBeVisible();
      await expect(screen.getByRole("link", "Open OpenBot")).toHaveAttribute(
        "href",
        protocol,
      );
      await expect.poll(() => requests).toEqual([`POST ${confirmPath}`]);
      expect(await protocolAttempts(browser)).toEqual([]);
    } finally {
      resolveConfirmation.resolve();
    }
    await expect.poll(() => protocolAttempts(browser)).toEqual([protocol]);
    expect(requests).toEqual([`POST ${confirmPath}`]);
  });
}

test("a return already inside Desktop lands on the Gmail account page", async ({
  app,
  browser,
  screen,
}) => {
  await captureNotices(browser, { desktop: "native" });
  await browser.route(/\/api\/plugins$/, (route) =>
    route.fulfill({
      json: {
        catalogue: [],
        servers: [{ ...gmailServer, id: "gmail" }],
        skills: [],
        provider: "composio",
        composioConfigured: true,
      },
    }),
  );
  await app.open("/desktop-return?app=gmail");
  await expect(browser).toHaveURL("/connections/gmail");
  await expect(
    screen.getByRole("heading", "Gmail", { exact: true }),
  ).toBeVisible();
});
