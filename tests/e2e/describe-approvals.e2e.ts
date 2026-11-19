import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const SALES = "agent_5e2f8a90-1c3b-4d6e-8f70-a1b2c3d4e5f6";

/** What the real endpoint answered for this description, through the real screen. */
const OPPORTUNITIES = {
  rules: [
    {
      toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY*",
      effect: "write",
      scope: "composio-salesforce",
      botId: SALES,
      behaviour: "allow",
    },
  ],
  summary:
    "The Sales Assistant updates Salesforce opportunities without asking.",
  explanation:
    "The Sales Assistant updates Salesforce opportunities with the two listed opportunity-update tools without asking.",
  check: { ok: true },
  warning: null,
};

const REPORT = {
  scanned: 22,
  matched: 4,
  changed: 4,
  removedAsks: 4,
  removedDenied: 1,
  addedAsks: 0,
  fixed: 0,
  changes: [
    {
      id: "audit-1",
      createdAt: "2026-11-09T21:16:20.000Z",
      ownerUserId: "user-ben",
      initiator: { kind: "person", id: null },
      bot: SALES,
      toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY",
      effect: "write",
      scope: "composio-salesforce",
      subject: {},
      was: "ask",
      wasSource: "default",
      would: "allow",
      change: "removes_ask",
      person: "deny",
      rule: 1,
      reason: "Rule 1 takes action without asking.",
    },
  ],
};

/** The check the real backtest route makes of rows as they stand. */
function checked(rules: { toolRef: string }[]): {
  check:
    | { ok: true }
    | {
        ok: false;
        error: string;
        problems: { row: number; field: string; message: string }[];
      };
  warning: null;
  report: typeof REPORT;
} {
  const bad = rules.findIndex((rule) => rule.toolRef.startsWith("mcp/"));
  return {
    check:
      bad === -1
        ? { ok: true }
        : {
            ok: false,
            error: "no tool here starts with mcp/",
            problems: [
              {
                row: bad + 1,
                field: "toolRef",
                message: `"${rules[bad]?.toolRef}" matches no tool: no tool here starts with mcp/.`,
              },
            ],
          },
    warning: null,
    report:
      bad === -1
        ? REPORT
        : {
            ...REPORT,
            matched: 0,
            changed: 0,
            removedAsks: 0,
            removedDenied: 0,
            changes: [],
          },
  };
}

const TEXT =
  "Let the sales assistant update opportunities in Salesforce without asking";

const admin = "/admin/approvals";
const page = `${admin}/describe`;
const rulesApi = "/api/approvals/team/rules";

async function serveRules(browser: Browser) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  await browser.route(
    /\/api\/approvals\/team\/rules\/(translate|backtest|batch)$/,
    (route) => {
      const path = new URL(route.request.url).pathname;
      const body = JSON.parse(route.request.postData ?? "null");
      if (route.request.method === "POST") sent.push({ path, body });
      if (path.endsWith("/translate"))
        return route.fulfill({ json: OPPORTUNITIES });
      if (path.endsWith("/backtest"))
        return route.fulfill({ json: checked(body.rules) });
      return route.fulfill({ status: 201, json: { rules: body.rules } });
    },
  );
  return sent;
}

test("team rules written in words provide editable fields, replay results, and an explicit save", async ({
  app,
  browser,
  screen,
}) => {
  const sent = await serveRules(browser);
  await app.open(admin);
  await screen.getByRole("link", /Describe it in words/).click();
  await expect(browser).toHaveURL(page);
  await screen.getByLabel("Describe the rules", { exact: true }).fill(TEXT);
  await screen.getByRole("button", "Write rules", { exact: true }).click();
  await expect(
    screen.getByText(OPPORTUNITIES.explanation, { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText(
      "Checks. Every rule matches tools and Bots this OpenBot has.",
      { exact: true },
    ),
  ).toBeVisible();
  const tool = screen.getByLabel("Tool or app", { exact: true });
  await expect(tool).toHaveValue(OPPORTUNITIES.rules[0]?.toolRef ?? "");
  await expect(tool).toBeEnabled();
  await expect(
    screen.getByText(
      "Would have changed 4 decisions: removes 4 asks, of which 1 a person had denied; adds 0 asks.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText("A person denied it.", { exact: true }),
  ).toBeVisible();
  expect(sent.some(({ path }) => path === `${rulesApi}/translate`)).toBe(true);
  expect(
    sent.find(({ path }) => path === `${rulesApi}/backtest`)?.body,
  ).toEqual({ rules: OPPORTUNITIES.rules });
  expect(sent.filter(({ path }) => path === `${rulesApi}/batch`)).toEqual([]);

  const save = screen.getByRole("button", "Save rules", { exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(browser).toHaveURL(admin);
  expect(sent.filter(({ path }) => path === `${rulesApi}/batch`)).toEqual([
    {
      path: `${rulesApi}/batch`,
      body: {
        rules: OPPORTUNITIES.rules,
        authoring: { source: "english", text: TEXT },
      },
    },
  ]);
});

test("editing a written rule triggers a fresh check and a refusal prevents saving", async ({
  app,
  browser,
  screen,
}) => {
  const sent = await serveRules(browser);
  await app.open(page);
  await screen.getByLabel("Describe the rules", { exact: true }).fill(TEXT);
  await screen.getByRole("button", "Write rules", { exact: true }).click();
  await expect(
    screen.getByText(OPPORTUNITIES.explanation, { exact: true }),
  ).toBeVisible();
  const save = screen.getByRole("button", "Save rules", { exact: true });
  await expect(save).toBeEnabled();
  await expect(screen.getByText(/You've changed the rules/)).toHaveCount(0);
  const tool = screen.getByLabel("Tool or app", { exact: true });
  await tool.fill("mcp/salesforce/*");
  await expect(
    screen.getByText(
      "You've changed the rules since they were written. The check and the reading above are for the written rules, not your edit.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    screen.getByText(
      '"mcp/salesforce/*" matches no tool: no tool here starts with mcp/.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  const validTool = "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY";
  await tool.fill(validTool);
  await expect(save).toBeEnabled();
  const checked = sent.filter(({ path }) => path === `${rulesApi}/backtest`);
  expect(checked.at(-2)?.body).toMatchObject({
    rules: [{ toolRef: "mcp/salesforce/*" }],
  });
  expect(checked.at(-1)?.body).toMatchObject({
    rules: [{ toolRef: validTool }],
  });
  expect(sent.filter(({ path }) => path === `${rulesApi}/batch`)).toEqual([]);
});
