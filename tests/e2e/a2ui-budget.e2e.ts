import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { generatedSurface } from "./a2ui-surface";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const numberForm = generatedSurface(
  "currency-form",
  [
    { id: "root", component: "Card", child: "fields" },
    {
      id: "fields",
      component: "Column",
      children: [
        "title",
        "lodging",
        "total",
        "short-zip",
        "default-zip",
        "echo",
      ],
    },
    { id: "title", component: "Text", text: "Trip preferences" },
    {
      id: "lodging",
      component: "TextField",
      label: "Lodging",
      variant: "number",
      value: { "@path": "/lodging" },
    },
    {
      id: "short-zip",
      component: "TextField",
      label: "Postal code (short text)",
      variant: "shortText",
      value: { "@path": "/shortZip" },
    },
    {
      id: "default-zip",
      component: "TextField",
      label: "Postal code (default)",
      value: { "@path": "/defaultZip" },
    },
    {
      id: "total",
      component: "Text",
      text: {
        "@call": "calc",
        args: {
          expression: "'Total $' + (100 + lodging + 80)",
          lodging: { "@path": "/lodging" },
        },
      },
    },
    {
      id: "echo",
      component: "Text",
      text: {
        "@call": "calc",
        args: {
          expression:
            "'Postal codes: ' + (shortZip + 1) + ' and ' + (defaultZip + 1)",
          shortZip: { "@path": "/shortZip" },
          defaultZip: { "@path": "/defaultZip" },
        },
      },
    },
  ],
  { lodging: 200, shortZip: "", defaultZip: "" },
);

test("restored numeric fields compute with numbers, while both text field variants keep leading zeros", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const conversation = await createConversation(browser, bot.id);
  await configureChatStream(browser, [numberForm]);
  await app.open(`/channel/${conversation}`);
  const surface = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    surface.getByText("Trip preferences", { exact: true }),
  ).toBeVisible();
  const field = surface.getByRole("spinbutton", "Lodging", { exact: true });
  const total = (dollars: string) =>
    surface.getByText(`Total $${dollars}`, { exact: true });
  await expect(total("380")).toBeVisible();
  await expect(field).toHaveValue("200");
  await field.fill("");
  await expect(field).toHaveValue("");
  await expect(total("180")).toBeVisible();
  await field.pressSequentially("250");
  await expect(total("430")).toBeVisible();
  await field.pressSequentially(".5");
  await expect(field).toHaveValue("250.5");
  await expect(total("430.5")).toBeVisible();
  await field.fill("");
  await expect(field).toHaveValue("");
  await field.pressSequentially("300");
  await expect(total("480")).toBeVisible();

  for (const variant of ["short text", "default"]) {
    const postal = surface.getByRole("textbox", `Postal code (${variant})`, {
      exact: true,
    });
    await postal.pressSequentially("007");
    await expect(postal).toHaveValue("007");
  }
  await expect(
    surface.getByText("Postal codes: 0071 and 0071", { exact: true }),
  ).toBeVisible();
});

const breakdown = generatedSurface(
  "breakdown",
  [
    { id: "root", component: "Card", children: ["split", "echo"] },
    {
      id: "split",
      component: "Breakdown",
      items: { "@path": "/items" },
      currency: "USD",
      max: 500,
    },
    {
      id: "echo",
      component: "Text",
      text: {
        "@call": "calc",
        args: {
          expression: "'Lodging in the model: ' + lodging",
          lodging: { "@path": "/items/1/amount" },
        },
      },
    },
  ],
  {
    items: [
      { label: "Transport", amount: 100 },
      { label: "Lodging", amount: 200 },
      { label: "Food", amount: 80 },
    ],
  },
);

const budgetSurface = '[data-generative-ui-chat-surface="breakdown"]';
const parts = '[data-slot="breakdown-bar"] > [data-part]';
const series = ["rgb(99, 102, 241)", "rgb(16, 185, 129)", "rgb(245, 158, 11)"];

function slices(browser: Browser) {
  return browser.evaluate(
    (selector) =>
      [...document.querySelectorAll<HTMLElement>(selector)].map((slice) => ({
        part: slice.dataset.part ?? null,
        color: getComputedStyle(slice).backgroundColor,
        width: slice.getBoundingClientRect().width,
      })),
    parts,
  );
}

test("editing a Breakdown updates its visible shares, bound amount, and slider", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const conversation = await createConversation(browser, bot.id);
  await configureChatStream(browser, [breakdown]);
  await app.open(`/channel/${conversation}`);
  const budget = browser.locator(
    '[data-generative-ui-chat-surface="breakdown"]',
  );
  const total = browser.locator(
    `${budgetSurface} [data-slot="breakdown-total"]`,
  );
  await expect(total).toHaveText("$380");
  const before = await slices(browser);
  expect(before.map(({ part }) => part)).toEqual([
    "Transport",
    "Lodging",
    "Food",
  ]);
  expect(before.map(({ color }) => color)).toEqual(series);
  expect(before[1].width).toBeGreaterThan(before[0].width);
  await expect(budget.getByText("53%", { exact: true })).toBeVisible();

  const lodging = budget.getByRole("spinbutton", "Lodging", { exact: true });
  await lodging.fill("");
  await lodging.pressSequentially("250");
  await expect(total).toHaveText("$430");
  await expect(budget.getByText("58%", { exact: true })).toBeVisible();
  await expect(
    budget.getByText("Lodging in the model: 250", { exact: true }),
  ).toBeVisible();
  await expect(
    budget.getByRole("slider", "Lodging", { exact: true }),
  ).toHaveAttribute("aria-valuenow", "250");
  await expect(
    budget.getByRole("slider", "Lodging", { exact: true }),
  ).toHaveAttribute("aria-valuetext", "$250");
  await expect
    .poll(async () => {
      const bars = await slices(browser);
      const fullWidth = bars.reduce((sum, bar) => sum + bar.width, 0);
      return Math.abs(bars[1].width / fullWidth - 250 / 430);
    })
    .toBeLessThan(0.003);
  const after = await slices(browser);
  expect(after[1].color).toBe(before[1].color);
  expect(after[1].width).toBeGreaterThan(before[1].width);
  expect(
    await screen
      .getByRole("region", "Messages", { exact: true })
      .getByText("$430", { exact: true })
      .count(),
  ).toBe(1);
});

test("Breakdown rounds all shares to 100% and removes a zero-value slider slice", async (fixtures) => {
  const { app, browser } = fixtures;
  const bot = await createBot(fixtures);
  const conversation = await createConversation(browser, bot.id);
  await configureChatStream(browser, [breakdown]);
  await app.open(`/channel/${conversation}`);
  const budget = browser.locator(
    '[data-generative-ui-chat-surface="breakdown"]',
  );
  const total = browser.locator(
    `${budgetSurface} [data-slot="breakdown-total"]`,
  );
  const entry = budget.getByRole("spinbutton", "Food", { exact: true });
  await expect(total).toHaveText("$380");
  await entry.fill("");
  await entry.pressSequentially("120");
  await expect(total).toHaveText("$420");
  const shares = await browser.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-generative-ui-chat-surface="breakdown"] li',
      ),
    ].map((row) => {
      const match = row.textContent?.match(/(\d+)%/);
      return Number(match?.[1] ?? -1);
    }),
  );
  expect(shares).toEqual([24, 48, 28]);
  expect(shares.reduce((sum, v) => sum + v, 0)).toBe(100);

  await budget.getByRole("slider", "Food", { exact: true }).press("Home");
  await expect(total).toHaveText("$300");
  await expect(entry).toHaveValue("0");
  expect((await slices(browser)).map(({ part }) => part)).toEqual([
    "Transport",
    "Lodging",
  ]);
});

test("an external amount update replaces a cleared numeric field, including zero", async ({
  app,
  screen,
}) => {
  await app.open("/tests/browser/a2ui-number.html");
  const field = screen.getByRole("spinbutton", "Amount", { exact: true });
  await expect(field).toHaveValue("200");
  await field.fill("");
  await expect(field).toHaveValue("");
  await screen.getByRole("button", "Load seven", { exact: true }).tap();
  await expect(field).toHaveValue("7");
  await screen.getByRole("button", "Load zero", { exact: true }).tap();
  await expect(field).toHaveValue("0");
});

test("the committed trip form uses OpenBot's surface and accent colors in both themes", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const conversation = await createConversation(browser, bot.id);
  const trip = generatedSurface(
    "trip-preferences",
    [
      { id: "root", component: "Card", child: "fields" },
      { id: "fields", component: "Column", children: ["title", "destination"] },
      { id: "title", component: "Text", text: "Trip preferences" },
      {
        id: "destination",
        component: "TextField",
        label: "Destination",
        value: { "@path": "/destination" },
      },
    ],
    { destination: "Paris" },
  );
  await configureChatStream(browser, [trip]);
  await browser.addInitScript(() => {
    localStorage.setItem("openbot-theme", "light");
  });
  await app.open(`/channel/${conversation}`);
  const selector =
    '[data-generative-ui-chat-surface="trip-preferences"] .a2ui-surface';
  await expect(
    screen.getByText("Trip preferences", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("textbox", "Destination", { exact: true }),
  ).toHaveValue("Paris");

  const palette = () =>
    browser.evaluate((selector) => {
      const surface = document.querySelector(selector);
      if (!surface) throw new Error("Missing the trip form");
      const theme = getComputedStyle(surface);
      const current = (name: string) => theme.getPropertyValue(name).trim();
      return {
        accent: current("--a2ui-color-accent"),
        primary: current("--primary"),
        panel: current("--a2ui-color-surface"),
        card: current("--card"),
      };
    }, selector);

  const light = await palette();
  expect(light.accent).not.toBe("");
  expect(light.panel).not.toBe("");
  expect(light.accent).toBe(light.primary);
  expect(light.panel).toBe(light.card);
  await browser.evaluate(() => {
    document.documentElement.classList.add("dark");
    return null;
  });
  const dark = await palette();
  expect(dark.accent).toBe(dark.primary);
  expect(dark.panel).toBe(dark.card);
  expect(dark.panel).not.toBe(light.panel);
});
