import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/gallery-render.html";

test("Gallery grants and arguments can arrive without remounting a card or decision", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture);
  const card = screen.getByRole("region", "Earlier call", { exact: true });
  const approval = screen.getByRole("button", "Approve", { exact: true });
  const pendingApproval = screen.getByRole("button", "Sending…", {
    exact: true,
  });
  await expect(card.getByText("Re: pending", { exact: true })).toBeVisible();
  await expect(card.getByText(/not available/)).toHaveCount(0);
  await expect(pendingApproval).toBeDisabled();
  await browser.evaluate(() => {
    const value = document.querySelector('[aria-label="Earlier call"] p');
    const options = document.querySelector(
      'fieldset[aria-label="Approve refund?"]',
    );
    if (!value || !options) throw new Error("Missing card or decision");
    Object.defineProperty(window, "initialGalleryNodes", {
      value: [value, options],
    });
  });
  await screen
    .getByRole("button", "Load grants and finish arguments", { exact: true })
    .click();
  await expect(card.getByText("Revenue: 125", { exact: true })).toBeVisible();
  await expect(approval).toBeEnabled();
  expect(
    await browser.evaluate(() => {
      const initial = Reflect.get(window, "initialGalleryNodes");
      return [
        initial[0] === document.querySelector('[aria-label="Earlier call"] p'),
        initial[1] ===
          document.querySelector('fieldset[aria-label="Approve refund?"]'),
      ];
    }),
  ).toEqual([true, true]);
  await approval.click();
  await expect(
    screen.getByRole("status", "Submitted decision", { exact: true }),
  ).toHaveText('{"call":"approval-1","answer":{"decision":"approved"}}');
  await screen.getByRole("button", "Refuse next call", { exact: true }).click();
  await expect(card.getByText("Revenue: 125", { exact: true })).toBeVisible();
  const later = screen.getByRole("region", "Later call", { exact: true });
  await expect(later.getByText(/just switched off/)).toBeVisible();
  await expect(later.getByText("Later: 126", { exact: true })).toHaveCount(0);
});

for (const { action, reason } of [
  { action: "Load without grants", reason: /not available to this Bot/ },
  {
    action: "Fail grant load",
    reason: /Couldn't check whether this Bot may show Bar chart/i,
  },
]) {
  test(`a Gallery call reports the reason when grants cannot permit it: ${action}`, async ({
    app,
    screen,
  }) => {
    await app.open(fixture);
    const card = screen.getByRole("region", "Earlier call", { exact: true });
    await expect(card.getByText("Re: pending", { exact: true })).toBeVisible();
    await screen.getByRole("button", action, { exact: true }).click();
    await expect(card.getByText(reason)).toBeVisible();
    await expect(card.getByText("Re: pending", { exact: true })).toHaveCount(0);
  });
}

test("Gallery render holds back a partial number and draws complete rows and final values", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?scenario=arguments`);
  const streaming = screen.getByRole("region", "Streaming number", {
    exact: true,
  });
  await expect(
    streaming.getByText("Sales: pending", { exact: true }),
  ).toBeVisible();
  await expect(streaming.getByText("Sales: 12", { exact: true })).toHaveCount(
    0,
  );
  for (const name of ["Executing call", "Stopped call"]) {
    await expect(
      screen
        .getByRole("region", name, { exact: true })
        .getByText("Sales: 125", { exact: true }),
    ).toBeVisible();
  }
  const table = screen.getByRole("region", "Streaming table", { exact: true });
  await expect(table.getByRole("cell", "Q1", { exact: true })).toBeVisible();
  await expect(table.getByRole("cell", "Q2", { exact: true })).toHaveCount(0);
  await expect(table.getByText(/Waiting for complete table data/)).toHaveCount(
    0,
  );
  await screen.getByRole("button", "Finish stream", { exact: true }).click();
  await expect(table.getByRole("cell", "Q2", { exact: true })).toBeVisible();
  await expect(
    streaming.getByText("Sales: 125", { exact: true }),
  ).toBeVisible();
});

test("an empty chart waits only while its arguments can still arrive", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?scenario=arguments`);
  const drawing = screen.getByRole("region", "Streaming chart", {
    exact: true,
  });
  const empty = "There is no data to chart.";
  await expect(drawing.getByRole("status")).toHaveText("Drawing the chart…");
  await expect(drawing.getByText(empty, { exact: true })).toHaveCount(0);
  for (const name of ["Finished empty chart", "Stopped chart"]) {
    const chart = screen.getByRole("region", name, { exact: true });
    await expect(chart.getByText(empty, { exact: true })).toBeVisible();
    await expect(chart.getByRole("status")).toHaveCount(0);
  }
});
