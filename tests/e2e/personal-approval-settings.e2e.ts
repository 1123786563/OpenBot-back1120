import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const path = "/settings/approvals";
const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const collection = "/api/approvals/rules";
const refusal = "That tool is not one a Bot can use.";

function rule(
  id: string,
  toolRef: string,
  overrides: {
    botId?: string;
    effect?: string;
    scope?: string;
    behaviour?: string;
  } = {},
) {
  return {
    id,
    toolRef,
    botId: "*",
    effect: "*",
    scope: "*",
    behaviour: "allow",
    ...overrides,
  };
}

async function serveApprovals(
  browser: Browser,
  options: {
    role?: "admin" | "user";
    rules?: ReturnType<typeof rule>[];
    rulesEnabled?: boolean;
    enforce?: boolean;
    refuseFirst?: boolean;
  } = {},
) {
  let rules = options.rules ?? [rule("mine", "mcp/gmail/*")];
  const enforce = options.enforce ?? !personal;
  const writes: { method: string; path: string; body: unknown }[] = [];
  await browser.route(/\/api\/me$/, async (route) => {
    const data = await (await route.fetch()).json<{ user: { role: string } }>();
    return route.fulfill({
      json: { ...data, user: { ...data.user, role: options.role ?? "user" } },
    });
  });
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({
      json: {
        enabled: false,
        requests: [],
        rules,
        questions: [],
        teamRules: personal
          ? []
          : [rule("locked", "mcp/drive/share", { behaviour: "ask" })],
        preferences: {
          enabled: false,
          autoReview: false,
          hostCommands: "allow",
        },
        team: {
          enforceAutoReview: enforce,
          customRulesEnabled: options.rulesEnabled ?? true,
          hostCommandsCap: enforce ? "ask" : "allow",
        },
        hostCommands: enforce ? "ask" : "allow",
      },
    }),
  );
  await browser.route(/\/api\/approvals\/rules(?:\/[^/?]+)?$/, (route) => {
    const method = route.request.method;
    const path = new URL(route.request.url).pathname;
    const body = JSON.parse(route.request.postData ?? "null");
    writes.push({ method, path, body });
    if (method === "POST") {
      if (options.refuseFirst && writes.length === 1)
        return route.fulfill({ status: 400, json: { error: refusal } });
      rules.push({ ...body, id: "new-rule" });
    } else {
      const id = path.split("/").at(-1);
      if (method === "PATCH")
        rules = rules.map((entry) =>
          entry.id === id ? { ...entry, ...body } : entry,
        );
      if (method === "DELETE") rules = rules.filter((entry) => entry.id !== id);
    }
    return route.fulfill({ json: { ok: true } });
  });
  return writes;
}

if (!personal) {
  test("a team member can edit personal rules while team rules and enforced review stay locked", async ({
    app,
    browser,
    screen,
  }) => {
    const writes = await serveApprovals(browser);
    await app.open(path);
    await expect(
      screen.getByText("Ask before taking action (team rule)", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText("Locked", { exact: true })).toBeVisible();
    const policy = screen.getByRole("switch", "Auto-review", { exact: true });
    await expect(policy).toHaveAttribute("aria-checked", "true");
    await expect(policy).toBeDisabled();
    await expect(screen.getByText(/An admin requires this/)).toBeVisible();
    await expect(
      screen.getByText(/An admin limits this to "Ask every time"/),
    ).toBeVisible();
    await expect(
      screen.getByText("Team settings", { exact: true }),
    ).toHaveCount(0);
    await expect(
      screen.getByRole("link", "Admin → Approvals", { exact: true }),
    ).toHaveCount(0);
    const mine = screen.getByRole(
      "combobox",
      "Behaviour for Any action on Gmail",
      { exact: true },
    );
    await expect(mine).toContainText("Take action without asking");
    await mine.click();
    await screen
      .getByRole("option", "Hand off to you", { exact: true })
      .click();
    await expect(mine).toContainText("Hand off to you");
    await expect(
      screen.getByRole("combobox", "Behaviour for Share on Drive", {
        exact: true,
      }),
    ).toHaveCount(0);
    expect(writes).toEqual([
      {
        path: `${collection}/mine`,
        method: "PATCH",
        body: { behaviour: "hand_off" },
      },
    ]);
    await browser.reload();
    await expect(mine).toContainText("Hand off to you");
  });

  test("when personal rules are disabled the saved rule is locked and adding is unavailable", async ({
    app,
    browser,
    screen,
  }) => {
    const writes = await serveApprovals(browser, { rulesEnabled: false });
    await app.open(path);
    await expect(
      screen.getByText(
        /An admin has turned off personal rules\. Yours are kept but don't apply\./,
      ),
    ).toBeVisible();
    await expect(
      screen.getByText("Any action on Gmail", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("combobox", "Behaviour for Any action on Gmail", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(screen.getByRole("button", /Add a rule/)).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}

test("approval settings show edition-appropriate controls and describe what already requires approval", async ({
  app,
  browser,
  screen,
}) => {
  await serveApprovals(browser, { role: "admin", enforce: false });
  await app.open(path);
  await expect(
    screen.getByRole("heading", "Rules for every Bot", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("switch", "Extra vigilant", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("switch", "Auto-review", { exact: true }),
  ).toBeVisible();
  const admin = screen.getByRole("link", "Admin → Approvals", { exact: true });
  const shared = screen.getByRole("heading", "Shared Bots", { exact: true });
  if (personal) {
    await expect(admin).toHaveCount(0);
    await expect(shared).toHaveCount(0);
    await expect(screen.getByText(/Team rules are locked/)).toHaveCount(0);
  } else {
    await expect(admin).toHaveAttribute("href", "/admin/approvals");
    await expect(shared).toBeVisible();
    await expect(
      screen.getByRole("button", "Reset", { exact: true }),
    ).toBeVisible();
  }
  const main = screen.getByRole("main");
  for (const sentence of [
    "Bots ask for your approval before deleting, sending, sharing, posting, or paying in your apps or on websites. You can allow each one once, for a conversation, or always.",
    "They also ask before every edit or command in a folder on your own computer.",
    "Bots leave changing a password on a website for you to do yourself.",
    "Bots can create, edit, and delete files in their own workspace without asking, unless your settings or rules say so.",
    "Require your approval for every change to your apps, websites, and files, including routine edits and updates.",
  ])
    await expect(main).toContainText(sentence);
  await expect(main).not.toContainText(
    "Review a Bot's changes to websites, connected apps, and files.",
  );
});

test("a personal rule applies to every Bot and a refusal retains the form for retry", async ({
  app,
  browser,
  screen,
}) => {
  const writes = await serveApprovals(browser, { refuseFirst: true });
  await app.open(path);
  await screen.getByRole("button", /Add a rule/).click();
  const dialog = screen.getByRole("dialog");
  const tool = dialog.getByRole("textbox", "Tool or app", { exact: true });
  const select = dialog.getByRole("combobox", "Behaviour", { exact: true });
  const save = dialog.getByRole("button", "Save rule", { exact: true });
  const toolRef = "mcp/slack/*";
  await tool.fill(toolRef);
  await expect(dialog.getByRole("textbox", "Bot", { exact: true })).toHaveCount(
    0,
  );
  await select.click();
  await screen
    .getByRole("option", "Take action if pre-approved", { exact: true })
    .click();
  await save.click();
  const error = dialog.getByRole("alert");
  await expect(error).toBeVisible();
  await error.getByRole("button", "Details", { exact: true }).click();
  await expect(error.getByText(refusal, { exact: true })).toBeVisible();
  await expect(tool).toHaveValue(toolRef);
  await expect(select).toContainText("Take action if pre-approved");
  await save.click();
  await expect(dialog).toHaveCount(0);
  const slack = screen.getByRole(
    "combobox",
    "Behaviour for Any action on Slack",
    { exact: true },
  );
  await expect(slack).toContainText("Take action if pre-approved");
  const { id: _id, ...body } = rule("new-rule", toolRef, {
    behaviour: "pre_approved",
  });
  expect(writes).toEqual([
    { path: collection, method: "POST", body },
    { path: collection, method: "POST", body },
  ]);
  await browser.reload();
  await expect(slack).toBeVisible();
});

test("rules for one Bot live on its page, while a rule for an unavailable Bot can be removed", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const writes = await serveApprovals(browser, {
    rules: [
      rule("mine", "mcp/gmail/*"),
      rule("one-bot", "host/*", { botId: bot.id, behaviour: "ask" }),
      rule("orphan", "computer_click", { botId: "unknown-bot" }),
    ],
  });
  await app.open(path);
  await expect(
    screen.getByRole("link", "that Bot's page", { exact: true }),
  ).toHaveAttribute("href", "/bots");
  await expect(
    screen.getByRole("heading", "Rules for other Bots", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("combobox", "Behaviour for Any action in your folders", {
      exact: true,
    }),
  ).toHaveCount(0);
  const orphan = screen.getByRole("combobox", "Behaviour for Click", {
    exact: true,
  });
  await expect(orphan).toBeVisible();
  await browser
    .locator('[data-slot="item"]')
    .filter({ has: orphan })
    .getByRole("button", "Remove", { exact: true })
    .click();
  await expect(orphan).toHaveCount(0);
  await expect(
    screen.getByRole("heading", "Rules for other Bots", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([
    { path: `${collection}/orphan`, method: "DELETE", body: null },
  ]);
});

test("saved rules use action names and distinguish rules for the same action by their full scope", async ({
  app,
  browser,
  screen,
}) => {
  const host = "checkout.a-very-long-shop-name.example";
  await serveApprovals(browser, {
    rules: [
      rule("anywhere", "computer_click", { behaviour: "ask" }),
      rule("one-site", "computer_click", { effect: "write", scope: host }),
      rule("email", "composio-gmail/GMAIL_SEND_EMAIL", {
        scope: "composio-gmail",
      }),
    ],
  });
  await browser.setViewport({ width: 540, height: 920 });
  await app.open(path);
  await expect(
    screen.getByRole("combobox", "Behaviour for Click", { exact: true }),
  ).toHaveCount(2);
  await expect(
    screen.getByText("Send email on Gmail", { exact: true }),
  ).toBeVisible();
  const scope = `changes on ${host}`;
  await expect(screen.getByText(scope, { exact: true })).toBeVisible();
  const text = await browser.evaluate((scope) => {
    const detail = Array.from(
      document.querySelectorAll('[data-slot="item-description"]'),
    ).find((node) => node.textContent === scope);
    if (!detail) throw new Error("Missing scoped rule match");
    return {
      clamp: getComputedStyle(detail).webkitLineClamp,
      width: detail.clientWidth,
      scrollWidth: detail.scrollWidth,
    };
  }, scope);
  expect(text.clamp).toBe("none");
  expect(text.scrollWidth).toBeLessThanOrEqual(text.width + 1);
  await expect(screen.getByRole("main")).not.toContainText(
    /computer_click|composio|GMAIL_SEND_EMAIL/,
  );
});

test("folder rules name available folders and Bots and explain unavailable ones", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const grant = "host-grant-15407-1794112361547002000";
  await serveApprovals(browser, {
    rules: [
      rule("folder", "host/write_file", {
        botId: bot.id,
        effect: "write",
        scope: grant,
      }),
      rule("gone", "host/write_file", {
        botId: "old-bot",
        effect: "read",
        scope: "host-grant-1-2",
      }),
      rule("custom", "computer_click", {
        effect: "teleport",
        scope: "shop.example",
      }),
    ],
  });
  await browser.route(/\/api\/host-access$/, (route) =>
    route.fulfill({
      json: {
        connected: true,
        grants: [
          { id: grant, botId: bot.id, actorId: "me", displayName: "share" },
        ],
        pending: [],
      },
    }),
  );
  const main = screen.getByRole("main");
  await app.open(`/bots/${bot.id}/approvals`);
  await expect(
    screen.getByText(`changes in share for ${bot.name}`, { exact: true }),
  ).toBeVisible();
  await expect(main).not.toContainText(
    new RegExp(`host-grant|${bot.id}|\\bwrite\\b`, "i"),
  );
  await app.open(path);
  await expect(
    screen.getByText(
      "reading in a folder that's no longer shared for a Bot no longer here",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText("on shop.example", { exact: true }),
  ).toBeVisible();
  await expect(main).not.toContainText(/host-grant|old-bot|teleport/);
});
