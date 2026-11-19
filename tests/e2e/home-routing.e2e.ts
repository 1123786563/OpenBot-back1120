import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const sharedId = "general-assistant";

async function observeStarts(browser: Browser) {
  const starts: unknown[] = [];
  await browser.route(/\/api\/channels$/, async (route) => {
    if (route.request.method === "POST") {
      starts.push(JSON.parse(route.request.postData ?? "null"));
    }
    await route.continue();
  });
  return starts;
}

for (const scenario of [
  "linked draft",
  "routing unavailable",
  "routing succeeds",
]) {
  test(`home sends to the right Bot when ${scenario}`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const { id: ownedId } = await createBot(fixtures);
    await browser.route(/\/api\/agents$/, async (route) => {
      const response = await route.fetch();
      const { agents } = await response.json<{ agents: { id: string }[] }>();
      const own = agents.find(({ id }) => id === ownedId);
      const shared = agents.find(({ id }) => id === sharedId);
      if (!own || !shared)
        throw new Error(
          "Expected the owned Bot and the shared assistant in the roster",
        );
      await route.fulfill({
        json: {
          agents: [
            { ...own, visibility: "public" },
            ...(scenario === "linked draft" ? [] : [shared]),
          ],
        },
      });
    });
    await browser.route(/\/api\/route$/, async (route) => {
      if (scenario === "routing succeeds") {
        await route.fulfill({
          json: {
            agentId: sharedId,
            fallback: false,
            name: "General Assistant",
            reason: "matched",
            viaMention: false,
          },
        });
      } else {
        await route.fulfill({
          status: 503,
          json: { error: "Fixture router unavailable" },
        });
      }
    });
    const starts = await observeStarts(browser);
    const message = scenario === "linked draft" ? "Find my meeting" : "hello";
    await app.open(
      scenario === "linked draft"
        ? `/?ask=${encodeURIComponent(message)}`
        : "/",
    );
    const editor = screen.getByRole("textbox", "Message");
    if (scenario === "linked draft") {
      await expect(editor).toHaveText(message);
      expect(starts).toEqual([]);
    } else {
      await editor.fill(message);
    }
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await expect
      .poll(() => starts)
      .toEqual([
        { agentIds: [scenario === "routing succeeds" ? sharedId : ownedId] },
      ]);
    await expect(browser).toHaveURL(/\/channel\//);
    await expect(screen.getByText(message, { exact: true })).toBeVisible();
  });
}

test("an ambiguous routing decision explains the refusal and restores the draft", async ({
  app,
  browser,
  screen,
}) => {
  const starts = await observeStarts(browser);
  await browser.route(/\/api\/route$/, async (route) => {
    await route.fulfill({
      status: 409,
      json: {
        error: "More than one coworker matches that name.",
        names: ["Data Analyst", "Risk Analyst"],
      },
    });
  });
  await app.open("/");
  const editor = screen.getByRole("textbox", "Message");
  await editor.fill("ask analyst");
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect(screen.getByRole("alert")).toContainText(
    "Data Analyst, Risk Analyst",
  );
  await expect(editor).toHaveText("ask analyst");
  await expect(browser).toHaveURL("/");
  expect(starts).toEqual([]);
});

for (const mode of ["wait in Starting", "go back home", "write a new draft"]) {
  test(`home preserves the right draft while routing is pending: ${mode}`, async ({
    app,
    browser,
    screen,
  }) => {
    const starts = await observeStarts(browser);
    let routeRequested = false;
    const release = Promise.withResolvers<void>();
    await browser.route(/\/api\/route$/, async (route) => {
      routeRequested = true;
      await release.promise;
      await route.fulfill({
        status: 409,
        json: {
          error: "More than one coworker matches that name.",
          names: ["Data Analyst", "Risk Analyst"],
        },
      });
    });
    const editor = screen.getByRole("textbox", "Message");
    const home = screen.getByRole("link", "OpenBot", { exact: true });
    const alert = screen.getByRole("alert");

    try {
      await app.open("/");
      await editor.fill("ask analyst");
      await screen.getByRole("button", "Send message", { exact: true }).tap();
      await expect.poll(() => routeRequested).toBe(true);
      await expect(browser).toHaveURL(/\/start\/[^/?#]+$/);
      await expect(
        screen.getByText("Picking a Bot", { exact: true }),
      ).toBeVisible();
      await expect(
        screen.getByText("ask analyst", { exact: true }),
      ).toBeVisible();
      expect(starts).toEqual([]);

      if (mode !== "wait in Starting") {
        await home.tap();
        await expect(browser).toHaveURL("/");
        await expect(editor).toHaveText("");
      }
      if (mode === "write a new draft") {
        await editor.pressSequentially("something new");
      }
      const routeResponse = browser.waitForResponse(/\/api\/route$/);
      release.resolve();
      expect((await routeResponse).status).toBe(409);

      if (mode === "write a new draft") {
        await expect(editor).toHaveText("something new");
        await screen.getByRole("link", /^Bots(?: Unread messages)?$/).tap();
        await expect(browser).toHaveURL("/bots");
        await expect(
          screen.getByRole("heading", "Bots", { exact: true }),
        ).toBeVisible();
        await home.tap();
      }
      await expect(browser).toHaveURL("/");
      await expect(alert).toContainText("Data Analyst, Risk Analyst");
      await expect(editor).toHaveText("ask analyst");
      expect(starts).toEqual([]);
    } finally {
      release.resolve();
    }
  });
}

for (const status of [409, 500]) {
  test(`skill routing failure ${status} preserves the draft without a fallback`, async ({
    app,
    browser,
    screen,
  }) => {
    const starts = await observeStarts(browser);
    const requests: unknown[] = [];
    const grantedSkills = /\/api\/plugins\/for\/general-assistant$/;
    await browser.route(grantedSkills, async (route) => {
      await route.fulfill({
        json: {
          tools: [],
          skills: [
            { slug: "first", title: "First skill", instructions: "Use first" },
          ],
        },
      });
    });
    await browser.route(/\/api\/route$/, async (route) => {
      requests.push(JSON.parse(route.request.postData ?? "null"));
      await route.fulfill({
        status,
        json: { error: "Cannot route these skills" },
      });
    });
    const skillsResponse = browser.waitForResponse(grantedSkills);
    await app.open("/");
    expect((await skillsResponse).status).toBe(200);
    const editor = screen.getByRole("textbox", "Message");
    await editor.pressSequentially("/first");
    await screen.getByRole("option", /First skill/).tap();
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await expect(screen.getByRole("alert")).toContainText(
      "Cannot route these skills",
    );
    await expect(editor).toContainText("/first");
    await expect(browser).toHaveURL("/");
    expect(requests).toEqual([{ text: "/first", skillSlugs: ["first"] }]);
    expect(starts).toEqual([]);
  });
}

test("the start screen shows the named Bot and its first message while creation is pending", async ({
  app,
  browser,
  screen,
}) => {
  const release = Promise.withResolvers<void>();
  const starts: unknown[] = [];
  await browser.route(/\/api\/channels$/, async (route) => {
    if (route.request.method === "POST") {
      starts.push(JSON.parse(route.request.postData ?? "null"));
      await release.promise;
      await route.abort();
    } else {
      await route.continue();
    }
  });
  try {
    await app.open("/");
    const editor = screen.getByRole("textbox", "Message");
    await editor.pressSequentially("@Knowledge");
    await screen.getByRole("option", /^Knowledge/).tap();
    await editor.pressSequentially("Summarize our onboarding policy");
    await screen.getByRole("button", "Send message", { exact: true }).tap();

    await expect(browser).toHaveURL(/\/start\/[^/?#]+$/);
    await expect.poll(() => starts).toEqual([{ agentIds: ["knowledge"] }]);
    await expect(
      screen.getByRole("heading", "Knowledge", { exact: true, level: 1 }),
    ).toBeVisible();
    await expect(
      browser.locator('[data-slot="conversation-header"]'),
    ).toContainText("Knowledge");
    await expect(
      browser.locator('[data-slot="message-scroller-viewport"]'),
    ).toContainText("Summarize our onboarding policy");
    await expect(editor).toHaveAttribute("aria-disabled", "true");
  } finally {
    release.resolve();
  }
});

test("returning to a finished start opens the conversation created in the background", async ({
  app,
  browser,
  screen,
}) => {
  const release = Promise.withResolvers<void>();
  let channelId: string | undefined;
  await browser.route(/\/api\/route$/, async (route) => {
    await release.promise;
    await route.fulfill({ json: { agentId: "knowledge", reason: "matched" } });
  });
  await browser.route(/\/api\/channels$/, async (route) => {
    if (route.request.method !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const { channel } = await response.json<{ channel: { id: string } }>();
    channelId = channel.id;
    await route.fulfill({
      status: response.status,
      body: await response.text(),
      contentType: "application/json",
    });
  });
  try {
    await app.open("/");
    await screen
      .getByRole("textbox", "Message")
      .fill("What were our Q3 numbers?");
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/start\/[^/?#]+$/);
    await screen.getByRole("link", "OpenBot", { exact: true }).tap();
    await expect(browser).toHaveURL("/");
    release.resolve();

    await expect.poll(() => channelId ?? "").toMatch(/^channel[_-]/);
    await expect(
      browser.locator(`a[href="/channel/${channelId}"]`),
    ).toBeVisible();
    await expect(browser).toHaveURL("/");
    await browser.back();
    await expect(browser).toHaveURL(`/channel/${channelId}`);
    await expect(
      screen.getByText("What were our Q3 numbers?", { exact: true }),
    ).toBeVisible();
  } finally {
    release.resolve();
  }
});

test("a start link with no pending conversation returns home", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/start/reloaded");
  await expect(browser).toHaveURL("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
});

test("home lists a shared Skill once and sends its command instead of its instructions", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { id: withoutSkill } = await createBot(fixtures);
  const grants = /\/api\/plugins\/for\/[^/?#]+$/;
  const standup = {
    slug: "standup",
    title: "Standup notes",
    summary: "Turns yesterday's work into a standup update",
    instructions: "Summarise yesterday.",
  };
  const loaded = new Set<string>();
  await browser.route(grants, async (route) => {
    const id = new URL(route.request.url).pathname.split("/").at(-1) ?? "";
    const skills =
      id === "general-assistant" || id === "knowledge" ? [standup] : [];
    await route.fulfill({ json: { tools: [], skills } });
    loaded.add(id);
  });
  const requests: unknown[] = [];
  await browser.route(/\/api\/route$/, async (route) => {
    requests.push(JSON.parse(route.request.postData ?? "null"));
    await route.fulfill({
      status: 409,
      json: { error: "Fixture stops before starting a conversation" },
    });
  });

  await app.open("/");
  await expect
    .poll(() => [
      loaded.has("general-assistant"),
      loaded.has("knowledge"),
      loaded.has(withoutSkill),
    ])
    .toEqual([true, true, true]);

  const editor = screen.getByRole("textbox", "Message");
  await editor.pressSequentially("/standup");
  const option = screen.getByRole("option", /^Standup notes/);
  await expect(option).toHaveCount(1);
  await expect(option).toContainText(standup.summary);
  await option.tap();
  await expect(
    screen.getByText(standup.instructions, { exact: true }),
  ).toBeHidden();
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect(screen.getByRole("alert")).toContainText(
    "Fixture stops before starting a conversation",
  );
  expect(requests).toEqual([{ text: "/standup", skillSlugs: ["standup"] }]);
});
