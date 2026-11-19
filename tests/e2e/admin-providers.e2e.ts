import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const providers = "/admin/providers";
const defaultModel = "openai/gpt-5.6-terra";
const alternate = "openai/gpt-6-sol";
const custom = "anthropic/claude-opus-5-5";
const settingsPath = "/api/admin/enterprise/settings/modelAllowlist";
const capabilityPath = "/api/admin/enterprise/capabilities";
const vendors = [
  ["openai", "OpenAI", true],
  ["anthropic", "Anthropic", true],
  ["google", "Google", true],
  ["xai", "xAI", true],
  ["gateway", "OpenAI-compatible endpoint", false],
  ["chatgpt", "ChatGPT plan", true],
  ["claude", "Claude plan", true],
] as const;

const providerModels: {
  id: string;
  label: string;
  vendor: string;
  efforts?: string[];
  defaultEffort?: string;
}[] = [
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    vendor: "openai",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    vendor: "openai",
    efforts: ["none", "low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
];

async function serveModels(
  browser: Browser,
  {
    models = [defaultModel],
    exposure = "allowed",
    source = () => "openai",
  }: {
    models?: string[];
    exposure?: "allowed" | "all";
    source?: () => (typeof vendors)[number][0];
  } = {},
) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const settings = {
    ssoRequired: false,
    actionRecording: false,
    inactiveComputerDays: 30,
    modelAllowlist: { enabled: models.length > 0, models },
    mcpAllowlist: { enabled: false, servers: [] },
    skillSharing: false,
    proactiveDailyRuns: 24,
    modelSelection: false,
  };
  const capability = {
    capability: "useBots",
    title: "Use Bots",
    description: "Talk to Bots and let them run work.",
    default: true,
    roles: {},
    groups: {},
  };
  let organization: boolean | null = null;
  await browser.route(/\/api\/admin\/enterprise$/, (route) =>
    route.fulfill({
      json: {
        settings,
        capabilities: [{ ...capability, organization }],
        groups: [],
        network: [],
        defaultDestinations: [],
        mcpServers: [],
        builtInModel: defaultModel,
        scim: {
          configured: false,
          connectionId: "directory",
          baseUrl: null,
          rotating: false,
        },
        otel: { configured: false },
        actionRecordRetentionDays: 90,
      },
    }),
  );
  await browser.route(/\/api\/models\/available(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        provider: "openai",
        source: source(),
        exposure,
        default: "gpt-5.6-terra",
        listed: true,
        models: providerModels,
      },
    }),
  );
  await browser.route(
    /\/api\/admin\/enterprise\/models\/usage(?:\?|$)/,
    (route) => route.fulfill({ json: { days: 30, summary: [], recent: [] } }),
  );
  await browser.route(
    /\/api\/admin\/enterprise\/(settings\/modelAllowlist|capabilities)$/,
    (route) => {
      const method = route.request.method;
      const path = new URL(route.request.url).pathname;
      const body = JSON.parse(route.request.postData ?? "null");
      writes.push({ method, path, body });
      if (path === settingsPath) {
        settings.modelAllowlist = body.value;
        return route.fulfill({
          json: { key: "modelAllowlist", value: body.value },
        });
      }
      organization = body.allowed;
      return route.fulfill({
        json: { capability: { ...capability, organization } },
      });
    },
  );
  return writes;
}

if (personal) {
  test("the old Providers address returns a personal installation to Settings", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(providers);
    await expect(browser).toHaveURL("/settings");
    await expect(screen.getByRole("button", /Allowed models/)).toHaveCount(0);
    await expect(
      screen.getByRole("switch", "Only allowed models", { exact: true }),
    ).toHaveCount(0);
  });
  test("a personal conversation offers all models returned by its provider", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(
      browser,
      bot.id,
      "Personal model options",
    );
    await browser.route(/\/api\/models$/, (route) =>
      route.fulfill({
        json: {
          provider: "openai",
          source: "openai",
          exposure: "all",
          default: "gpt-5.6-terra",
          choosable: true,
          models: providerModels,
        },
      }),
    );
    await configureChatStream(browser);
    await app.open(`/channel/${channel}`);
    await screen.getByRole("combobox", /^Model: GPT-5\.6 Terra/).click();
    const picker = screen.getByRole("dialog").getByRole("group", "Models");
    for (const { id, label } of providerModels) {
      await expect(
        picker.getByRole(
          "option",
          id === "gpt-5.6-terra" ? `${label} Default` : label,
          { exact: true },
        ),
      ).toBeVisible();
    }
    await expect(picker.getByRole("option")).toHaveCount(providerModels.length);
  });
} else {
  test("a team sees model choices and usage with its allowlist", async ({
    app,
    browser,
    screen,
  }) => {
    await serveModels(browser);
    await app.open(providers);
    await expect(
      screen.getByRole("heading", "Providers", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText("OpenAI", { exact: true })).toBeVisible();
    await expect(
      screen.getByText("Default gpt-5.6-terra · 3 models listed", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      screen.getByText("1 model allowed", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("switch", "Let people choose a model", { exact: true }),
    ).toHaveCount(0);
    await expect(screen.getByRole("button", /Allowed models/)).toBeVisible();
    await expect(
      screen.getByText(
        "Runs on each model in the last 30 days, including runs the allowlist refused.",
        { exact: true },
      ),
    ).toBeVisible();
  });

  test("an empty allowlist explains why people have no model picker", async ({
    app,
    browser,
    screen,
  }) => {
    await serveModels(browser, { models: [] });
    await app.open(providers);
    await expect(
      screen.getByText("No models allowed yet", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText(
        "People don't see a model picker. Allow models below to offer them.",
        { exact: true },
      ),
    ).toBeVisible();
  });

  test("exposure of every listed model hides allowlist controls and refusal copy", async ({
    app,
    browser,
    screen,
  }) => {
    await serveModels(browser, { exposure: "all" });
    await app.open(providers);
    await expect(
      screen.getByText("Every listed model", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText("3 models, kept current from your provider.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(screen.getByRole("button", /Allowed models/)).toHaveCount(0);
    await expect(
      screen.getByRole("switch", "Only allowed models", { exact: true }),
    ).toHaveCount(0);
    await expect(
      screen.getByRole("switch", "Let people choose a model", { exact: true }),
    ).toHaveCount(0);
    await expect(
      screen.getByText("Runs on each model in the last 30 days.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(screen.getByText(/allowlist refused/)).toHaveCount(0);
  });

  test("Providers names the model source and displays its vendored mark", async ({
    app,
    browser,
    screen,
  }) => {
    let source: (typeof vendors)[number][0] = "openai";
    await serveModels(browser, { source: () => source });
    await app.open(providers);
    for (const [served, name, hasMark] of vendors) {
      source = served;
      await browser.reload();
      const title = screen.getByText(name, { exact: true });
      const row = browser.locator('[data-slot="item"]').filter({ has: title });
      await expect(title).toBeVisible();
      await expect(row).toContainText(
        "Default gpt-5.6-terra · 3 models listed",
      );
      await expect(browser.locator("main img[data-mark]")).toHaveCount(
        hasMark ? 1 : 0,
      );
      if (hasMark)
        await expect(browser.locator("main img[data-mark]")).toHaveAttribute(
          "data-mark",
          name,
        );
    }
  });

  test("the allowlist searches, validates a full model name, and saves provider-qualified choices", async ({
    app,
    browser,
    screen,
  }) => {
    const writes = await serveModels(browser, { source: () => "gateway" });
    await app.open(providers);
    const open = screen.getByRole("button", /Allowed models/);
    await open.click();
    const dialog = screen.getByRole("dialog", "Allowed models", {
      exact: true,
    });
    const search = dialog.getByRole("textbox", "Search models", {
      exact: true,
    });
    const sol = dialog.getByRole("checkbox", "Allow GPT-6 Sol", {
      exact: true,
    });
    const other = dialog.getByRole("textbox", "Another model", { exact: true });
    const add = dialog.getByRole("button", "Add", { exact: true });
    await expect(
      dialog.getByText(/openai\/gpt-5\.6-terra.*default/),
    ).toBeVisible();
    await expect(
      dialog.getByText(/openai\/gpt-6-sol.*Thinking: Low, Medium, High/),
    ).toBeVisible();
    await expect(
      browser.locator('[role="dialog"] img[data-mark="GPT-6 Sol"]'),
    ).toHaveCount(1);
    await search.fill("sol");
    await expect(dialog.getByText("GPT-4o", { exact: true })).toHaveCount(0);
    await sol.click();
    await expect(sol).toBeChecked();
    await search.fill("");
    await expect(dialog.getByText("GPT-4o", { exact: true })).toBeVisible();
    await other.fill("claude-opus-5-5");
    await expect(add).toBeDisabled();
    await other.fill(custom);
    await expect(add).toBeEnabled();
    await add.click();
    await expect(
      dialog.getByRole("checkbox", `Allow ${custom}`, { exact: true }),
    ).toBeChecked();
    expect(writes).toEqual([]);
    await dialog.getByRole("button", "Save", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = [defaultModel, alternate, custom];
    await expect(open).toContainText(saved.join(", "));
    await browser.reload();
    await expect(open).toContainText(saved.join(", "));
    expect(writes).toEqual([
      {
        method: "PUT",
        path: settingsPath,
        body: { value: { enabled: true, models: saved } },
      },
    ]);
  });

  test("cancelling discards the draft and clearing the default explains enforcement", async ({
    app,
    browser,
    screen,
  }) => {
    const writes = await serveModels(browser);
    await app.open(providers);
    const open = screen.getByRole("button", /Allowed models/);
    await open.click();
    const dialog = screen.getByRole("dialog", "Allowed models", {
      exact: true,
    });
    const checked = dialog.getByRole("checkbox", "Allow GPT-5.6 Terra", {
      exact: true,
    });
    const added = dialog.getByRole("checkbox", "Allow GPT-6 Sol", {
      exact: true,
    });
    const defaultNote = dialog.getByText(
      /openai\/gpt-5\.6-terra.*stays offered.*a built-in Bot on it is refused unless you allow it/,
    );
    await expect(checked).toBeChecked();
    await expect(defaultNote).toHaveCount(0);
    await checked.click();
    await added.click();
    await expect(defaultNote).toBeVisible();
    await dialog.getByRole("button", "Cancel", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual([]);
    await open.click();
    await expect(checked).toBeChecked();
    await expect(added).not.toBeChecked();
    await expect(defaultNote).toHaveCount(0);
    await dialog.getByRole("button", "Save", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => writes.slice())
      .toEqual([
        {
          method: "PUT",
          path: settingsPath,
          body: { value: { enabled: true, models: [defaultModel] } },
        },
      ]);
  });

  test("Permissions saves the organization switch and shows its updated state", async ({
    app,
    browser,
    screen,
  }) => {
    const writes = await serveModels(browser);
    await app.open("/admin/permissions");
    const permission = screen.getByRole("switch", "Use Bots", { exact: true });
    await expect(permission).toHaveAttribute("aria-checked", "true");
    await permission.click();
    await expect(permission).toHaveAttribute("aria-checked", "false");
    await expect(
      screen.getByRole("button", /Role and group overrides/),
    ).toBeVisible();
    await browser.reload();
    await expect(permission).toHaveAttribute("aria-checked", "false");
    expect(writes).toEqual([
      {
        method: "PUT",
        path: capabilityPath,
        body: {
          scopeKind: "organization",
          scopeId: "",
          capability: "useBots",
          allowed: false,
        },
      },
    ]);
  });

  test("a bookmarked Enterprise controls address opens the Admin overview", async ({
    app,
    browser,
  }) => {
    await app.open("/admin/enterprise");
    await expect(browser).toHaveURL("/admin");
  });
}
