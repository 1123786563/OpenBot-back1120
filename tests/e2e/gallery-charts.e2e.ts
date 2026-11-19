import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { shortNames, stories } from "./fixtures/gallery-chart-points";

const fixture = "/tests/browser/gallery-charts.html";

test("read figures name their sources and open web references in a separate tab", async ({
  app,
  browser,
  screen,
}) => {
  const address = "https://imf.org/weo";
  await browser.route(address, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>IMF fixture</title>",
    }),
  );
  await app.open(fixture);
  const chart = screen.getByRole("region", "Chart from sources", {
    exact: true,
  });
  const reference = chart.getByRole("link", "IMF World Economic Outlook", {
    exact: true,
  });
  await expect(reference).toHaveAttribute("href", address);
  await expect(chart.getByText(/Annual report/)).toBeVisible();
  await expect(chart.getByText(/As of 2025/)).toBeVisible();
  const tab = await browser.waitForPopup(() => reference.tap());
  expect(await tab.url()).toBe(address);
  expect(
    await browser.evaluate(
      () => window.opener === null && document.referrer === "",
    ),
  ).toBe(true);
  await tab.close();
});

test("charts explain unchecked figures, skip malformed sources, and support archives", async ({
  app,
  screen,
}) => {
  await app.open(fixture);
  const chart = (name: string) =>
    screen.getByRole("region", name, { exact: true });
  await expect(
    chart("Chart from the Bot").getByText(/Not checked against a source/),
  ).toBeVisible();
  await expect(chart("Chart with both notes")).toContainText(
    "Not checked against a source. · Sources: Annual report",
  );
  const malformed = chart("Chart with malformed sources");
  await expect(
    malformed.getByText("GDP partial sources", { exact: true }),
  ).toBeVisible();
  await expect(malformed).toContainText("Sources: Notes");
  await expect(malformed).not.toContainText("Notes, Notes");
  await expect(malformed.getByText(/As of/)).toHaveCount(0);
  const address = chart("Chart with a non-web address");
  await expect(address.getByText("Notes", { exact: true })).toBeVisible();
  await expect(address.getByRole("link")).toHaveCount(0);
  const archived = chart("Archived chart");
  await expect(
    archived.getByText("Archived GDP", { exact: true }),
  ).toBeVisible();
  await expect(archived.getByText(/Sources:|As of|Not checked/)).toHaveCount(0);
});

for (const width of [420, 720]) {
  test(`ranked bars retain full labels and proportional widths at ${width}px`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width, height: 850 });
    await app.open(`${fixture}?example=ranked`);
    await expect(screen.getByRole("listitem")).toHaveCount(stories.length);
    const rows = await browser.evaluate(async () => {
      await document.fonts.ready;
      return [...document.querySelectorAll("main li")].map((row) => {
        const bar = row.querySelector("[data-bar]");
        const figure = bar?.nextElementSibling;
        const fullLabel = bar?.parentElement
          ?.previousElementSibling as HTMLElement | null;
        if (!bar || !figure || !fullLabel)
          throw new Error("Missing a ranked bar");
        const labelBox = fullLabel.getBoundingClientRect();
        const barBox = bar.getBoundingClientRect();
        const numberBox = figure.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        const mode = labelBox.bottom <= barBox.top ? "stacked" : "beside";
        return {
          title: row.getAttribute("title"),
          label: fullLabel.textContent,
          figure: figure.textContent,
          width: barBox.width,
          labelsFit:
            fullLabel.scrollHeight <= fullLabel.clientHeight + 1 &&
            fullLabel.scrollWidth <= fullLabel.clientWidth + 1,
          figureFits:
            numberBox.left >= barBox.right &&
            numberBox.right <= rowBox.right + 1,
          mode,
        };
      });
    });
    const ordered = stories.slice().sort((a, b) => b.value - a.value);
    expect(rows.map(({ title }) => title)).toEqual(
      ordered.map(({ label, value }) => `${label}: ${value}`),
    );
    expect(rows.map(({ label, figure }) => [label, figure])).toEqual(
      ordered.map(({ label, value }) => [label, String(value)]),
    );
    for (const [index, row] of rows.entries()) {
      expect(row.labelsFit).toBe(true);
      expect(row.figureFits).toBe(true);
      expect(row.mode).toBe(width === 420 ? "stacked" : "beside");
      expect(
        Math.abs(
          row.width / rows[0].width - ordered[index].value / ordered[0].value,
        ),
      ).toBeLessThan(0.002);
    }
  });
}

test("short names keep their original order under vertical columns", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${fixture}?example=columns`);
  await expect(
    screen.getByText("Department totals", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByRole("listitem")).toHaveCount(0);
  const columns = await browser.evaluate(
    (names) =>
      names.map((name) => {
        const label = [...document.querySelectorAll("main span")].find(
          (element) => element.textContent === name,
        );
        const bar = label?.previousElementSibling?.firstElementChild;
        if (!label || !bar) throw new Error(`Missing column: ${name}`);
        const from = label.getBoundingClientRect();
        const to = bar.getBoundingClientRect();
        return {
          left: from.left,
          height: to.height,
          above: to.bottom <= from.top,
        };
      }),
    shortNames.map(({ label }) => label),
  );
  expect(columns[0].left).toBeLessThan(columns[1].left);
  expect(columns[0].height).toBeLessThan(columns[1].height);
  expect(columns.every(({ above }) => above)).toBe(true);
});

test("with no web destination gallery figures keep their contents without links", async ({
  app,
  browser,
  screen,
}) => {
  const region = screen.getByRole("region", "Gallery figures", { exact: true });
  const figureTrees = () =>
    browser.evaluate(() => {
      const gallery = document.querySelector('[aria-label="Gallery figures"]');
      if (!gallery) throw new Error("Missing gallery figures");
      return [...gallery.querySelectorAll("figure")].map(
        (figure) => figure.innerHTML,
      );
    });
  await app.open(`${fixture}?example=figures`);
  await expect(region.getByText("Revenue", { exact: true })).toBeVisible();
  await expect(region.getByRole("link")).toHaveCount(0);
  const noLink = await figureTrees();
  expect(noLink).toHaveLength(4);
  await app.open(`${fixture}?example=figures&link=non-web`);
  await expect(region.getByText("Revenue", { exact: true })).toBeVisible();
  await expect(region.getByRole("link")).toHaveCount(0);
  expect(await figureTrees()).toEqual(noLink);
});

test("gallery figures name their value and open the linked record without a referrer", async ({
  app,
  browser,
  screen,
}) => {
  const address = "https://crm.example.com/accounts/4821";
  await browser.route(address, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Linked record fixture</title>",
    }),
  );
  await app.open(`${fixture}?example=figures&link=web`);
  const region = screen.getByRole("region", "Gallery figures", { exact: true });
  await expect(region.getByRole("link")).toHaveCount(4);
  for (const name of [
    "Support: 12",
    "Cloud: 75%",
    "Hiring: 3 of 8",
    "Revenue: $412k",
  ]) {
    const link = region.getByRole("link", name, { exact: true });
    await expect(link).toHaveAttribute("href", address);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noreferrer noopener");
    const tab = await browser.waitForPopup(() => link.tap());
    expect(await tab.url()).toBe(address);
    expect(
      await browser.evaluate(
        () => window.opener === null && document.referrer === "",
      ),
    ).toBe(true);
    await tab.close();
  }
});
