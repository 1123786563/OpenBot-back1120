import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const published = {
  name: "custom_preview_test",
  title: "Preview test",
  draftDescription: "An administrator-authored component",
  draftHtml: "<p>Do not run this draft</p>",
  draftCss: ".draft-only {}",
  draftJsFunctions: 'throw new Error("Draft must not execute")',
  draftArgumentSchema: {},
  publishedHtml: '<p id="title">Published</p>',
  publishedCss: "p { color: blue; }",
  publishedJsFunctions:
    'document.getElementById("title").textContent = window.__args.title;',
  publishedArgumentSchema: {
    type: "object",
    properties: { title: { type: "string" } },
  },
  sampleArguments: { title: "Sample title" },
  revision: 2,
  published: true,
  publishedAt: "2026-09-12T00:00:00Z",
  authoredBy: null,
  hasUnpublishedChanges: true,
};

const fixture = "/tests/browser/component-preview.html";

test("a late admin preview renders the published sample in an inert scaled sandbox", async ({
  app,
  browser,
  screen,
}) => {
  const release = Promise.withResolvers<void>();
  let reads = 0;
  await browser.route(/\/api\/sandboxed$/, async (route) => {
    reads++;
    await release.promise;
    return route.fulfill({ json: { components: [published] } });
  });
  try {
    await app.open(fixture);
    await expect.poll(() => reads).toBe(1);
    await expect(browser.locator("main iframe")).toHaveCount(0);
    release.resolve();
    const frame = browser.locator("main [inert][aria-hidden='true'] iframe");
    await expect(frame).toBeVisible();
    const contents = browser.frameLocator("main iframe");
    await expect(
      contents.getByText("Sample title", { exact: true }),
    ).toBeVisible();
    await expect(
      contents.getByText("Do not run this draft", { exact: true }),
    ).toHaveCount(0);
    await expect(
      screen.getByText("This build cannot draw this.", { exact: true }),
    ).toHaveCount(0);
    const fit = await browser.evaluate(() => {
      const tile = document.querySelector("main")?.getBoundingClientRect();
      const preview = document
        .querySelector("main iframe")
        ?.getBoundingClientRect();
      if (!tile || !preview) throw new Error("Preview frame is missing");
      return (
        preview.width > 0 &&
        preview.height > 0 &&
        preview.left >= tile.left &&
        preview.right <= tile.right &&
        preview.top >= tile.top &&
        preview.bottom <= tile.bottom
      );
    });
    expect(fit).toBe(true);
  } finally {
    release.resolve();
  }
});

for (const record of [
  { ...published, published: false },
  { ...published, publishedHtml: null },
]) {
  test(`the administrator preview with ${record.published ? "no published HTML" : "an unpublished record"} never opens a sandbox`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.route(/\/api\/sandboxed$/, (route) =>
      route.fulfill({ json: { components: [record] } }),
    );
    await app.open(fixture);
    await expect(
      screen.getByText("Publish in the playground to see a preview.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(browser.locator("main iframe")).toHaveCount(0);
  });
}

for (const mode of ["read-only", "compiled"]) {
  test(`the ${mode} component preview never requests administrator drafts`, async ({
    app,
    browser,
    screen,
  }) => {
    const reads: string[] = [];
    await browser.route(/\/api\/sandboxed$/, (route) => {
      reads.push(route.request.method);
      return route.fulfill({ json: { components: [published] } });
    });
    await app.open(`${fixture}?mode=${mode}`);
    if (mode === "compiled") {
      const table = browser.locator("main [inert] table");
      await expect(table).toBeVisible();
      await expect(browser.locator("main [inert]")).toContainText(
        "Team capacity",
      );
    } else {
      await expect(
        screen.getByText("Published in the playground.", { exact: true }),
      ).toBeVisible();
    }
    await expect(browser.locator("main iframe")).toHaveCount(0);
    expect(reads).toEqual([]);
  });
}
