import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const path = "/tests/browser/gallery-streaming.html";
const stableElements = [
  '[aria-label="Streaming bar"] .rounded-t-md',
  '[aria-label="Streaming metric"] figure p:nth-child(2)',
  '[aria-label="Streaming table"] tbody tr td',
];

test("streaming chart, metric and table values keep their nodes when labels finish", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(path);
  for (const region of ["Streaming bar", "Streaming metric"]) {
    await expect(
      screen
        .getByRole("region", region, { exact: true })
        .getByText("Re", { exact: true }),
    ).toBeVisible();
  }
  const bars = browser.locator('[aria-label="Streaming bar"] .rounded-t-md');
  await expect(bars).toHaveCount(2);
  const heights = await browser.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[aria-label="Streaming bar"] .rounded-t-md',
      ),
      (bar) => bar.style.height,
    ),
  );
  expect(heights).toEqual(["100%", "2%"]);
  await expect(screen.getByText("NaN", { exact: true })).toHaveCount(0);
  const table = browser.locator('[aria-label="Streaming table"] table');
  await expect(table).toBeVisible();
  await expect(
    browser.locator('[aria-label="Streaming table"] tbody tr'),
  ).toHaveCount(2);
  await expect(table.getByText("Q1", { exact: true })).toBeVisible();
  await expect(table.getByRole("button", "Re", { exact: true })).toBeVisible();
  await expect(table.getByText("Q2", { exact: true })).toHaveCount(0);
  expect(
    await browser.evaluate((selectors) => {
      const nodes = selectors.map((selector) =>
        document.querySelector(selector),
      );
      Object.defineProperty(window, "e2eStreamingElements", { value: nodes });
      return nodes.every((node) => node !== null);
    }, stableElements),
  ).toBe(true);

  await screen
    .getByRole("button", "Finish labels and rows", { exact: true })
    .click();
  for (const region of ["Streaming bar", "Streaming metric"]) {
    await expect(
      screen
        .getByRole("region", region, { exact: true })
        .getByText("Revenue", { exact: true }),
    ).toBeVisible();
  }
  await expect(
    table.getByRole("button", "Revenue", { exact: true }),
  ).toBeVisible();
  await expect(table.getByText("Q2", { exact: true })).toBeVisible();
  await expect(table.getByText("9", { exact: true })).toBeVisible();
  expect(
    await browser.evaluate((selectors) => {
      const nodes = Reflect.get(window, "e2eStreamingElements");
      return selectors.map(
        (selector, index) => document.querySelector(selector) === nodes[index],
      );
    }, stableElements),
  ).toEqual([true, true, true]);
});

test("chart bars can repeat a label and a finished malformed table reports failure", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    const duplicates: string[] = [];
    Object.defineProperty(window, "e2eDuplicateKeys", { value: duplicates });
    const originalError = console.error;
    console.error = (...args) => {
      const message = args.map(String).join(" ");
      if (message.includes("same key")) duplicates.push(message);
      originalError(...args);
    };
  });
  await app.open(path);
  await expect(
    screen
      .getByRole("region", "Repeated labels", { exact: true })
      .getByText("Q1", { exact: true }),
  ).toHaveCount(2);
  await expect(
    browser.locator('[aria-label="Repeated labels"] .rounded-t-md'),
  ).toHaveCount(2);
  expect(
    await browser.evaluate(() => Reflect.get(window, "e2eDuplicateKeys")),
  ).toEqual([]);
  const invalid = screen.getByRole("region", "Invalid finished table", {
    exact: true,
  });
  await expect(
    invalid.getByText("Couldn't show the data table.", { exact: true }),
  ).toBeVisible();
  await expect(
    invalid.getByText(/Waiting for complete table data/),
  ).toHaveCount(0);
  await expect(invalid.getByRole("table")).toHaveCount(0);
});

test("bar figures compact at narrow widths and keep their exact values available", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(path);
  const chart = screen.getByRole("region", "Bar figure width", { exact: true });
  const readFigure = () =>
    browser.evaluate(() => {
      const marker = document.querySelector(
        '[aria-label="Bar figure width"] [data-exact-figure]',
      );
      const group = marker?.parentElement;
      return {
        exact: group?.querySelector(".sr-only")?.textContent ?? null,
        title: group?.getAttribute("title") ?? null,
        display: marker?.nextElementSibling?.textContent ?? null,
        overflow:
          marker instanceof HTMLElement &&
          marker.scrollWidth > marker.clientWidth,
      };
    });
  await expect
    .poll(readFigure)
    .toEqual({ exact: null, title: null, display: "14,808", overflow: false });
  await screen.getByRole("button", "Narrow chart", { exact: true }).click();
  await expect.poll(readFigure).toEqual({
    exact: "14,808",
    title: "14,808",
    display: "15K",
    overflow: true,
  });
  await expect(chart.getByText("…", { exact: true })).toHaveCount(0);
  await screen.getByRole("button", "Widen chart", { exact: true }).click();
  await expect
    .poll(readFigure)
    .toEqual({ exact: null, title: null, display: "14,808", overflow: false });
});
