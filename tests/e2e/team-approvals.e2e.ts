import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const path = "/admin/approvals";
const rule = (id: string, toolRef: string) => ({
  id,
  botId: "*",
  toolRef,
  effect: "*",
  scope: "*",
  behaviour: "ask",
});

async function serveTeam(browser: Browser) {
  const team = {
    enforceAutoReview: true,
    customRulesEnabled: true,
    hostCommandsCap: "ask",
  };
  const teamRules = [rule("locked", "mcp/drive/share")];
  const writes: { path: string; method: string; body: unknown }[] = [];
  await browser.route(/\/api\/approvals$/, (route) =>
    route.fulfill({
      json: {
        enabled: false,
        requests: [],
        questions: [],
        rules: [rule("mine", "mcp/gmail/*")],
        teamRules,
        preferences: {
          enabled: false,
          autoReview: false,
          hostCommands: "allow",
        },
        team,
        hostCommands: team.hostCommandsCap,
      },
    }),
  );
  await browser.route(/\/api\/approvals\/shared-use$/, (route) =>
    route.fulfill({ json: { requests: [] } }),
  );
  await browser.route(/\/api\/approvals\/team(?:\/rules)?$/, (route) => {
    const path = new URL(route.request.url).pathname;
    const method = route.request.method;
    const body = JSON.parse(route.request.postData ?? "null");
    writes.push({ path, method, body });
    if (path.endsWith("/rules")) teamRules.push({ ...body, id: "new-rule" });
    else Object.assign(team, body);
    return route.fulfill({ json: { ok: true } });
  });
  return writes;
}

test("an administrator changes the team command limit and sees only team rules", async ({
  app,
  browser,
  screen,
}) => {
  const writes = await serveTeam(browser);
  await app.open(path);
  await expect(
    screen.getByText("Team settings", { exact: true }),
  ).toBeVisible();
  const cap = screen.getByRole(
    "combobox",
    "Commands on members' computers, at most",
    { exact: true },
  );
  await cap.click();
  await screen.getByRole("option", "Never", { exact: true }).click();
  await expect(cap).toContainText("Never");
  await expect(
    screen.getByRole("button", "Remove", { exact: true }),
  ).toHaveCount(1);
  await expect(
    screen.getByText("Any action on Gmail", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([
    {
      path: "/api/approvals/team",
      method: "PATCH",
      body: { hostCommandsCap: "never" },
    },
  ]);
  await browser.reload();
  await expect(cap).toContainText("Never");
});

test("an administrator adds a team rule for every Bot and it remains after reload", async ({
  app,
  browser,
  screen,
}) => {
  const writes = await serveTeam(browser);
  await app.open(path);
  await screen.getByRole("button", /Add a team rule/).click();
  const dialog = screen.getByRole("dialog");
  await dialog
    .getByRole("textbox", "Tool or app", { exact: true })
    .fill("mcp/slack/*");
  await dialog.getByRole("button", "Save rule", { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const slackRule = screen.getByText("Any action on Slack", { exact: true });
  await expect(slackRule).toBeVisible();
  const { id: _id, ...body } = rule("new-rule", "mcp/slack/*");
  expect(writes).toEqual([
    { path: "/api/approvals/team/rules", method: "POST", body },
  ]);
  await browser.reload();
  await expect(slackRule).toBeVisible();
});

const sharedRequest = {
  id: "r1",
  botId: "bot1",
  botName: "Helpdesk",
  ownerUserId: "dana",
  serverId: "gh",
  title: "Team GitHub",
  proposed: { audience: "team", outsideInput: true, members: [] },
  current: { audience: "owner", outsideInput: false, members: [] },
  reason: "refused_call",
  requestedBy: "sam",
  status: "pending",
  createdAt: "2026-10-07T03:00:00.000Z",
};

for (const conflict of [false, true]) {
  test(`shared account decisions ${conflict ? "report a request already decided elsewhere" : "update the admin's pending list"}`, async ({
    app,
    browser,
    screen,
  }) => {
    await serveTeam(browser);
    let pending = true;
    const writes: string[] = [];
    await browser.route(/\/api\/approvals\/shared-use$/, (route) =>
      route.fulfill({ json: { requests: pending ? [sharedRequest] : [] } }),
    );
    await browser.route(
      /\/api\/approvals\/shared-use\/r1\/(approve|decline)$/,
      (route) => {
        const { method, url } = route.request;
        writes.push(`${method} ${new URL(url).pathname}`);
        if (conflict)
          return route.fulfill({
            status: 409,
            json: { error: "That request has already been decided." },
          });
        pending = false;
        return route.fulfill({
          json: { request: { ...sharedRequest, status: "approved" } },
        });
      },
    );
    await app.open(path);
    const title = screen.getByText(
      "Helpdesk wants the shared Team GitHub account",
      { exact: true },
    );
    await expect(title).toBeVisible();
    await expect(
      screen.getByText("Now: Only its owner", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText("Asked: Everyone, and outside input", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByText(
        "An action was blocked. This Bot reaches more people than approved.",
        { exact: true },
      ),
    ).toBeVisible();
    await screen
      .getByRole("button", conflict ? "Decline" : "Approve", { exact: true })
      .click();
    if (conflict) {
      const alert = screen
        .getByRole("alert")
        .filter({ hasText: "This item changed" });
      await expect(alert).toBeVisible();
      await alert.getByRole("button", "Details", { exact: true }).click();
      await expect(
        alert.getByText("That request has already been decided.", {
          exact: true,
        }),
      ).toBeVisible();
    } else {
      await expect(title).toHaveCount(0);
      await browser.reload();
      await expect(
        screen.getByRole("heading", "Approvals", { exact: true }),
      ).toBeVisible();
      await expect(title).toHaveCount(0);
    }
    expect(writes).toEqual([
      `POST /api/approvals/shared-use/r1/${conflict ? "decline" : "approve"}`,
    ]);
  });
}

test("a member cannot open the team approvals page or read shared account requests", async ({
  app,
  browser,
  screen,
}) => {
  const reads: string[] = [];
  await browser.route(/\/api\/me$/, async (route) => {
    const data = await (await route.fetch()).json<{ user: { role: string } }>();
    return route.fulfill({
      json: { ...data, user: { ...data.user, role: "user" } },
    });
  });
  await browser.route(/\/api\/approvals\/shared-use$/, (route) => {
    reads.push(route.request.method);
    return route.fulfill({ json: { requests: [sharedRequest] } });
  });
  await app.open(path);
  await expect(browser).toHaveURL("/");
  await expect(
    screen.getByRole("heading", "Shared account requests", { exact: true }),
  ).toHaveCount(0);
  expect(reads).toEqual([]);
});
