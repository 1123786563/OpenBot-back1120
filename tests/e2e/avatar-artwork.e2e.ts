import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/avatar-artwork.html";

test("Bot orbs are named and use distinct palettes and size-dependent animation", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  await expect(
    screen.getByRole("img", "Expense Review", { exact: true }),
  ).toBeVisible();
  for (const [name, variant] of [
    ["Idle Knowledge", "static"],
    ["Large Knowledge", "live"],
    ["Working Knowledge", "live"],
  ]) {
    await expect(
      screen.getByRole("img", name, { exact: true }),
    ).toHaveAttribute("data-variant", variant);
  }
  const colors = await browser.evaluate(() =>
    ["Idle Knowledge", "Idle Risk Analyst"].map((name) => {
      const orb = document.querySelector<HTMLElement>(`[aria-label="${name}"]`);
      return orb?.style.getPropertyValue("--c1") ?? "";
    }),
  );
  expect(colors.every(Boolean)).toBe(true);
  expect(colors[0]).not.toBe(colors[1]);
});

test("avatars follow each skin and keep the same Bot palette across contexts", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  for (const skin of ["openbot", "openduet", "opendots", "openmuse"]) {
    const root = `section[aria-label="${skin}"]`;
    for (const kind of ["bot", "conversation", "group"]) {
      const avatar = `${root} [data-avatar="${kind}"]`;
      await expect(browser.locator(`${avatar} [data-variant]`)).toHaveCount(
        skin === "openbot" ? (kind === "group" ? 2 : 1) : 0,
      );
      if (skin === "openbot")
        await expect(browser.locator(`${avatar} svg`)).toHaveCount(0);
      else await expect(browser.locator(`${avatar} svg`).first()).toBeVisible();
    }
  }
  await expect(
    screen
      .getByRole("region", "openbot", { exact: true })
      .getByText("Working…", { exact: true }),
  ).toBeVisible();
  const colors = await browser.evaluate(() =>
    ["bot", "conversation"].map((kind) => {
      const orb = document.querySelector<HTMLElement>(
        `section[aria-label="openbot"] [data-avatar="${kind}"] [data-variant]`,
      );
      return orb?.style.getPropertyValue("--c1") ?? "";
    }),
  );
  expect(colors[0]).toBeTruthy();
  expect(colors[1]).toBe(colors[0]);
});

test("a vendored Harness mark loads quietly and a blank mark keeps its column", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  await expect(screen.getByText("LangGraph", { exact: true })).toBeVisible();
  await expect(screen.getByText("Unmarked", { exact: true })).toBeVisible();
  const image = browser.locator('[data-harness="marked"] img');
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml/);
  await expect(image).toHaveAttribute("alt", "");
  await expect(image).toHaveAttribute("aria-hidden", "true");
  await expect(
    browser.locator(
      '[data-harness="unmarked"] img, [data-harness="unmarked"] svg',
    ),
  ).toHaveCount(0);
  const columns = await browser.evaluate(() =>
    Array.from(document.querySelectorAll("[data-harness]"), (row) => ({
      width: row.firstElementChild?.getBoundingClientRect().width,
      labelStart: row.lastElementChild?.getBoundingClientRect().left,
    })).map(({ width, labelStart }) => ({
      width: width ?? 0,
      labelStart: labelStart ?? 0,
    })),
  );
  expect(columns[0]?.width).toBeGreaterThan(0);
  expect(columns[1]).toEqual(columns[0]);
});

test("an app logo recovers from a failed image request when its URL changes", async ({
  app,
  browser,
  screen,
}) => {
  const requests: string[] = [];
  await browser.route(/\/fixture-(broken|new)-logo\.svg$/, (route) => {
    const { pathname } = new URL(route.request.url);
    requests.push(pathname);
    if (pathname === "/fixture-broken-logo.svg")
      return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" /></svg>',
    });
  });
  await app.open(fixture);
  const plug = browser.locator("[data-logo] svg");
  const logo = browser.locator("[data-logo] img");
  await expect(plug).toBeVisible();
  await screen.getByRole("button", "Load broken logo", { exact: true }).click();
  await expect
    .poll(() => requests.slice())
    .toEqual(["/fixture-broken-logo.svg"]);
  await expect(plug).toBeVisible();
  await expect(logo).toHaveCount(0);
  await screen
    .getByRole("button", "Load replacement logo", { exact: true })
    .click();
  await expect(logo).toHaveAttribute("src", "/fixture-new-logo.svg");
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          document.querySelector<HTMLImageElement>("[data-logo] img")
            ?.naturalWidth ?? 0,
      ),
    )
    .toBe(24);
  await expect(plug).toHaveCount(0);
  expect(requests).toEqual([
    "/fixture-broken-logo.svg",
    "/fixture-new-logo.svg",
  ]);
});
