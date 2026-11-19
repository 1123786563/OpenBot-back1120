import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const rule = (id: string, botId: string, toolRef: string) => ({
  id,
  botId,
  toolRef,
  effect: "*",
  scope: "*",
  behaviour: "ask",
});

test("Bot approval rules show matching personal rules and lock applicable team rules", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  let rules = [
    rule("own", bot.id, "mcp/gmail/*"),
    rule("pattern", `${bot.id.slice(0, -4)}*`, "mcp/linear/*"),
    rule("other", "other-bot", "mcp/drive/*"),
    rule("every", "*", "mcp/slack/*"),
  ];
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({
      json: {
        enabled: true,
        requests: [],
        questions: [],
        rules,
        teamRules: [
          rule("team-every", "*", "mcp/drive/share"),
          rule("team-own", bot.id, "computer_click"),
          rule("team-other", "other-bot", "host/*"),
        ],
        preferences: { enabled: true, autoReview: false, hostCommands: "ask" },
        team: {
          enforceAutoReview: false,
          customRulesEnabled: true,
          hostCommandsCap: "allow",
        },
        hostCommands: "ask",
      },
    }),
  );
  const writes: { path: string; method: string; body: unknown }[] = [];
  await browser.route(/\/api\/approvals\/rules(?:\/pattern)?$/, (route) => {
    const path = new URL(route.request.url).pathname;
    const { method, postData } = route.request;
    const body = JSON.parse(postData ?? "null");
    writes.push({ path, method, body });
    rules =
      method === "POST"
        ? [...rules, { ...body, id: "new-rule" }]
        : rules.filter(({ id }) => id !== "pattern");
    return route.fulfill({ json: { ok: true } });
  });

  await app.open(`/bots/${bot.id}/approvals`);
  await expect(
    screen.getByRole("heading", "Approval rules", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("combobox", "Behaviour for Any action on Gmail", {
      exact: true,
    }),
  ).toBeVisible();
  for (const hidden of [
    "Any action on Drive",
    "Any action on Slack",
    "Any action in your folders",
  ]) {
    await expect(screen.getByText(hidden, { exact: true })).toHaveCount(0);
  }
  for (const label of ["Share on Drive", "Click"]) {
    const row = browser
      .locator('[data-slot="item"]')
      .filter({ has: screen.getByText(label, { exact: true }) });
    await expect(row.getByText("Locked", { exact: true })).toBeVisible();
    await expect(row.getByRole("combobox")).toHaveCount(0);
    await expect(
      row.getByRole("button", "Remove", { exact: true }),
    ).toHaveCount(0);
  }

  const linear = screen.getByRole(
    "combobox",
    "Behaviour for Any action on Linear",
    { exact: true },
  );
  await expect(linear).toBeVisible();
  await browser
    .locator('[data-slot="item"]')
    .filter({ has: linear })
    .getByRole("button", "Remove", { exact: true })
    .tap();
  await expect(linear).toHaveCount(0);

  await screen.getByRole("button", /^Add a rule/).tap();
  const dialog = screen.getByRole("dialog");
  await expect(dialog.getByRole("textbox", "Bot", { exact: true })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("textbox", "Tool or app", { exact: true })
    .fill("mcp/notion/*");
  await dialog.getByRole("button", "Save rule", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  await expect(
    screen.getByRole("combobox", "Behaviour for Any action on Notion", {
      exact: true,
    }),
  ).toBeVisible();
  expect(writes).toEqual([
    { path: "/api/approvals/rules/pattern", method: "DELETE", body: null },
    {
      path: "/api/approvals/rules",
      method: "POST",
      body: {
        botId: bot.id,
        toolRef: "mcp/notion/*",
        effect: "*",
        scope: "*",
        behaviour: "ask",
      },
    },
  ]);
});
