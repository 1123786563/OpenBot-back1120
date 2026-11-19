import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

for (const { path, failingRequest, message } of [
  {
    path: "/channel/new",
    failingRequest: /\/api\/agents$/,
    message: "Couldn't load your Bots. Reload the page.",
  },
  {
    path: "/channel/new?agent=hidden-bot",
    failingRequest: /\/api\/agents\/hidden-bot$/,
    message: "Couldn't load that Bot. Reload the page.",
  },
]) {
  test(`a failed Bot request on ${path} disables the composer with an error`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.route(failingRequest, async (route) => {
      await route.fulfill({ status: 500, json: { error: "Fixture failed" } });
    });
    await app.open(path);
    await expect(screen.getByRole("alert")).toHaveText(message);
    await expect(
      screen.getByText("No agents found.", { exact: true }),
    ).toBeHidden();
    await expect(screen.getByRole("textbox", "Message")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
}

for (const empty of [true, false]) {
  test(`a ${empty ? "successful empty" : "team"} roster waits for a recipient and keeps the draft`, async ({
    app,
    browser,
    screen,
  }) => {
    if (empty) {
      await browser.route(/\/api\/agents$/, async (route) => {
        await route.fulfill({ json: { agents: [] } });
      });
    }
    await app.open("/channel/new");
    const recipient = screen.getByRole("combobox", "Choose a Bot…");
    await expect(recipient).toHaveAttribute("aria-expanded", "true");
    if (empty) {
      await expect(
        screen.getByText("No Bots found.", { exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        screen.getByRole("option", /General Assistant/),
      ).toBeVisible();
      await expect(screen.getByRole("option", /Knowledge/)).toBeVisible();
    }
    await recipient.press("Escape");
    const editor = browser.locator(
      '[data-slot="composer-input"] [role="textbox"]',
    );
    await expect(editor).not.toHaveAttribute("aria-disabled", "true");
    await expect(screen.getByRole("alert")).toBeHidden();
    await expect(screen.getByRole("button", /^Remove /)).toHaveCount(0);
    await editor.fill("for whoever");
    await editor.press("Enter");
    await expect(
      browser
        .locator('[role="status"]')
        .filter({ hasText: "Choose a Bot first." }),
    ).toBeVisible();
    await expect(editor).toHaveText("for whoever");
    await expect(browser).toHaveURL("/channel/new");
  });
}

test("a visible Bot from the link is selected and enables the composer", async ({
  app,
  screen,
}) => {
  await app.open("/channel/new?agent=general-assistant");
  await expect(
    screen.getByRole("button", "Remove General Assistant"),
  ).toBeVisible();
  const editor = screen.getByRole("textbox", "Message");
  await expect(editor).not.toHaveAttribute("aria-disabled", "true");
  await editor.fill("Ready for the selected Bot");
  await expect(
    screen.getByRole("button", "Send message", { exact: true }),
  ).toBeEnabled();
  await expect(screen.getByRole("alert")).toBeHidden();
});

test("New Bot stays available when no recipient matches the search", async ({
  app,
  screen,
}) => {
  await app.open("/channel/new");
  const recipient = screen.getByRole("combobox", "Choose a Bot…");
  const create = screen.getByRole("button", "New Bot Create a new Bot");
  await expect(create).toBeVisible();
  await expect(screen.getByRole("option", /New Bot/)).toHaveCount(0);
  await expect(create).not.toHaveAttribute("data-highlighted");
  await recipient.fill("no matching recipient");
  await expect(
    screen.getByText("No Bots found.", { exact: true }),
  ).toBeVisible();
  await create.tap();
  await expect(screen.getByRole("dialog", "New Bot")).toBeVisible();
});

test("creating a Bot from To keeps existing recipients and the draft", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/channel/new?agent=general-assistant");
  const existing = screen.getByRole("button", "Remove General Assistant");
  await expect(existing).toBeVisible();
  const editor = browser.locator(
    '[data-slot="composer-input"] [role="textbox"]',
  );
  await editor.fill("Keep this idea");
  await screen
    .getByRole("combobox", "Add another Bot for a group…")
    .press("ArrowDown");
  await screen.getByRole("button", "New Bot Create a new Bot").tap();
  const dialog = screen.getByRole("dialog", "New Bot");
  const name = `E2E Recipient ${crypto.randomUUID().slice(0, 8)}`;
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", "Create Bot", { exact: true }).tap();
  await expect(screen.getByRole("button", `Remove ${name}`)).toBeVisible();
  await expect(existing).toBeVisible();
  await expect(editor).toHaveText("Keep this idea");
  await expect(browser).toHaveURL("/channel/new?agent=general-assistant");
});

test("New conversation clears the previous recipient and draft", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/channel/new");
  const recipient = screen.getByRole("combobox", "Choose a Bot…");
  await recipient.fill("General");
  await screen.getByRole("option", /General Assistant/).tap();
  const existing = screen.getByRole("button", "Remove General Assistant");
  await expect(existing).toBeVisible();
  await expect(browser).toHaveURL("/channel/new?agent=general-assistant");
  const editor = browser.locator(
    '[data-slot="composer-input"] [role="textbox"]',
  );
  await editor.fill("half a thought");
  await screen.getByRole("button", "New conversation", { exact: true }).tap();
  await expect(browser).toHaveURL("/channel/new");
  await expect(recipient).toHaveAttribute("aria-expanded", "true");
  await expect(recipient).toBeFocused();
  await expect(existing).toHaveCount(0);
  await expect(editor).toHaveText("");
});

test("rapid and repeated New conversation clicks reopen To without selecting a Bot", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/channel/new");
  const recipient = screen.getByRole("combobox", "Choose a Bot…");
  const plus = screen.getByRole("button", "New conversation", { exact: true });
  await expect(recipient).toHaveAttribute("aria-expanded", "true");
  await expect(recipient).toBeFocused();

  await recipient.press("Escape");
  await plus.doubleTap();
  await expect(recipient).toHaveAttribute("aria-expanded", "true");
  await expect(recipient).toBeFocused();
  await expect(screen.getByRole("button", /^Remove /)).toHaveCount(0);

  await recipient.press("Escape");
  await expect(recipient).not.toHaveAttribute("aria-expanded", "true");
  await plus.tap();
  await expect(recipient).toHaveAttribute("aria-expanded", "true");
  await expect(recipient).toBeFocused();
  await expect(browser).toHaveURL("/channel/new");
});

test("New conversation clears a draft that has no recipient", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/channel/new");
  const recipient = screen.getByRole("combobox", "Choose a Bot…");
  await expect(recipient).toHaveAttribute("aria-expanded", "true");
  await recipient.press("Escape");
  const editor = browser.locator(
    '[data-slot="composer-input"] [role="textbox"]',
  );
  await editor.fill("not for anyone yet");
  await screen.getByRole("button", "New conversation", { exact: true }).tap();
  await expect(recipient).toHaveAttribute("aria-expanded", "true");
  await expect(recipient).toBeFocused();
  await expect(editor).toHaveText("");
});

test("selecting a Bot after a send is held preserves the message and enables Send", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/channel/new");
  const recipient = screen.getByRole("combobox", "Choose a Bot…");
  await expect(recipient).toHaveAttribute("aria-expanded", "true");
  await recipient.press("Escape");
  const editor = browser.locator(
    '[data-slot="composer-input"] [role="textbox"]',
  );
  await editor.fill("hello there");
  await editor.press("Enter");
  const hint = browser
    .locator('[role="status"]')
    .filter({ hasText: "Choose a Bot first." });
  await expect(hint).toBeVisible();
  await expect(hint).toHaveAttribute("class", /\bpx-3\.5\b/);
  await expect(recipient).toHaveAttribute("aria-expanded", "true");
  await expect(recipient).toBeFocused();
  await expect(editor).toHaveText("hello there");

  await screen.getByRole("option", /General Assistant/).tap();
  await expect(hint).toBeHidden();
  await expect(editor).toHaveText("hello there");
  await expect(editor).toBeFocused();
  await expect(editor).not.toHaveAttribute("aria-disabled", "true");
  await expect(
    screen.getByRole("button", "Remove General Assistant"),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Send message", { exact: true }),
  ).toBeEnabled();
});

test("a link can select a hidden Bot without adding it to the roster", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { id, name } = await createBot(fixtures);
  const status = await browser.evaluate(async (id) => {
    const response = await fetch(`/api/agents/${encodeURIComponent(id)}/hide`, {
      method: "POST",
    });
    return response.status;
  }, id);
  expect(status).toBe(204);
  await app.open("/bots");
  await expect(
    screen.getByRole("heading", "Yours", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(name, { exact: true })).toBeHidden();

  await app.open(`/channel/new?agent=${encodeURIComponent(id)}`);
  await expect(screen.getByRole("button", `Remove ${name}`)).toBeVisible();
  await expect(screen.getByRole("alert")).toBeHidden();
  const editor = screen.getByRole("textbox", "Message");
  await expect(editor).not.toHaveAttribute("aria-disabled", "true");
  await editor.fill("Ready for the hidden Bot");
  await expect(
    screen.getByRole("button", "Send message", { exact: true }),
  ).toBeEnabled();
});

test("adding a second Bot and removing the first preserves the draft", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/channel/new?agent=general-assistant");
  const first = screen.getByRole("button", "Remove General Assistant");
  const second = screen.getByRole("button", "Remove Knowledge");
  await expect(first).toBeVisible();
  const editor = browser.locator(
    '[data-slot="composer-input"] [role="textbox"]',
  );
  await editor.fill("for both of you");
  await screen
    .getByRole("combobox", "Add another Bot for a group…")
    .fill("Knowledge");
  await screen.getByRole("option", /^Knowledge/).tap();
  await expect(second).toBeVisible();
  await first.tap();
  await expect(browser).toHaveURL("/channel/new?agent=knowledge");
  await expect(second).toBeVisible();
  await expect(first).toHaveCount(0);
  await expect(editor).toHaveText("for both of you");
});

test("the personal edition opens the recipient picker without picking a Bot", async ({
  app,
  browser,
  screen,
}) => {
  await browser.route(/\/api\/capabilities$/, async (route) => {
    await route.fulfill({ json: { edition: "personal" } });
  });
  await app.open("/channel/new");
  const recipient = screen.getByRole("combobox", "Choose a Bot…");
  await expect(recipient).toHaveAttribute("aria-expanded", "true");
  await expect(recipient).toBeFocused();
  await expect(screen.getByRole("option", /^General Assistant/)).toBeVisible();
  await expect(screen.getByRole("option", /^Knowledge/)).toBeVisible();
  await expect(screen.getByRole("button", /^Remove /)).toHaveCount(0);
  await expect(browser).toHaveURL("/channel/new");
});

test("even a sole Bot is only the recipient after the person selects it", async ({
  app,
  browser,
  screen,
}) => {
  await browser.route(/\/api\/agents$/, async (route) => {
    const response = await route.fetch();
    const { agents } = await response.json<{ agents: { id: string }[] }>();
    await route.fulfill({
      json: { agents: agents.filter(({ id }) => id === "general-assistant") },
    });
  });
  const created: unknown[] = [];
  await browser.route(/\/api\/channels$/, async (route) => {
    if (route.request.method === "POST") {
      created.push(JSON.parse(route.request.postData ?? "null"));
    }
    await route.continue();
  });
  await app.open("/channel/new");
  const recipient = screen.getByRole("combobox", "Choose a Bot…");
  await expect(recipient).toHaveAttribute("aria-expanded", "true");
  await expect(recipient).toBeFocused();
  await expect(screen.getByRole("option")).toHaveCount(1);
  await expect(screen.getByRole("button", /^Remove /)).toHaveCount(0);
  await screen.getByRole("option", /^General Assistant/).tap();
  await expect(
    screen.getByRole("button", "Remove General Assistant"),
  ).toBeVisible();
  const editor = screen.getByRole("textbox", "Message");
  await editor.fill("what changed in the latest release?");
  await editor.press("Enter");
  await expect(browser).toHaveURL(/\/channel\/(?!new(?:[/?#]|$))[^/?#]+/);
  await expect(
    screen.getByText("what changed in the latest release?", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Choose a Bot first.", { exact: true }),
  ).toBeHidden();
  expect(created).toEqual([{ agentIds: ["general-assistant"] }]);
});

test("a Bot added back to the roster takes precedence over its cached detail error", async ({
  app,
  browser,
  screen,
}) => {
  let listGeneralAssistant = false;
  let detailRequests = 0;
  await browser.route(/\/api\/agents$/, async (route) => {
    const response = await route.fetch();
    const { agents } = await response.json<{ agents: { id: string }[] }>();
    await route.fulfill({
      json: {
        agents: agents.filter(
          ({ id }) => id !== "general-assistant" || listGeneralAssistant,
        ),
      },
    });
  });
  await browser.route(/\/api\/agents\/general-assistant$/, async (route) => {
    detailRequests += 1;
    await route.fulfill({ status: 500, json: { error: "Fixture failed" } });
  });

  await app.open("/channel/new?agent=general-assistant");
  await expect(screen.getByRole("alert")).toHaveText(
    "Couldn't load that Bot. Reload the page.",
  );
  expect(detailRequests).toBe(1);

  listGeneralAssistant = true;
  await screen.getByRole("link", "Bots", { exact: true }).tap();
  await expect(
    browser.locator('a[href="/bots/general-assistant"]'),
  ).toBeVisible();
  await browser.back();

  await expect(
    screen.getByRole("button", "Remove General Assistant"),
  ).toBeVisible();
  await expect(screen.getByRole("alert")).toBeHidden();
  await expect(screen.getByRole("textbox", "Message")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(detailRequests).toBe(1);
});

test("a hidden recipient with cached details stays available after a failed refresh", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { id, name } = await createBot(fixtures);
  const hidden = await browser.evaluate(async (id) => {
    const response = await fetch(`/api/agents/${encodeURIComponent(id)}/hide`, {
      method: "POST",
    });
    return response.status;
  }, id);
  expect(hidden).toBe(204);
  const detailPath = `/api/agents/${encodeURIComponent(id)}`;
  const detailRequest = new RegExp(`${RegExp.escape(detailPath)}$`);
  let failRefresh = false;
  await browser.route(detailRequest, async (route) => {
    if (failRefresh) {
      await route.fulfill({
        status: 500,
        json: { error: "Fixture refetch failed" },
      });
    } else {
      await route.continue();
    }
  });

  await app.open(`/channel/new?agent=${encodeURIComponent(id)}`);
  const recipient = screen.getByRole("button", `Remove ${name}`);
  await expect(recipient).toBeVisible();
  await screen.getByRole("link", "Bots", { exact: true }).tap();
  await expect(
    screen.getByRole("heading", "Bots", { exact: true }),
  ).toBeVisible();

  failRefresh = true;
  const [response] = await Promise.all([
    browser.waitForResponse(detailRequest),
    browser.back(),
  ]);
  expect(response.status).toBe(500);
  await expect(recipient).toBeVisible();
  await expect(screen.getByRole("alert")).toBeHidden();
  const editor = screen.getByRole("textbox", "Message");
  await expect(editor).not.toHaveAttribute("aria-disabled", "true");
  await editor.fill("This recipient is still available");
  await expect(
    screen.getByRole("button", "Send message", { exact: true }),
  ).toBeEnabled();
});

for (const scenario of [
  "addressed group",
  "unaddressed group",
  "removed Bot",
  "single Bot",
]) {
  test(`the first message composer offers the recipients in To: for a ${scenario}`, async ({
    app,
    browser,
    screen,
  }) => {
    const first = { id: "general-assistant", name: "General Assistant" };
    const second = { id: "knowledge", name: "Knowledge" };
    const posted: { path: string; body: unknown }[] = [];
    for (const path of [
      "/api/groups",
      "/api/groups/group-new",
      "/api/channels",
    ]) {
      await browser.route(new RegExp(`${path}$`), async (route) => {
        if (route.request.method !== "POST") return route.continue();
        posted.push({
          path,
          body: JSON.parse(route.request.postData ?? "null"),
        });
        if (path === "/api/channels") return route.continue();
        if (path === "/api/groups/group-new")
          return route.fulfill({ status: 202 });
        return route.fulfill({
          status: 201,
          json: {
            channel: {
              id: "group-new",
              name: "General Assistant, Knowledge",
              agentIds: [first.id, second.id],
              threadId: "first-group-thread",
              active: true,
              lastMessageAt: null,
            },
          },
        });
      });
    }
    await app.open(`/channel/new?agent=${first.id}`);
    const remove = (name: string) =>
      screen.getByRole("button", `Remove ${name}`, { exact: true });
    await expect(remove(first.name)).toBeVisible();
    if (scenario !== "single Bot") {
      const recipient = screen.getByRole("combobox", "Add another Bot for a group…");
      await recipient.pressSequentially(second.name);
      const option = screen.getByRole("option", /^Knowledge/);
      await option.click();
      await expect(remove(second.name)).toBeVisible();
    }
    const editor = screen.getByRole("textbox", "Message", { exact: true });
    if (scenario === "removed Bot") await remove(second.name).click();
    if (scenario !== "unaddressed group") {
      await editor.pressSequentially("@");
      const menu = screen.getByRole("listbox", "@ suggestions", {
        exact: true,
      });
      const isGroup = scenario === "addressed group";
      await expect(menu.getByRole("option")).toHaveCount(isGroup ? 2 : 1);
      const firstOption = menu.getByRole("option", /^General Assistant/);
      const secondOption = menu.getByRole("option", /^Knowledge/);
      await expect(firstOption).toBeVisible();
      if (isGroup) await expect(secondOption).toBeVisible();
      else await expect(secondOption).toHaveCount(0);
      if (scenario === "removed Bot") {
        expect(posted).toEqual([]);
        return;
      }
      await (isGroup ? secondOption : firstOption).click();
    }
    await editor.pressSequentially("hello");
    await editor.press("Enter");
    if (scenario === "single Bot") {
      await expect
        .poll(() => posted)
        .toEqual([{ path: "/api/channels", body: { agentIds: [first.id] } }]);
      await expect(browser).toHaveURL(/\/channel\/(?!new)[^/?#]+$/);
      return;
    }
    await expect(browser).toHaveURL("/group/group-new");
    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual({
      path: "/api/groups",
      body: { agentIds: [first.id, second.id] },
    });
    expect(posted[1].path).toBe("/api/groups/group-new");
    expect(posted[1].body).toMatchObject(
      scenario === "addressed group"
        ? { agentId: second.id, text: "@Knowledge hello" }
        : { agentId: null, text: "hello" },
    );
  });
}
