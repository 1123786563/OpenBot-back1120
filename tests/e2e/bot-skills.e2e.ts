import { type RouteFulfillResponse, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";
import { grantSkill, installSkill } from "./skills";

function testSkill(title: string) {
  return {
    slug: `e2e-skill-${crypto.randomUUID().slice(0, 8)}`,
    title,
    summary: `A test summary for ${title}.`,
    instructions: "Reply with a short test summary.",
  };
}

test("a Bot owner sees skill grants by title and can grant a second skill", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { id } = await createBot(fixtures);
  const on = testSkill("Tide report");
  const off = testSkill("Receipt summary");
  const shared = { ...testSkill("Shared skill"), global: true };
  const another = testSkill("Another person's skill");
  for (const skill of [on, off, shared]) await installSkill(browser, skill);
  await grantSkill(browser, id, on.slug);
  const writes: unknown[] = [];
  await browser.route(/\/api\/plugins\/grants$/, async (route) => {
    if (route.request.method === "POST") {
      writes.push(JSON.parse(route.request.postData ?? "null"));
    }
    await route.continue();
  });
  await browser.route(/\/api\/plugins$/, async (route) => {
    const response = await route.fetch();
    const page = await response.json<{
      skills: NonNullable<RouteFulfillResponse["json"]>[];
    }>();
    await route.fulfill({
      json: {
        ...page,
        skills: [
          ...page.skills,
          {
            ...another,
            id: another.slug,
            ownerUserId: "other-user",
            grantedTo: [],
          },
        ],
      },
    });
  });
  await app.open(`/bots/${id}/access`);
  const active = screen.getByRole("switch", on.title, { exact: true });
  const inactive = screen.getByRole("switch", off.title, { exact: true });
  await expect(active).toHaveAttribute("aria-checked", "true");
  await expect(inactive).toHaveAttribute("aria-checked", "false");
  await expect(
    screen.getByRole("switch", shared.title, { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("switch", another.title, { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByText(
      "Turn on a skill to use it with this Bot. Type / in a conversation to run it.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(screen.getByText(on.title, { exact: true })).toHaveCount(2);
  await expect(screen.getByText(`/${on.slug}`, { exact: true })).toHaveCount(0);

  await inactive.tap();

  await expect
    .poll(() => writes)
    .toEqual([{ kind: "skill", ref: off.slug, agentId: id }]);
  await expect(inactive).toHaveAttribute("aria-checked", "true");
  await browser.reload();
  await expect(inactive).toHaveAttribute("aria-checked", "true");
  await expect(active).toHaveAttribute("aria-checked", "true");
  await expect(screen.getByText(off.title, { exact: true })).toHaveCount(2);
});

test("a public Bot owned by someone else has no skill switches", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const owned = testSkill("My private skill");
  await installSkill(browser, owned);
  await browser.route(/\/api\/plugins\/for\/general-assistant$/, (route) =>
    route.fulfill({ json: { tools: [], skills: [] } }),
  );
  await browser.route(
    /\/api\/plugins\/for\/general-assistant\/apps$/,
    (route) => route.fulfill({ json: { apps: [] } }),
  );
  await app.open("/bots/general-assistant/access");
  await expect(
    screen.getByRole("heading", "Skills and access", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("No apps yet", { exact: true })).toBeVisible();
  await expect(screen.getByText(/^An admin has to add them\./)).toBeVisible();
  await expect(
    screen.getByRole("heading", "Your skills", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("switch", owned.title, { exact: true }),
  ).toHaveCount(0);
});

for (const missing of ["catalogue", "grant list"]) {
  test(`Bot skills reports a failed ${missing} request`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const { id } = await createBot(fixtures);
    const skill = testSkill("Owned skill");
    await installSkill(browser, skill);
    await grantSkill(browser, id, skill.slug);
    const failedPath =
      missing === "catalogue"
        ? /\/api\/plugins$/
        : new RegExp(`/api/plugins/for/${RegExp.escape(id)}$`);
    await browser.route(failedPath, (route) =>
      route.fulfill({
        status: 500,
        json: { error: "Test skill lookup failed" },
      }),
    );
    await app.open(`/bots/${id}/access`);
    await expect(
      screen.getByText("Couldn't load your skills. Reload the page.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      screen.getByText("No skills yet", { exact: true }),
    ).toHaveCount(0);
    await expect(
      screen.getByRole("switch", skill.title, { exact: true }),
    ).toHaveCount(0);
  });
}
