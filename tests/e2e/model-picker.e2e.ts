import { type Browser, test, type WebApp } from "@e2e-dev/web";
import { expect } from "e2e";

const catalogue = {
  provider: "openai",
  source: "openai",
  exposure: "all",
  default: "gpt-5.5",
  choosable: true,
  models: [
    {
      id: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      vendor: "openai",
      efforts: ["none", "low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
    },
    {
      id: "gpt-6-sol",
      label: "GPT-6 Sol",
      vendor: "openai",
      efforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      vendor: "openai",
      efforts: ["minimal", "low", "medium", "high"],
      defaultEffort: "medium",
    },
    { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
  ],
};
type Pick = { model: string | null; effort: string | null };
const defaults: Pick = { model: null, effort: null };

async function openConversation(
  { app, browser }: { app: WebApp; browser: Browser },
  initial: Pick,
  {
    available = catalogue,
    catalogueDelivery,
    saveOutcome,
  }: {
    available?: typeof catalogue;
    catalogueDelivery?: Promise<void>;
    saveOutcome?: Promise<string | null>;
  } = {},
) {
  await app.open("/");
  const id = await browser.evaluate(async () => {
    const response = await fetch("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: ["general-assistant"] }),
    });
    if (!response.ok)
      throw new Error(`Creating a channel returned ${response.status}`);
    const data: { channel: { id: string } } = await response.json();
    return data.channel.id;
  });
  const writes: Pick[] = [];
  const reads: string[] = [];
  const catalogueRequests: string[] = [];
  let saved = initial;
  await browser.route(/\/api\/models$/, async (route) => {
    catalogueRequests.push(route.request.url);
    await catalogueDelivery;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(available),
    });
  });
  await browser.route(
    new RegExp(`/api/channels/${RegExp.escape(id)}/model$`),
    async (route) => {
      if (route.request.method === "PUT") {
        const pick: Pick = JSON.parse(route.request.postData ?? "null");
        const option = available.models.find(
          ({ id }) => id === (pick.model ?? available.default),
        );
        if (
          !option ||
          (pick.effort !== null && !option.efforts?.includes(pick.effort))
        ) {
          await route.fulfill({
            status: 400,
            json: { error: "Invalid model selection" },
          });
          return;
        }
        writes.push(pick);
        const error = await saveOutcome;
        if (error) {
          await route.fulfill({ status: 503, json: { error } });
          return;
        }
        saved = pick;
      } else {
        reads.push(route.request.url);
      }
      await route.fulfill({ json: saved });
    },
  );
  await app.open(`/channel/${id}`);
  return { writes, reads, catalogueRequests };
}

test("model search filters the model names and keeps the thinking choices", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { writes } = await openConversation(fixtures, {
    model: "gpt-6.1-terra",
    effort: null,
  });
  const trigger = screen.getByRole(
    "combobox",
    "Model: GPT-6.1 Terra, thinking: Medium",
    { exact: true },
  );
  await trigger.tap();
  const dialog = screen.getByRole("dialog");
  const models = dialog.getByRole("group", "Models");
  const thinking = dialog.getByRole("group", "Thinking");
  const query = browser.locator('input[placeholder="Search models"]');
  await query.fill("sol");
  await expect(models.getByRole("option")).toHaveCount(1);
  await expect(
    models.getByRole("option", "GPT-6 Sol", { exact: true }),
  ).toBeVisible();
  await expect(thinking.getByRole("option")).toHaveCount(5);
  await expect(thinking.getByRole("option", /^Medium/)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await query.fill("nothing like it");
  await expect(
    dialog.getByText("No models match.", { exact: true }),
  ).toBeVisible();
  await expect(models.getByRole("option")).toHaveCount(0);
  await expect(thinking.getByRole("option")).toHaveCount(5);
  expect(writes).toEqual([]);
});

test("saving and resetting an effort updates the model trigger after reload", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { writes } = await openConversation(fixtures, {
    model: "gpt-6.1-terra",
    effort: null,
  });
  const medium = screen.getByRole(
    "combobox",
    "Model: GPT-6.1 Terra, thinking: Medium",
    { exact: true },
  );
  const high = screen.getByRole(
    "combobox",
    "Model: GPT-6.1 Terra, thinking: High",
    { exact: true },
  );
  const dialog = screen.getByRole("dialog");
  await medium.tap();
  const thinking = dialog.getByRole("group", "Thinking");
  for (const [index, name] of [
    "None",
    "Low",
    "Medium",
    "High",
    "Extra high",
  ].entries()) {
    await expect(thinking.getByRole("option").nth(index)).toContainText(name);
  }
  await expect(thinking.getByRole("option")).toHaveCount(5);
  await expect(thinking.getByRole("option", /^Medium/)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await thinking.getByRole("option", "High", { exact: true }).tap();
  await expect
    .poll(() => writes)
    .toEqual([{ model: "gpt-6.1-terra", effort: "high" }]);
  await expect(high).toBeVisible();
  await browser.reload();
  await expect(high).toBeVisible();

  await high.tap();
  await thinking.getByRole("option", /^Medium/).tap();
  await expect
    .poll(() => writes)
    .toEqual([
      { model: "gpt-6.1-terra", effort: "high" },
      { model: "gpt-6.1-terra", effort: null },
    ]);
  await expect(medium).toBeVisible();
  await browser.reload();
  await expect(medium).toBeVisible();
});

for (const { name, initial, choice, expected, label } of [
  {
    name: "switching models clears an unsupported effort",
    initial: { model: "gpt-6.1-terra", effort: "xhigh" },
    choice: "GPT-6 Sol",
    expected: { model: "gpt-6-sol", effort: null },
    label: "Model: GPT-6 Sol",
  },
  {
    name: "switching to the default model retains a supported effort",
    initial: { model: "gpt-6.1-terra", effort: "high" },
    choice: /^GPT-5\.5/,
    expected: { model: null, effort: "high" },
    label: "Model: GPT-5.5, thinking: High",
  },
]) {
  test(name, async (fixtures) => {
    const { screen } = fixtures;
    const { writes } = await openConversation(fixtures, initial);
    await screen.getByRole("combobox", /^Model: GPT-6\.1 Terra/).tap();
    await screen.getByRole("dialog").getByRole("option", choice).tap();
    await expect.poll(() => writes).toEqual([expected]);
    await expect(
      screen.getByRole("combobox", label, { exact: true }),
    ).toBeVisible();
  });
}

for (const { name, saved, label, thinking } of [
  {
    name: "a conversation with no saved model displays the default",
    saved: defaults,
    label: "Model: GPT-5.5, thinking: Medium",
    thinking: true,
  },
  {
    name: "a retired saved model falls back to the default with its supported effort",
    saved: { model: "retired-model", effort: "high" },
    label: "Model: GPT-5.5, thinking: High",
    thinking: true,
  },
  {
    name: "a model that does not support efforts hides the control and its stale saved effort",
    saved: { model: "gpt-4o", effort: "high" },
    label: "Model: GPT-4o",
    thinking: false,
  },
]) {
  test(name, async (fixtures) => {
    const { screen } = fixtures;
    const { writes } = await openConversation(fixtures, saved);
    await screen.getByRole("combobox", label, { exact: true }).tap();
    const dialog = screen.getByRole("dialog");
    await expect(dialog.getByRole("group", "Thinking")).toHaveCount(
      thinking ? 1 : 0,
    );
    if (!thinking) {
      const models = dialog.getByRole("option");
      await expect(models).toHaveCount(4);
      for (const [index, title] of [
        "GPT-6.1 Terra",
        "GPT-6 Sol",
        "GPT-5.5",
        "GPT-4o",
      ].entries()) {
        await expect(models.nth(index)).toContainText(title);
      }
    }
    expect(writes).toEqual([]);
  });
}

test("the default effort is first when a model's provider does not publish it", async (fixtures) => {
  const { screen } = fixtures;
  const { writes } = await openConversation(fixtures, {
    model: "gpt-6-sol",
    effort: "high",
  });
  await screen
    .getByRole("combobox", "Model: GPT-6 Sol, thinking: High", { exact: true })
    .tap();
  const efforts = screen
    .getByRole("dialog")
    .getByRole("group", "Thinking")
    .getByRole("option");
  await expect(efforts).toHaveCount(4);
  for (const [index, name] of ["Default", "Low", "Medium", "High"].entries()) {
    await expect(efforts.nth(index)).toHaveText(name);
  }
  await efforts.first().tap();
  await expect
    .poll(() => writes)
    .toEqual([{ model: "gpt-6-sol", effort: null }]);
  await expect(
    screen.getByRole("combobox", "Model: GPT-6 Sol", { exact: true }),
  ).toBeVisible();
});

test("selecting a non-thinking model returns keyboard focus to the message and resetting saves null", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { writes } = await openConversation(fixtures, {
    model: "gpt-6.1-terra",
    effort: null,
  });
  const dialog = screen.getByRole("dialog");
  await screen.getByRole("combobox", /^Model: GPT-6\.1 Terra/).tap();
  await dialog.getByRole("option", "GPT-4o", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? null,
      ),
    )
    .toBe("Message");
  await screen.getByRole("textbox", "Message").tap();
  expect(writes).toEqual([{ model: "gpt-4o", effort: null }]);

  await screen.getByRole("combobox", "Model: GPT-4o", { exact: true }).tap();
  await dialog.getByRole("option", /^GPT-5\.5/).tap();
  await expect
    .poll(() => writes)
    .toEqual([
      { model: "gpt-4o", effort: null },
      { model: null, effort: null },
    ]);
});

test("Escape and clicking outside dismiss the model picker without saving", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { writes } = await openConversation(fixtures, {
    model: "gpt-6.1-terra",
    effort: null,
  });
  const trigger = screen.getByRole("combobox", /^Model: GPT-6\.1 Terra/);
  const dialog = screen.getByRole("dialog");
  await trigger.tap();
  await expect(dialog).toBeVisible();
  await browser.locator('input[placeholder="Search models"]').press("Escape");
  await expect(dialog).toHaveCount(0);
  await trigger.tap();
  await expect(dialog).toBeVisible();
  await screen
    .getByRole("region", "Messages", { exact: true })
    .getByRole("heading", "General Assistant", { exact: true })
    .tap();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("choosing a thinking model leaves only effort choices before restoring editor focus", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { writes } = await openConversation(fixtures, {
    model: "gpt-6.1-terra",
    effort: null,
  });
  const dialog = screen.getByRole("dialog");
  await screen.getByRole("combobox", /^Model: GPT-6\.1 Terra/).tap();
  await dialog.getByRole("option", "GPT-6 Sol", { exact: true }).tap();
  await expect
    .poll(() => writes)
    .toEqual([{ model: "gpt-6-sol", effort: null }]);
  await expect(dialog.getByRole("group", "Models")).toHaveCount(0);
  const thinking = dialog.getByRole("group", "Thinking");
  await expect(thinking.getByRole("option")).toHaveCount(4);
  for (const [index, name] of ["Default", "Low", "Medium", "High"].entries()) {
    await expect(thinking.getByRole("option").nth(index)).toHaveText(name);
  }
  expect(
    await browser.evaluate(() => {
      const search = document
        .querySelector('input[placeholder="Search models"]')
        ?.closest('[data-slot="input-group"]');
      if (!search) throw new Error("The picker keyboard input is missing");
      return {
        height: search.getBoundingClientRect().height,
        position: getComputedStyle(search).position,
      };
    }),
  ).toEqual({ height: 0, position: "absolute" });

  await thinking.getByRole("option", "High", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? null,
      ),
    )
    .toBe("Message");
  await screen.getByRole("textbox", "Message").tap();
  expect(writes).toEqual([
    { model: "gpt-6-sol", effort: null },
    { model: "gpt-6-sol", effort: "high" },
  ]);

  await screen
    .getByRole("combobox", "Model: GPT-6 Sol, thinking: High", { exact: true })
    .tap();
  await expect(dialog.getByRole("group", "Models")).toBeVisible();
  await expect(thinking).toBeVisible();
});

test("a locked model catalogue leaves an existing conversation without a picker or model requests", async (fixtures) => {
  const { screen } = fixtures;
  const { catalogueRequests, reads, writes } = await openConversation(
    fixtures,
    defaults,
    { available: { ...catalogue, choosable: false } },
  );
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await expect.poll(() => catalogueRequests.length).toBeGreaterThan(0);
  await expect(screen.getByRole("combobox", /^Model:/)).toHaveCount(0);
  expect(reads).toEqual([]);
  expect(writes).toEqual([]);
});

test("the model selector shows model icons and visually matches the two Default labels", async (fixtures) => {
  const { browser, screen } = fixtures;
  const { writes } = await openConversation(fixtures, defaults, {
    available: {
      ...catalogue,
      models: [
        ...catalogue.models,
        { id: "fast", label: "fast", vendor: "unknown" },
        { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", vendor: "google" },
        { id: "grok-4.7", label: "Grok 4.7", vendor: "xai" },
      ],
    },
  });
  const trigger = screen.getByRole(
    "combobox",
    "Model: GPT-5.5, thinking: Medium",
    { exact: true },
  );
  await expect(trigger).toBeVisible();
  await expect(
    browser.locator('[data-slot="composer-model"] svg.tabler-icon-cpu'),
  ).toBeVisible();
  await expect(browser.locator('[data-slot="composer-model"] img')).toHaveCount(
    0,
  );
  await expect(trigger).toHaveText("");

  await trigger.tap();
  const dialog = screen.getByRole("dialog");
  await expect(
    dialog.getByRole("option", "fast", { exact: true }),
  ).toBeVisible();
  for (const label of ["Gemini 3.8 Flash", "Grok 4.7"]) {
    await expect(
      dialog.getByRole("option", label, { exact: true }),
    ).toBeVisible();
    await expect(
      browser.locator(`[role="option"] img[data-mark="${label}"]`),
    ).toBeVisible();
  }
  const styles = await browser.evaluate(() => {
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    const fast = options.find((option) => option.textContent === "fast");
    const defaultTagStyles = options.flatMap((option) =>
      Array.from(option.querySelectorAll("span"))
        .filter((span) => span.textContent === "Default")
        .map((span) => {
          const style = getComputedStyle(span);
          return {
            classes: span.className,
            background: style.backgroundColor,
            size: style.fontSize,
          };
        }),
    );
    return {
      plainIcon:
        !!fast?.querySelector("svg.tabler-icon-cube") &&
        !fast.querySelector("img"),
      defaultTagStyles,
    };
  });
  expect(styles.plainIcon).toBe(true);
  expect(styles.defaultTagStyles).toHaveLength(2);
  expect(styles.defaultTagStyles[0]).toEqual(styles.defaultTagStyles[1]);
  expect(styles.defaultTagStyles[0]?.classes).toContain(
    "text-muted-foreground",
  );
  expect(styles.defaultTagStyles[0]?.background).toBe("rgba(0, 0, 0, 0)");
  expect(writes).toEqual([]);
});

test("the composer waits for the catalogue before showing a model picker", async (fixtures) => {
  const { screen } = fixtures;
  const delivery = Promise.withResolvers<void>();
  try {
    const { reads, writes } = await openConversation(fixtures, defaults, {
      catalogueDelivery: delivery.promise,
    });
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();
    await expect(screen.getByRole("combobox", /^Model:/)).toHaveCount(0);
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
    delivery.resolve();
    await expect(
      screen.getByRole("combobox", "Model: GPT-5.5, thinking: Medium", {
        exact: true,
      }),
    ).toBeVisible();
    expect(reads.length).toBeGreaterThan(0);
  } finally {
    delivery.resolve();
  }
});

for (const saveError of [null, "Model choice could not be saved."]) {
  test(
    saveError
      ? "a failed model save restores the message without sending it"
      : "sending in a conversation waits for its model choice to be saved",
    async (fixtures) => {
      const { browser, screen } = fixtures;
      const release = Promise.withResolvers<string | null>();
      const runs: string[] = [];
      await browser.route(
        /\/api\/copilotkit\/agent\/[^/]+\/run$/,
        async (route) => {
          runs.push(route.request.postData ?? "");
          await route.fulfill({ status: 503, body: "Test stream unavailable" });
        },
      );
      try {
        const { writes } = await openConversation(fixtures, defaults, {
          saveOutcome: release.promise,
        });
        const original = screen.getByRole(
          "combobox",
          "Model: GPT-5.5, thinking: Medium",
          { exact: true },
        );
        const selected = screen.getByRole("combobox", "Model: GPT-4o", {
          exact: true,
        });
        await original.tap();
        await screen
          .getByRole("dialog")
          .getByRole("option", "GPT-4o", { exact: true })
          .tap();
        await expect
          .poll(() => writes)
          .toEqual([{ model: "gpt-4o", effort: null }]);

        const message = "Send this with the selected model.";
        const editor = screen.getByRole("textbox", "Message");
        await editor.fill(message);
        await editor.press("Enter");
        await expect(editor).toHaveText("");
        expect(runs).toEqual([]);

        release.resolve(saveError);
        if (saveError) {
          await expect(
            screen.getByText(saveError, { exact: true }),
          ).toBeVisible();
          await expect(editor).toHaveText(message);
          await expect(original).toBeVisible();
          await expect(
            screen.getByRole("button", "Send message", { exact: true }),
          ).toBeEnabled();
          expect(runs).toEqual([]);
        } else {
          await expect.poll(() => runs.length).toBe(1);
          expect(runs[0]).toContain(message);
          await expect(selected).toBeVisible();
        }
      } finally {
        release.resolve(saveError);
      }
    },
  );
}

for (const { name, choose, expected } of [
  {
    name: "resetting a new conversation to default leaves no model override to save",
    choose: "reset",
    expected: [],
  },
  {
    name: "a new conversation can save an effort on the default model",
    choose: "low",
    expected: [{ model: null, effort: "low" }],
  },
  {
    name: "a new conversation discards an effort when switching to a model without it",
    choose: "non-thinking",
    expected: [{ model: "gpt-4o", effort: null }],
  },
]) {
  test(name, async ({ app, browser, screen }) => {
    const writes: unknown[] = [];
    const requests: string[] = [];
    await browser.route(/\/api\/models$/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(catalogue),
      }),
    );
    await browser.route(/\/api\/channels$/, async (route) => {
      if (route.request.method === "POST") requests.push("create");
      await route.continue();
    });
    await browser.route(/\/api\/channels\/[^/]+\/model$/, async (route) => {
      if (route.request.method === "PUT") {
        requests.push("save");
        writes.push(JSON.parse(route.request.postData ?? "null"));
      }
      await route.fulfill({ json: expected[0] ?? defaults });
    });
    await browser.route(
      /\/api\/copilotkit\/agent\/[^/]+\/run$/,
      async (route) => {
        requests.push("run");
        await route.fulfill({ status: 503, body: "Test stream unavailable" });
      },
    );
    await app.open("/channel/new?agent=general-assistant");
    const dialog = screen.getByRole("dialog");
    const defaultTrigger = screen.getByRole(
      "combobox",
      "Model: GPT-5.5, thinking: Medium",
      { exact: true },
    );
    await defaultTrigger.tap();
    if (choose === "reset") {
      await dialog.getByRole("option", "GPT-6.1 Terra", { exact: true }).tap();
      await dialog.getByRole("option", "High", { exact: true }).tap();
      await screen
        .getByRole("combobox", "Model: GPT-6.1 Terra, thinking: High", {
          exact: true,
        })
        .tap();
      await dialog.getByRole("option", /^GPT-5\.5/).tap();
      await dialog.getByRole("option", /^Medium/).tap();
      await expect(defaultTrigger).toBeVisible();
    } else {
      await dialog.getByRole("option", "Low", { exact: true }).tap();
      const low = screen.getByRole(
        "combobox",
        "Model: GPT-5.5, thinking: Low",
        { exact: true },
      );
      await expect(low).toBeVisible();
      if (choose === "non-thinking") {
        await low.tap();
        await dialog.getByRole("option", "GPT-4o", { exact: true }).tap();
        await expect(
          screen.getByRole("combobox", "Model: GPT-4o", { exact: true }),
        ).toBeVisible();
      }
    }
    expect(requests).toEqual([]);
    const editor = screen.getByRole("textbox", "Message");
    await editor.fill("Start with the current model settings.");
    await editor.press("Enter");
    await expect
      .poll(() => requests)
      .toEqual(expected.length ? ["create", "save", "run"] : ["create", "run"]);
    expect(writes).toEqual(expected);
  });
}
