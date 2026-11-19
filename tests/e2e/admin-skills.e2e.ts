import { type RouteFulfillResponse, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

type JsonObject = Record<string, NonNullable<RouteFulfillResponse["json"]>>;

const skillList = "/admin/skills";
const newSkill = `${skillList}/new`;

test("Admin creates, grants, lists, and deletes a deployment skill", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const first = await createBot(fixtures);
  const second = await createBot(fixtures);
  const roster = new Set([first.id, second.id]);
  await browser.route(/\/api\/agents(?:\?[^#]*)?$/, async (route) => {
    const response = await route.fetch();
    const { agents } = await response.json<{
      agents: (JsonObject & { id: string })[];
    }>();
    await route.fulfill({
      json: { agents: agents.filter((agent) => roster.has(agent.id)) },
    });
  });

  const command = `triage-${crypto.randomUUID().slice(0, 8)}`;
  const title = `Triage the inbox ${command.slice(-8)}`;
  const summary = "Sorts new mail by what needs an answer";
  const instructions = "Read unread mail and sort it.";
  const detail = `${skillList}/${command}`;
  const posts: unknown[] = [];
  const grants: unknown[] = [];
  const withdrawals: string[] = [];
  const deletions: string[] = [];
  await browser.route(
    /\/api\/plugins\/skills(?:\/[^/?#]+)?$/,
    async (route) => {
      const path = new URL(route.request.url).pathname;
      if (route.request.method === "POST") {
        posts.push(JSON.parse(route.request.postData ?? "null"));
      }
      if (route.request.method === "DELETE") deletions.push(path);
      await route.continue();
    },
  );
  await browser.route(/\/api\/plugins\/grants(?:\?[^#]*)?$/, async (route) => {
    if (route.request.method === "POST") {
      grants.push(JSON.parse(route.request.postData ?? "null"));
    }
    if (route.request.method === "DELETE") {
      withdrawals.push(new URL(route.request.url).search);
    }
    await route.continue();
  });

  await app.open(skillList);
  const newLink = browser.locator(`a[href="${newSkill}"]`).first();
  await expect(newLink).toContainText("New skill");
  await newLink.tap();
  await expect(browser).toHaveURL(newSkill);
  await screen.getByLabel("Command").fill(command.toUpperCase());
  await screen.getByLabel("Title").fill(title);
  await screen.getByLabel("One-liner").fill(summary);
  await screen.getByLabel("Instructions").fill(instructions);
  await screen.getByRole("button", "Save skill", { exact: true }).tap();
  await expect(browser).toHaveURL(detail);
  await expect(
    screen.getByRole("heading", title, { exact: true }),
  ).toBeVisible();
  expect(posts).toEqual([
    { slug: command, title, summary, instructions, tools: [], global: true },
  ]);

  const firstSwitch = screen.getByRole(
    "switch",
    `${first.name} offers ${title}`,
    { exact: true },
  );
  const secondSwitch = screen.getByRole(
    "switch",
    `${second.name} offers ${title}`,
    { exact: true },
  );
  for (const toggle of [firstSwitch, secondSwitch]) {
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  }
  await firstSwitch.tap();
  await expect(firstSwitch).toHaveAttribute("aria-checked", "false");
  expect(grants).toEqual(
    [first, second].map(({ id }) => ({
      kind: "skill",
      ref: command,
      agentId: id,
    })),
  );
  expect(withdrawals).toEqual([
    `?kind=skill&ref=${command}&agentId=${first.id}`,
  ]);

  const back = browser
    .locator(`a[href="${skillList}"]`)
    .filter({ hasText: "Skills" })
    .last();
  await back.tap();
  await expect(browser).toHaveURL(skillList);
  const row = browser.locator(`a[href="${detail}"]`);
  await expect(row).toContainText(title);
  await expect(row).toContainText(summary);
  await expect(row).toContainText("1 of 2 Bots");
  await expect(row).not.toContainText(`/${command}`);
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(
    browser.locator(`a[href="${detail}"] svg.tabler-icon-file-text`),
  ).toHaveCount(0);
  await row.tap();
  await expect(browser).toHaveURL(detail);
  await expect(secondSwitch).toHaveAttribute("aria-checked", "true");

  const remove = screen.getByRole("button", /^Delete People can.t run it/);
  const dialog = screen.getByRole("dialog");
  await remove.tap();
  await expect(
    dialog.getByRole("heading", `Delete ${title}?`, { exact: true }),
  ).toBeVisible();
  expect(deletions).toEqual([]);
  await dialog.getByRole("button", "Cancel", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  expect(deletions).toEqual([]);

  await remove.tap();
  await dialog.getByRole("button", "Delete", { exact: true }).tap();
  await expect(browser).toHaveURL(skillList);
  await expect(
    screen.getByRole("heading", "Skills", { exact: true }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(deletions).toEqual([`/api/plugins/skills/${command}`]);
  await app.open(detail);
  await expect(
    screen.getByText("Skill not found", { exact: true }),
  ).toBeVisible();
});

test("Admin selects skill tools in an app dialog and submits only the checked references", async ({
  app,
  browser,
  screen,
}) => {
  await browser.route(/\/api\/plugins$/, async (route) => {
    const response = await route.fetch();
    const page = await response.json<JsonObject>();
    await route.fulfill({
      json: {
        ...page,
        catalogue: [],
        servers: [
          {
            id: "notion",
            title: "Notion",
            logo: null,
            tools: [
              {
                name: "search_pages",
                description: "Search pages by title. Returns ids.",
                ref: "notion/search_pages",
                effect: "read",
              },
              {
                name: "create_page",
                description: "Create a page.",
                ref: "notion/create_page",
                effect: "write",
              },
            ],
          },
        ],
      },
    });
  });
  const writes: unknown[] = [];
  await browser.route(/\/api\/plugins\/skills$/, async (route) => {
    writes.push(JSON.parse(route.request.postData ?? "null"));
    await route.fulfill({ json: { ok: true } });
  });

  await app.open(newSkill);
  const appRow = screen.getByRole("button", /^Notion/);
  await expect(appRow).toContainText("None");
  await expect(
    screen.getByRole("button", "search_pages", { exact: true }),
  ).toHaveCount(0);
  await appRow.tap();
  const dialog = screen.getByRole("dialog");
  await expect(dialog.getByText("Search pages", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Search pages by title.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("changes things", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", "Select all", { exact: true }).tap();
  await expect(
    dialog.getByRole("button", "Clear all", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", "Done", { exact: true }).tap();
  await expect(appRow).toContainText("All 2 tools");

  await appRow.tap();
  await dialog.getByRole("button", "Clear all", { exact: true }).tap();
  await dialog.getByRole("checkbox", "Use Search pages", { exact: true }).tap();
  await dialog.getByRole("button", "Done", { exact: true }).tap();
  await expect(appRow).toContainText("Search pages");
  await expect(appRow).toContainText("1 of 2 tools");

  await screen.getByLabel("Command").fill("find-a-page");
  await screen.getByLabel("Title").fill("Find a page");
  await screen.getByLabel("Instructions").fill("Find it.");
  await screen.getByRole("button", "Save skill", { exact: true }).tap();
  await expect
    .poll(() => writes)
    .toEqual([
      {
        slug: "find-a-page",
        title: "Find a page",
        summary: "",
        instructions: "Find it.",
        tools: ["notion/search_pages"],
        global: true,
      },
    ]);
});
