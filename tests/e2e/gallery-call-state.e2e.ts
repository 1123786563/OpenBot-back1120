import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/gallery-call-state.html";
const unreadable =
  "The Bot sent data OpenBot couldn't read. Ask it to try again.";
const failure = (title: string) => `Couldn't show the ${title.toLowerCase()}.`;

for (const scenario of ["harness-live", "harness-reloaded", "browser"]) {
  test(`gallery calls with unreadable arguments show a final error in ${scenario}`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(`${fixture}?scenario=${scenario}`);
    await expect
      .poll(() =>
        browser.evaluate(
          () => document.querySelectorAll("main > section").length,
        ),
      )
      .toBeGreaterThan(0);
    const titles = await browser.evaluate(() =>
      Array.from(
        document.querySelectorAll("main > section"),
        (section) => section.getAttribute("aria-label") ?? "",
      ),
    );
    expect(titles.length).toBeGreaterThan(10);
    for (const title of titles) {
      const component = screen.getByRole("region", title, { exact: true });
      await expect(
        component.getByText(failure(title), { exact: true }),
      ).toBeVisible();
      await expect(
        component.getByText(unreadable, { exact: true }),
      ).toBeVisible();
      await expect(
        component.getByText(
          /Waiting for complete table data|Choosing a report/,
        ),
      ).toHaveCount(0);
    }
  });
}

for (const { component, title, placeholder } of [
  {
    component: "showTable",
    title: "Data table",
    placeholder: /Waiting for complete table data/,
  },
  {
    component: "showActivityReport",
    title: "Activity report",
    placeholder: /Choosing a report/,
  },
]) {
  test(`${title} waits for its arguments and reports failure once the run ends`, async ({
    app,
    screen,
  }) => {
    await app.open(`${fixture}?scenario=waiting&component=${component}`);
    const error = screen.getByText(failure(title), { exact: true });
    await expect(screen.getByText(placeholder)).toBeVisible();
    await expect(error).toHaveCount(0);
    await screen.getByRole("button", "End run", { exact: true }).click();
    await expect(error).toBeVisible();
    await expect(screen.getByText(placeholder)).toHaveCount(0);
    await app.open(`${fixture}?scenario=answered&component=${component}`);
    await expect(error).toBeVisible();
    await expect(screen.getByText(placeholder)).toHaveCount(0);
  });
}

test("a failed complete table draws a framed error and a successful table draws its data", async ({
  app,
  browser,
  screen,
}) => {
  const url = `${fixture}?component=showTable`;
  await app.open(`${url}&scenario=harness-reloaded`);
  await expect(
    screen.getByText(failure("Data table"), { exact: true }),
  ).toBeVisible();
  const framed = browser.locator(
    'figure[data-slot="gallery-frame"] [role="status"]',
  );
  await expect(framed).toContainText(failure("Data table"));
  await expect(screen.getByTestId("component-refused")).toHaveCount(0);
  await app.open(`${url}&scenario=valid-refused`);
  await expect(
    screen.getByText(
      "Something went wrong while showing it. Ask the Bot to try again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(screen.getByRole("table")).toHaveCount(0);
  await app.open(`${url}&scenario=success`);
  await expect(screen.getByRole("table")).toBeVisible();
  await expect(
    screen.getByText(failure("Data table"), { exact: true }),
  ).toHaveCount(0);
});

test("an aborted approval keeps the question it already displayed", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?scenario=aborted&component=askApproval`);
  await expect(
    screen.getByText("Refund this order?", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(failure("Approval"), { exact: true }),
  ).toHaveCount(0);
});
