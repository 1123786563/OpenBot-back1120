import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const plugins = /\/api\/plugins(?:\?[^#]*)?$/;
const emptyPage = {
  catalogue: [],
  servers: [],
  skills: [],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
  authorizesPerAction: false,
};

async function serveSkills(browser: Browser, status: 200 | 500) {
  let currentStatus = status;
  const reads: number[] = [];
  await browser.route(plugins, (route) => {
    reads.push(currentStatus);
    return currentStatus === 500
      ? route.fulfill({ status: 500, body: "" })
      : route.fulfill({ json: emptyPage });
  });
  return {
    reads,
    fail() {
      currentStatus = 500;
    },
  };
}

for (const page of [
  {
    name: "personal Skills",
    path: "/capabilities/skills",
    error: "Couldn't load your skills. Reload the page.",
    empty: "No skills yet. Write one with New skill.",
  },
  {
    name: "Admin Skills",
    path: "/admin/skills",
    error: "Couldn't load skills. Reload the page.",
    empty: "No skills yet",
  },
]) {
  test(`${page.name} shows a failed read without showing an empty state`, async ({
    app,
    browser,
    screen,
  }) => {
    const { reads } = await serveSkills(browser, 500);
    await app.open(page.path);
    await expect(screen.getByText(page.error, { exact: true })).toBeVisible();
    await expect(screen.getByText(page.empty, { exact: true })).toHaveCount(0);
    expect(reads).toEqual([500, 500]);
  });

  test(`${page.name} keeps its confirmed empty list after a background read fails`, async ({
    app,
    browser,
    screen,
  }) => {
    const { fail, reads } = await serveSkills(browser, 200);
    await app.open(page.path);
    const empty = screen.getByText(page.empty, { exact: true });
    const error = screen.getByText(page.error, { exact: true });
    await expect(empty).toBeVisible();
    await expect(error).toHaveCount(0);
    expect(reads).toContain(200);

    fail();
    const [refresh] = await Promise.all([
      browser.waitForResponse(plugins),
      browser.evaluate(() => {
        window.dispatchEvent(new Event("offline"));
        window.dispatchEvent(new Event("online"));
        return null;
      }),
    ]);
    expect(refresh.status).toBe(500);
    const retry = await browser.waitForResponse(plugins);
    expect(retry.status).toBe(500);
    expect(reads.filter((status) => status === 500)).toHaveLength(2);
    await expect(empty).toBeVisible();
    await expect(error).toHaveCount(0);
  });
}

test("a bookmarked skill editor distinguishes a failed list read from a missing skill", async ({
  app,
  browser,
  screen,
}) => {
  const { reads } = await serveSkills(browser, 500);
  await app.open("/capabilities/skills?edit=triage");
  await expect(
    screen.getByText("Couldn't load this skill. Reload the page.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    screen.getByText("This skill was deleted, or it isn't yours to edit.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(screen.getByLabel("Instructions", { exact: true })).toHaveCount(
    0,
  );
  expect(reads).toEqual([500, 500]);
});
