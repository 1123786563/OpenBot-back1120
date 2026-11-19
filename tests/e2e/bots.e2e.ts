import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { workspace } from "./signed-in";

test(
  "Enter creates a private built-in Bot that stays in the roster",
  workspace,
  async ({ app, browser, screen }) => {
    const name = `E2E Built-in Bot ${crypto.randomUUID().slice(0, 8)}`;
    const saved: unknown[] = [];
    await browser.route(/\/api\/agents$/, async (route) => {
      if (route.request.method === "POST") {
        saved.push(JSON.parse(route.request.postData ?? "null"));
      }
      await route.continue();
    });
    await app.open("/bots");
    await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
    const dialog = screen.getByRole("dialog", "New Bot");
    await expect(
      dialog.getByRole("heading", "New Bot", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", /^Run here/)).toBeHidden();
    await expect(
      dialog.getByRole("button", /^Connect a custom agent/),
    ).not.toHaveAttribute("aria-pressed");

    const input = dialog.getByLabel("Name", { exact: true });
    const create = dialog.getByRole("button", "Create Bot", { exact: true });
    await expect(create).toBeDisabled();
    await input.fill(name);
    await expect(create).toBeEnabled();
    await input.press("Enter");

    await expect(
      screen.getByText(`${name} is ready`, { exact: true }),
    ).toBeVisible();
    await expect(browser).toHaveURL(/\/bots\/[^/?#]+\/?$/);
    await expect(
      screen.getByRole("heading", name, { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText(new RegExp(`^You are ${RegExp.escape(name)}\\.`)),
    ).toBeVisible();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      name,
      title: "Powered by OpenBot",
      visibility: "private",
      endpoint: "",
    });
    expect(saved[0]).not.toHaveProperty("harness");

    await app.open("/bots");
    const bot = screen.getByText(name, { exact: true });
    await expect(bot).toBeVisible();
    await browser.reload();
    await expect(bot).toBeVisible();
  },
);

test(
  "an unnamed Bot cannot be created and a draft can be cancelled",
  workspace,
  async ({ app, browser, screen }) => {
    await app.open("/bots");
    await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
    const create = screen.getByRole("button", "Create Bot", { exact: true });
    await expect(create).toBeDisabled();
    const name = `Discarded Bot ${crypto.randomUUID().slice(0, 8)}`;
    await browser.locator("#new-bot-name").fill(name);
    await expect(create).toBeEnabled();
    await screen.getByRole("button", "Cancel", { exact: true }).tap();
    await expect(create).toBeHidden();
    await browser.reload();
    await expect(
      screen.getByRole("heading", "Bots", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText(name, { exact: true })).toBeHidden();
  },
);

test(
  "the New Bot dialog keeps keyboard focus and restores its opener",
  workspace,
  async ({ app, browser, screen }) => {
    await app.open("/bots");
    const opener = screen
      .getByRole("button", "New Bot", { exact: true })
      .first();
    await opener.press("Enter");
    const dialog = screen.getByRole("dialog", "New Bot");
    const name = dialog.getByLabel("Name", { exact: true });
    await expect(name).toBeFocused();
    await name.press("Shift+Tab");
    await expect(
      dialog.getByRole("button", /^Connect a custom agent/),
    ).toBeFocused();
    await dialog.getByRole("button", /^Connect a custom agent/).press("Tab");
    await expect(name).toBeFocused();
    await name.fill("   ");
    await name.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText("Name is required.");
    await name.fill("Retained draft");
    await name.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(browser).toHaveURL(/\/bots\/?$/);
    await opener.press("Enter");
    await expect(name).toHaveValue("Retained draft");
    await dialog.getByRole("button", "Cancel", { exact: true }).tap();
    await expect(dialog).toBeHidden();
    await opener.press("Enter");
    await expect(name).toHaveValue("");
  },
);

test(
  "custom hosting requires a name before choosing a Harness",
  workspace,
  async ({ app, screen }) => {
    await app.open("/bots");
    await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
    const name = screen.getByLabel("Name", { exact: true });
    const custom = screen.getByRole("button", /^Connect a custom agent/);
    const harness = screen.getByRole("button", /^LangChain/);
    await name.fill("   ");
    await custom.tap();
    await expect(screen.getByRole("alert")).toHaveText("Name is required.");
    await expect(name).toBeFocused();
    await expect(harness).toBeHidden();
    await name.fill("E2E Custom Bot");
    await custom.tap();
    await expect(harness).toBeVisible();
    await expect(harness).not.toContainText(/Graph/);
    await harness.tap();
    await expect(screen.getByLabel("Agent address")).toBeVisible();
  },
);

test(
  "a missing or unreachable agent address cannot create a Bot",
  workspace,
  async ({ app, browser, screen }) => {
    const name = `Unreachable Bot ${crypto.randomUUID().slice(0, 8)}`;
    const attempts: string[] = [];
    await browser.route(/\/api\/agents\/test-connection$/, async (route) => {
      attempts.push(route.request.method);
      await route.fulfill({
        json: { ok: false, reason: "Nothing answered at that address." },
      });
    });
    await app.open("/bots");
    await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
    await screen.getByLabel("Name", { exact: true }).fill(name);
    await screen.getByRole("button", /^Connect a custom agent/).tap();
    await screen.getByRole("button", /LangChain/).tap();

    const create = screen.getByRole("button", "Create Bot", { exact: true });
    const address = screen.getByLabel("Agent address");
    await create.tap();
    await expect(screen.getByRole("alert")).toHaveText(
      "Enter your agent's address.",
    );
    await expect(address).toBeFocused();
    expect(attempts).toEqual([]);

    await address.fill("https://agent.example.test/ag-ui");
    await create.tap();
    await expect(screen.getByRole("alert")).toHaveText(
      "Nothing answered at that address.",
    );
    await expect(address).toBeFocused();
    expect(attempts).toEqual(["POST"]);
    await app.open("/bots");
    await expect(
      screen.getByRole("heading", "Bots", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText(name, { exact: true })).toBeHidden();
  },
);

test(
  "switching between Bot setup screens preserves the draft",
  workspace,
  async ({ app, browser, screen }) => {
    const fixtureKey = "Bearer fixture-only";
    const botName = `E2E Switched Bot ${crypto.randomUUID().slice(0, 8)}`;
    let sentDraftKey = false;
    let createRequest: unknown;
    await browser.route(/\/api\/agents$/, async (route) => {
      if (route.request.method === "POST") {
        createRequest = JSON.parse(route.request.postData ?? "null");
      }
      await route.continue();
    });
    await browser.route(/\/api\/agents\/test-connection$/, async (route) => {
      const body: unknown = JSON.parse(route.request.postData ?? "null");
      sentDraftKey =
        typeof body === "object" &&
        body !== null &&
        "headers" in body &&
        typeof body.headers === "object" &&
        body.headers !== null &&
        "Authorization" in body.headers &&
        body.headers.Authorization === fixtureKey;
      await route.fulfill({
        json: { ok: false, reason: "Fixture connection checked." },
      });
    });
    await app.open("/bots");
    await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
    const name = screen.getByLabel("Name", { exact: true });
    const instructions = screen.getByLabel(/^Instructions/);
    const custom = screen.getByRole("button", /^Connect a custom agent/);
    const harness = screen.getByRole("button", /LangChain/);
    const back = screen.getByRole("button", "Back", { exact: true });
    const address = screen.getByLabel("Agent address");
    const key = screen.getByLabel(/^Key/);
    await name.fill(botName);
    await instructions.fill("Review carefully");
    await custom.tap();
    await harness.tap();
    await address.fill("https://agent.example.test/ag-ui");
    await key.fill(fixtureKey);
    await back.tap();
    await expect(harness).toBeVisible();
    await expect(harness).not.toHaveAttribute("aria-pressed");
    await back.tap();
    await expect(name).toHaveValue(botName);
    await screen.getByRole("button", /^Public/).tap();
    await expect(instructions).toHaveValue("Review carefully");
    await custom.tap();
    await harness.tap();
    await expect(address).toHaveValue("https://agent.example.test/ag-ui");
    await screen.getByRole("button", "Create Bot", { exact: true }).tap();
    await expect(screen.getByRole("alert")).toHaveText(
      "Fixture connection checked.",
    );
    expect(sentDraftKey).toBe(true);
    await back.tap();
    await back.tap();
    await screen.getByRole("button", "Create Bot", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/bots\/[^/?#]+\/?$/);
    await expect(
      screen.getByRole("heading", botName, { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText("Review carefully", { exact: true }),
    ).toBeVisible();
    expect(createRequest).toMatchObject({
      name: botName,
      endpoint: "",
      visibility: "public",
      roleDescription: "Review carefully",
    });
    expect(createRequest).not.toHaveProperty("auth");
  },
);

test(
  "a verified custom Harness is saved with its endpoint and authorization",
  workspace,
  async ({ app, browser, screen }) => {
    const name = `E2E LangChain Bot ${crypto.randomUUID().slice(0, 8)}`;
    const endpoint = "https://agent.example.test/ag-ui";
    const key = "Bearer fixture-only";
    const verified: unknown[] = [];
    let createRequest: unknown;
    await browser.route(/\/api\/agents\/test-connection$/, async (route) => {
      verified.push(JSON.parse(route.request.postData ?? "null"));
      await route.fulfill({ json: { ok: true, events: ["RUN_STARTED"] } });
    });
    await browser.route(/\/api\/agents$/, async (route) => {
      if (route.request.method === "POST") {
        createRequest = JSON.parse(route.request.postData ?? "null");
      }
      await route.continue();
    });

    await app.open("/bots");
    await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
    await screen.getByLabel("Name", { exact: true }).fill(name);
    await screen.getByRole("button", /^Connect a custom agent/).tap();
    await screen.getByRole("button", /LangChain/).tap();
    await screen.getByLabel("Agent address").fill(endpoint);
    await screen.getByLabel(/^Key/).fill(key);
    await screen.getByRole("button", "Create Bot", { exact: true }).tap();

    await expect(browser).toHaveURL(/\/bots\/[^/?#]+\/?$/);
    const heading = screen.getByRole("heading", name, { exact: true });
    await expect(heading).toBeVisible();
    await expect(
      screen.getByText("Powered by LangChain", { exact: true }),
    ).toBeVisible();
    expect(verified).toEqual([{ endpoint, headers: { Authorization: key } }]);
    expect(createRequest).toMatchObject({
      name,
      endpoint,
      harness: "langgraph",
      title: "Powered by LangChain",
      auth: { header: "Authorization", value: key },
    });
    await browser.reload();
    await expect(heading).toBeVisible();
    await expect(
      screen.getByText("Powered by LangChain", { exact: true }),
    ).toBeVisible();
  },
);

test(
  "a deployment that cannot host built-in Bots still allows a custom Harness",
  workspace,
  async ({ app, browser, screen }) => {
    const name = `E2E External Bot ${crypto.randomUUID().slice(0, 8)}`;
    await browser.route(/\/api\/agents\/capabilities$/, async (route) => {
      await route.fulfill({
        json: {
          capabilities: { builtInAvailable: false, isolationAvailable: false },
        },
      });
    });
    await browser.route(/\/api\/agents\/test-connection$/, async (route) => {
      await route.fulfill({ json: { ok: true, events: ["RUN_STARTED"] } });
    });

    await app.open("/bots");
    await screen.getByRole("button", "New Bot", { exact: true }).first().tap();
    const dialog = screen.getByRole("dialog", "New Bot");
    const next = dialog.getByRole("button", "Continue", { exact: true });
    await expect(next).toBeDisabled();
    await expect(
      dialog.getByRole("button", /^Run here|^Connect a custom agent/),
    ).toBeHidden();
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await expect(next).toBeEnabled();
    await next.tap();
    const harness = dialog.getByRole("button", /LangChain/);
    await expect(harness).toBeVisible();
    await expect(harness).not.toHaveAttribute("aria-pressed");
    await expect(next).toBeHidden();
    await harness.tap();
    await expect(dialog.getByText("LangChain", { exact: true })).toBeVisible();
    await dialog
      .getByLabel("Agent address")
      .fill("https://agent.example.test/ag-ui");
    await dialog.getByRole("button", "Create Bot", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/bots\/[^/?#]+\/?$/);
    await expect(
      screen.getByRole("heading", name, { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText("Connected from LangChain.", { exact: true }),
    ).toBeVisible();
  },
);

for (const { reason, isolationAvailable } of [
  {
    reason: "This OpenBot can't give a Bot a computer of its own.",
    isolationAvailable: false,
  },
  {
    reason: "Your admin turned off Isolated Bots for you.",
    isolationAvailable: true,
  },
]) {
  test(
    `Bot creation explains why isolation is disabled: ${reason}`,
    workspace,
    async ({ app, browser, screen }) => {
      const name = `E2E Shared Computer ${crypto.randomUUID().slice(0, 8)}`;
      let createRequest: unknown;
      await browser.route(/\/api\/agents\/capabilities$/, async (route) => {
        await route.fulfill({
          json: {
            capabilities: { builtInAvailable: true, isolationAvailable },
          },
        });
      });
      await browser.route(/\/api\/admin\/enterprise\/me$/, async (route) => {
        await route.fulfill({
          json: { capabilities: { isolatedComputers: false }, enforced: true },
        });
      });
      await browser.route(/\/api\/agents$/, async (route) => {
        if (route.request.method === "POST") {
          createRequest = JSON.parse(route.request.postData ?? "null");
        }
        await route.continue();
      });

      await app.open("/bots");
      await screen
        .getByRole("button", "New Bot", { exact: true })
        .first()
        .tap();
      const dialog = screen.getByRole("dialog", "New Bot");
      await dialog.getByLabel("Name", { exact: true }).fill(name);
      const isolated = dialog.getByRole("checkbox", "Isolated", {
        exact: true,
      });
      await expect(isolated).toBeDisabled();
      await expect(isolated).not.toBeChecked();
      await expect(dialog.getByText(reason, { exact: true })).toBeVisible();
      await dialog.getByRole("button", "Create Bot", { exact: true }).tap();
      await expect(browser).toHaveURL(/\/bots\/[^/?#]+\/?$/);
      await expect(
        screen.getByRole("heading", name, { exact: true }),
      ).toBeVisible();
      expect(createRequest).toMatchObject({ name, isolated: false });
    },
  );
}

for (const enableIsolation of [false, true]) {
  test(
    `the Bot wizard submits isolation as ${enableIsolation}`,
    workspace,
    async ({ app, browser, screen }) => {
      const name = `E2E Computer Bot ${crypto.randomUUID().slice(0, 8)}`;
      let createRequest: unknown;
      await browser.route(/\/api\/agents\/capabilities$/, async (route) => {
        await route.fulfill({
          json: {
            capabilities: { builtInAvailable: true, isolationAvailable: true },
          },
        });
      });
      await browser.route(/\/api\/admin\/enterprise\/me$/, async (route) => {
        await route.fulfill({
          json: { capabilities: { isolatedComputers: true }, enforced: true },
        });
      });
      await browser.route(/\/api\/agents$/, async (route) => {
        if (route.request.method !== "POST") {
          await route.continue();
          return;
        }
        createRequest = JSON.parse(route.request.postData ?? "null");
        if (enableIsolation) {
          await route.fulfill({
            status: 201,
            json: { agent: { id: "general-assistant" } },
          });
        } else {
          await route.continue();
        }
      });

      await app.open("/bots");
      await screen
        .getByRole("button", "New Bot", { exact: true })
        .first()
        .tap();
      const dialog = screen.getByRole("dialog", "New Bot");
      await dialog.getByLabel("Name", { exact: true }).fill(name);
      const isolated = dialog.getByRole("checkbox", "Isolated", {
        exact: true,
      });
      await expect(isolated).toBeEnabled();
      await expect(isolated).not.toBeChecked();

      if (enableIsolation) {
        const info = dialog.getByRole("button", "What Isolated means");
        const tooltip = browser.locator('[data-slot="tooltip-content"]');
        const explanation =
          "Runs in its own computer. Nothing it does can reach your other Bots' files or logins. Costs more to run.";
        await info.hover();
        await expect(tooltip).toHaveText(explanation);
        await dialog.getByRole("button", /^Public/).tap();
        await info.hover();
        await expect(tooltip).toHaveText(
          `${explanation} Everyone who uses this Bot shares that computer.`,
        );
        await isolated.tap();
        await expect(isolated).toBeChecked();
      }

      await dialog.getByRole("button", "Create Bot", { exact: true }).tap();
      await expect(
        screen.getByText(`${name} is ready`, { exact: true }),
      ).toBeVisible();
      expect(createRequest).toMatchObject({ name, isolated: enableIsolation });
    },
  );
}
