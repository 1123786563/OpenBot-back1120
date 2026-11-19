import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

type Bot = Awaited<ReturnType<typeof createBot>>;
type Audience = {
  audience: "people" | "team";
  emails: string[];
  groups: string[];
};

async function serveSharing(
  browser: Browser,
  bot: Bot,
  state: {
    mine: boolean;
    role: "admin" | "user";
    visibility: "private" | "public";
    publication: Audience | null;
    assignments: string[];
  },
) {
  const writes: { path: string; method: string; body: unknown }[] = [];
  await browser.route(/\/api\/me$/, async (route) => {
    const response = await route.fetch();
    const data = await response.json<{ user: Record<string, unknown> }>();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...data,
        user: { ...data.user, role: state.role },
      }),
    });
  });
  await browser.route(
    new RegExp(`/api/agents/${RegExp.escape(bot.id)}$`),
    async (route) => {
      const response = await route.fetch();
      const data = await response.json<{ agent: Record<string, unknown> }>();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...data,
          agent: {
            ...data.agent,
            mine: state.mine,
            canManage: state.mine || state.role === "admin",
            visibility: state.visibility,
          },
        }),
      });
    },
  );
  await browser.route(/\/api\/team-bots$/, (route) => {
    const { publication, assignments, mine } = state;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        teamBots: publication
          ? [
              {
                ...bot,
                title: "Finance",
                roleDescription: "Receipts.",
                mine,
                audience: publication.audience,
                publishedAt: "2026-10-01T00:00:00Z",
                assigned: false,
                visibleToTeam: true,
                people: publication.emails,
                groups: publication.groups,
                assignments,
              },
            ]
          : [],
        publishable: mine && !publication ? [{ ...bot, title: "Finance" }] : [],
      }),
    });
  });
  const base = `/api/team-bots/${bot.id}`;
  await browser.route(
    new RegExp(
      `${RegExp.escape(base)}/(?:publication|assignments(?:/[^/?]+)?)$`,
    ),
    (route) => {
      const path = new URL(route.request.url).pathname;
      const { method, postData } = route.request;
      const body = JSON.parse(postData ?? "null");
      writes.push({ path, method, body });
      if (path === `${base}/publication`) {
        state.publication = method === "DELETE" ? null : body;
      } else if (method === "POST") {
        state.assignments = [...state.assignments, body.group];
      } else {
        const group = decodeURIComponent(
          path.slice(`${base}/assignments/`.length),
        );
        state.assignments = state.assignments.filter(
          (current) => current !== group,
        );
      }
      return route.fulfill({ json: { ok: true } });
    },
  );
  return writes;
}

test("an owner can publish to named recipients, copy the private conversation link, update and unpublish", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const writes = await serveSharing(browser, bot, {
    mine: true,
    role: "user",
    visibility: "private",
    publication: null,
    assignments: [],
  });
  await browser.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async (text: string) =>
        sessionStorage.setItem("e2e-copied-bot-link", text),
    });
  });
  await app.open(`/bots/${bot.id}/sharing`);
  const audienceRow = screen.getByRole("button", /^Audience/);
  const unpublish = screen.getByRole("button", "Unpublish", { exact: true });
  await expect(audienceRow).toContainText("Not published");
  await expect(
    screen.getByText("Only you can use it.", { exact: true }),
  ).toBeVisible();
  await expect(unpublish).toHaveCount(0);
  await audienceRow.tap();
  const dialog = screen.getByRole("dialog");
  const publish = dialog.getByRole("button", "Publish to team", {
    exact: true,
  });
  await expect(publish).toBeVisible();
  await dialog.getByRole("combobox", "Published to", { exact: true }).tap();
  await screen
    .getByRole("option", "Specific people or groups", { exact: true })
    .tap();
  await dialog
    .getByLabel("People, by email", { exact: true })
    .fill("a@example.test, b@example.test");
  await dialog.getByLabel("Groups", { exact: true }).fill("finance");
  await publish.tap();
  await expect(dialog).toHaveCount(0);
  await expect(audienceRow).toContainText("2 people, 1 group");
  await expect(
    screen.getByText("To a@example.test, b@example.test, group finance", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(screen.getByRole("button", /^Assign to a group/)).toHaveCount(0);

  await screen.getByRole("button", "Copy link", { exact: true }).tap();
  await expect(
    screen.getByRole("button", "Copied", { exact: true }),
  ).toBeVisible();
  const copied = await browser.evaluate(() =>
    sessionStorage.getItem("e2e-copied-bot-link"),
  );
  const privateChat = new URL(
    `/channel/new?agent=${encodeURIComponent(bot.id)}`,
    app.baseUrl,
  );
  expect(copied).toBe(privateChat.href);

  await audienceRow.tap();
  await expect(
    dialog.getByLabel("People, by email", { exact: true }),
  ).toHaveValue("a@example.test, b@example.test");
  await expect(dialog.getByLabel("Groups", { exact: true })).toHaveValue(
    "finance",
  );
  await dialog.getByRole("combobox", "Published to", { exact: true }).tap();
  await screen.getByRole("option", "The whole team", { exact: true }).tap();
  await dialog.getByRole("button", "Update", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  await expect(
    screen.getByText("To the whole team", { exact: true }),
  ).toBeVisible();
  await unpublish.tap();
  await expect(unpublish).toHaveCount(0);
  await expect(audienceRow).toContainText("Not published");
  await expect(
    screen.getByRole("button", "Copy link", { exact: true }),
  ).toHaveCount(0);
  const path = `/api/team-bots/${bot.id}/publication`;
  expect(writes).toEqual([
    {
      path,
      method: "PUT",
      body: {
        audience: "people",
        emails: ["a@example.test", "b@example.test"],
        groups: ["finance"],
      },
    },
    { path, method: "PUT", body: { audience: "team", emails: [], groups: [] } },
    { path, method: "DELETE", body: null },
  ]);
});

test("an admin assigns and removes groups on another owner's published Bot", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const writes = await serveSharing(browser, bot, {
    mine: false,
    role: "admin",
    visibility: "private",
    publication: { audience: "team", emails: [], groups: [] },
    assignments: [],
  });
  await app.open(`/bots/${bot.id}/sharing`);
  await expect(
    screen.getByText("Not assigned to any group", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByRole("button", /^Audience/)).toHaveCount(0);
  await expect(screen.getByRole("button", /^(Update|Unpublish)$/)).toHaveCount(
    0,
  );
  const trigger = screen.getByRole("button", "Assign to a group", {
    exact: true,
  });
  const dialog = screen.getByRole("dialog");
  const assign = dialog.getByRole("button", "Assign", { exact: true });
  for (const group of ["*", "finance"]) {
    await trigger.tap();
    await expect(assign).toBeDisabled();
    await dialog.getByLabel("Group, or *", { exact: true }).fill(group);
    await assign.tap();
    await expect(dialog).toHaveCount(0);
  }
  await expect(screen.getByText("Whole team", { exact: true })).toBeVisible();
  const remove = screen.getByRole("button", "Remove finance", { exact: true });
  await remove.tap();
  await expect(remove).toHaveCount(0);
  await expect(screen.getByText("Whole team", { exact: true })).toBeVisible();
  const path = `/api/team-bots/${bot.id}/assignments`;
  expect(writes).toEqual([
    { path, method: "POST", body: { group: "*" } },
    { path, method: "POST", body: { group: "finance" } },
    { path: `${path}/finance`, method: "DELETE", body: null },
  ]);
});

test("unpublished sharing describes public access and respects private ownership", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const state = {
    mine: true,
    role: "user" as "admin" | "user",
    visibility: "public" as "private" | "public",
    publication: null,
    assignments: [],
  };
  await serveSharing(browser, bot, state);
  const path = `/bots/${bot.id}/sharing`;
  await app.open(path);
  await expect(
    screen.getByText(/everyone on OpenBot can already use it/),
  ).toBeVisible();
  const ownerOnly = screen.getByText("Only you can use it.", { exact: true });
  await expect(ownerOnly).toHaveCount(0);

  state.mine = false;
  state.role = "admin";
  state.visibility = "private";
  await app.open(path);
  await expect(
    screen.getByText("Not published", { exact: true }),
  ).toBeVisible();
  await expect(ownerOnly).toHaveCount(0);
  await expect(screen.getByRole("button", /^Audience/)).toHaveCount(0);
});

test("a Bot owner can request shared account approval once and an administrator sees the publishing effect", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const state = {
    mine: true,
    role: "user" as "admin" | "user",
    visibility: "private" as const,
    publication: null,
    assignments: [],
  };
  await serveSharing(browser, bot, state);
  const writes: unknown[] = [];
  const serverId = "gh";
  let shared = false;
  let covered = false;
  let requested = false;
  await browser.route(/\/api\/approvals\/shared-use\/bot\/[^/]+$/, (route) =>
    route.fulfill({
      json: {
        apps: shared
          ? [
              {
                serverId,
                title: "Team GitHub",
                covered,
                approval: {
                  audience: "owner",
                  outsideInput: false,
                  members: [],
                },
                needed: { audience: "team", outsideInput: false, members: [] },
              },
            ]
          : [],
        pending: requested ? [{ serverId, id: "r1" }] : [],
      },
    }),
  );
  await browser.route(/\/api\/approvals\/shared-use$/, (route) => {
    writes.push({
      method: route.request.method,
      body: JSON.parse(route.request.postData ?? "null"),
    });
    requested = true;
    return route.fulfill({ status: 201, json: { id: "r1", created: true } });
  });
  const profile = `/bots/${bot.id}`;
  await app.open(profile);
  const heading = screen.getByRole("heading", bot.name, { exact: true });
  const ask = screen.getByRole("button", "Request approval for Team GitHub", {
    exact: true,
  });
  const instruction = screen.getByText(
    /can't use the shared Team GitHub account until an admin approves/,
  );
  const pending = screen.getByText(
    "Waiting for an admin to approve the shared Team GitHub account.",
    { exact: true },
  );
  await expect(heading).toBeVisible();
  await expect(ask).toHaveCount(0);
  await expect(instruction).toHaveCount(0);
  shared = true;
  await browser.reload();
  await expect(instruction).toBeVisible();
  await ask.click();
  await expect(pending).toBeVisible();
  await expect(ask).toHaveCount(0);
  expect(writes).toEqual([
    { method: "POST", body: { botId: bot.id, serverId, reason: "publish" } },
  ]);
  await browser.reload();
  await expect(pending).toBeVisible();
  await expect(ask).toHaveCount(0);

  state.role = "admin";
  covered = true;
  requested = false;
  await browser.reload();
  await expect(
    screen.getByText(
      /Saving also lets everyone who can use this Bot use the shared Team GitHub account/,
    ),
  ).toBeVisible();
  await expect(ask).toHaveCount(0);
  await expect(pending).toHaveCount(0);
  expect(writes).toHaveLength(1);
});
