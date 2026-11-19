import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const path = "/settings/components-gallery";
const modelWords =
  "Show what this deployment has actually been doing rather than anything you know.";
const catalog = [
  [
    "showActivityReport",
    "Activity report",
    "card",
    "Shows what your Bots have been doing and what was refused, read from OpenBot's own records.",
  ],
  [
    "showRecord",
    "Record",
    "card",
    "Shows one thing and its details, such as an order, a person or a ticket.",
  ],
  [
    "showMetrics",
    "Headline figures",
    "card",
    "Shows up to six headline figures and how each one has changed.",
  ],
  [
    "showChecklist",
    "Checklist",
    "card",
    "Shows the steps of a piece of work and which ones are done, such as a release plan.",
  ],
  [
    "showNotice",
    "Notice",
    "card",
    "Shows a headline with a short explanation and a few supporting points.",
  ],
  [
    "showBarChart",
    "Bar chart",
    "chart",
    "Compares a few named things, such as teams or months, as bars.",
  ],
  [
    "showPieChart",
    "Donut chart",
    "chart",
    "Shows how a whole splits into parts, as a donut with a legend.",
  ],
  [
    "showLineChart",
    "Line chart",
    "chart",
    "Shows how one or more values change over time.",
  ],
  [
    "showAreaChart",
    "Area chart",
    "chart",
    "Shows how totals build up over time, with the area under each line filled.",
  ],
  [
    "showProgress",
    "Progress against target",
    "chart",
    "Shows how close each value is to its target, such as budget spent or work done.",
  ],
  [
    "askApproval",
    "Approval",
    "decision",
    "Asks you to approve or decline something. The Bot waits for your answer.",
  ],
  [
    "askChoice",
    "Choice",
    "decision",
    "Asks you to pick one of several options. The Bot waits for your answer.",
  ],
  [
    "askForm",
    "Form",
    "decision",
    "Asks you to fill in a short form. The Bot waits for your answers.",
  ],
  [
    "showQuote",
    "Quotation",
    "card",
    "Shows a quotation and who said or wrote it.",
  ],
  [
    "showTable",
    "Data table",
    "card",
    "Shows a table you can sort by any column, for comparing records side by side.",
  ],
];

async function serveComponents(browser: Browser, empty = false) {
  await browser.route(/\/api\/components$/, (route) =>
    route.fulfill({
      json: {
        components: empty
          ? []
          : catalog.map(([name, title, kind]) => ({
              name,
              title,
              kind,
              draftDescription: modelWords,
              publishedDescription: modelWords,
              published: true,
              publishedAt: "2026-11-07T00:00:00Z",
              updatedBy: "the build",
              updatedAt: "2026-11-07T00:00:00Z",
              hasUnpublishedChanges: false,
              withheldFrom: [],
              functions: [],
            })),
      },
    }),
  );
}

test(`the ${personal ? "personal" : "team"} component gallery speaks to a person rather than exposing model instructions`, async ({
  app,
  browser,
  screen,
}) => {
  await serveComponents(browser);
  await app.open(path);
  await expect(
    screen.getByRole("heading", "Components gallery", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(
      personal
        ? "Browse the components your Bots can show in conversations. Every Bot can use all of them."
        : "Browse components that Bots can display in conversations. An admin controls which components each Bot can use.",
      { exact: true },
    ),
  ).toBeVisible();
  for (const [name, title, , summary] of catalog) {
    const tile = browser.locator(`[data-testid="gallery-${name}"]`);
    await expect(tile).toHaveAttribute("href", `${path}/${name}`);
    await expect(
      tile.getByRole("heading", title, { exact: true }),
    ).toBeVisible();
    await expect(tile.getByText(summary, { exact: true })).toBeVisible();
    await expect(tile).not.toContainText(modelWords);
  }
  await expect(browser.locator("main")).not.toContainText(/deployment/);
  if (personal)
    await expect(browser.locator("main")).not.toContainText(/\badmin\b/i);
});

test(`an empty ${personal ? "personal" : "team"} gallery explains how its components become available`, async ({
  app,
  browser,
  screen,
}) => {
  await serveComponents(browser, true);
  await app.open(path);
  await expect(
    screen.getByText(personal ? "No components yet" : "Nothing published yet", {
      exact: true,
    }),
  ).toBeVisible();
  if (personal)
    await expect(browser.locator("main")).not.toContainText(/\badmin\b/i);
  else
    await expect(
      screen.getByText(
        "When an admin publishes a component, it will show up here.",
        { exact: true },
      ),
    ).toBeVisible();
});

test("opening a component from the gallery keeps the summary in the person's words", async ({
  app,
  browser,
  screen,
}) => {
  await serveComponents(browser);
  await app.open(path);
  const tile = browser.locator('[data-testid="gallery-showActivityReport"]');
  await expect(tile).toBeVisible();
  await tile.click();
  await expect(browser).toHaveURL(`${path}/showActivityReport`);
  await expect(
    screen.getByText(
      "Shows what your Bots have been doing and what was refused, read from OpenBot's own records.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(browser.locator("main")).not.toContainText(
    /deployment|you will not see them/,
  );
  await browser.reload();
  await expect(
    screen.getByText(
      "Shows what your Bots have been doing and what was refused, read from OpenBot's own records.",
      { exact: true },
    ),
  ).toBeVisible();
});
