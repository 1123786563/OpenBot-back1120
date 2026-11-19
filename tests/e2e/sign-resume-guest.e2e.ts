import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const verifier = "/api/plugins/arcade/verify?flow_id=h1";
const signPage = "/sign?flow_id=h1";
const providerPage = "/identity-provider-fixture";

async function interceptSignIn(
  browser: Browser,
  providers: string[],
  options: { sso?: boolean; refuseFirst?: boolean } = {},
) {
  const requests: { method: string; body: unknown }[] = [];
  await browser.route(/\/api\/capabilities$/, (route) =>
    route.fulfill({
      json: { authProviders: providers, ssoConfigured: options.sso ?? false },
    }),
  );
  await browser.route(/\/api\/auth\/sign-in\/(social|sso)$/, async (route) => {
    requests.push({
      method: route.request.method,
      body: JSON.parse(route.request.postData ?? "null"),
    });
    if (options.refuseFirst && requests.length === 1) {
      await route.fulfill({ status: 503, json: { message: "Unavailable" } });
      return;
    }
    await route.fulfill({ json: { url: providerPage, redirect: true } });
  });
  await browser.route(/\/identity-provider-fixture$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><h1>Identity provider</h1>",
    }),
  );
  return requests;
}

function casdoorRequest(origin: string) {
  return {
    method: "POST",
    body: {
      provider: "casdoor",
      callbackURL: `${origin}${verifier}`,
      errorCallbackURL: `${origin}/sign?error=AUTH_CALLBACK_FAILED`,
    },
  };
}

test("the only Casdoor provider starts once and carries the verifier callback", async ({
  app,
  browser,
  screen,
}) => {
  const requests = await interceptSignIn(browser, ["casdoor"]);
  await app.open(signPage);
  await expect(screen.getByRole("heading", "Identity provider")).toBeVisible();
  const origin = await browser.evaluate(() => window.location.origin);
  expect(requests).toEqual([casdoorRequest(origin)]);
});

test("a refused Casdoor auto-start leaves a working manual retry", async ({
  app,
  browser,
  screen,
}) => {
  const requests = await interceptSignIn(browser, ["casdoor"], {
    refuseFirst: true,
  });
  await app.open(signPage);
  const origin = await browser.evaluate(() => window.location.origin);
  await expect(screen.getByRole("alert")).toContainText(
    "Could not open Casdoor. Try again.",
  );
  await expect(browser).toHaveURL(signPage);
  expect(requests).toEqual([casdoorRequest(origin)]);
  await screen.getByRole("button", "Continue with Casdoor").click();
  await expect(screen.getByRole("heading", "Identity provider")).toBeVisible();
  expect(requests).toEqual([casdoorRequest(origin), casdoorRequest(origin)]);
});

test("a Casdoor callback error waits for a manual retry", async ({
  app,
  browser,
  screen,
}) => {
  const requests = await interceptSignIn(browser, ["casdoor"]);
  const callbackError = `${signPage}&error=AUTH_CALLBACK_FAILED`;
  await app.open(callbackError);
  const origin = await browser.evaluate(() => window.location.origin);
  await expect(screen.getByRole("alert")).toContainText(
    "Sign-in was cancelled or could not finish.",
  );
  await expect(browser).toHaveURL(callbackError);
  expect(requests).toEqual([]);
  await screen.getByRole("button", "Continue with Casdoor").click();
  await expect(screen.getByRole("heading", "Identity provider")).toBeVisible();
  expect(requests).toEqual([casdoorRequest(origin)]);
});

for (const providers of [["google"], ["casdoor", "google"]]) {
  test(`Google sign-in with ${providers.join(" and ")} waits for a click and carries the verifier callback`, async ({
    app,
    browser,
    screen,
  }) => {
    const requests = await interceptSignIn(browser, providers);
    await app.open(signPage);
    const origin = await browser.evaluate(() => window.location.origin);
    const google = screen.getByRole("button", "Continue with Google");
    await expect(google).toBeVisible();
    expect(requests).toEqual([]);
    await google.click();
    await expect(
      screen.getByRole("heading", "Identity provider"),
    ).toBeVisible();
    expect(requests).toEqual([
      {
        method: "POST",
        body: { provider: "google", callbackURL: origin + verifier },
      },
    ]);
  });
}

test("the company sign-in form sends the entered address and verifier callback", async ({
  app,
  browser,
  screen,
}) => {
  const requests = await interceptSignIn(browser, [], { sso: true });
  await app.open(signPage);
  const origin = await browser.evaluate(() => window.location.origin);
  const company = screen.getByRole(
    "button",
    "Continue with your company account",
  );
  await expect(company).toBeDisabled();
  await browser.locator('input[type="email"]').fill("someone@company.com");
  await company.click();
  await expect(screen.getByRole("heading", "Identity provider")).toBeVisible();
  expect(requests).toEqual([
    {
      method: "POST",
      body: { email: "someone@company.com", callbackURL: origin + verifier },
    },
  ]);
});
