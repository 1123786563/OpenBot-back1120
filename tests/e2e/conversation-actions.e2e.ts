import { test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

async function openBotPanel(screen: TestFixtures["screen"]) {
  const settings = screen.getByRole("button", "This conversation's Bot", {
    exact: true,
  });
  await settings.tap();
  await expect(settings).toHaveAttribute("aria-pressed", "true");
  await expect(
    screen.getByRole("heading", "This conversation", { exact: true }),
  ).toBeVisible();
}

test("pinning and unpinning a conversation from its Bot panel persist after reload", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const id = await createConversation(browser, bot.id, "Quarterly planning");
  const path = `/channel/${id}`;
  await configureChatStream(browser, []);
  const pins: { method: string; body: unknown }[] = [];
  await browser.route(
    new RegExp(`/api/channels/${RegExp.escape(id)}/pin$`),
    (route) => {
      pins.push({
        method: route.request.method,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      return route.continue();
    },
  );

  await app.open(path);
  await openBotPanel(screen);
  const pin = screen.getByRole("button", "Pin conversation", { exact: true });
  const unpin = screen.getByRole("button", "Unpin conversation", {
    exact: true,
  });
  await expect(pin).toBeEnabled();
  await pin.tap();
  await expect(unpin).toBeEnabled();
  await browser.reload();
  await expect(unpin).toBeEnabled();
  await unpin.tap();
  await expect(pin).toBeEnabled();
  await browser.reload();
  await expect(pin).toBeEnabled();
  expect(pins).toEqual([
    { method: "PUT", body: { pinned: true } },
    { method: "PUT", body: { pinned: false } },
  ]);
});

test("deleting an open conversation asks first and navigates home before the request completes", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const id = await createConversation(browser, bot.id, "Delete this plan");
  const path = `/channel/${id}`;
  await configureChatStream(browser, []);
  const allowDelete = Promise.withResolvers<void>();
  const deletePaths: string[] = [];
  const api = new RegExp(`/api/channels/${RegExp.escape(id)}$`);
  await browser.route(api, async (route) => {
    if (route.request.method === "DELETE") {
      deletePaths.push(new URL(await browser.url()).pathname);
      await allowDelete.promise;
    }
    return route.continue();
  });

  await app.open(path);
  await openBotPanel(screen);
  const open = screen.getByRole("button", "Delete conversation…", {
    exact: true,
  });
  const dialog = screen.getByRole("dialog");
  const item = browser.locator(`[data-sidebar="content"] a[href="${path}"]`);
  await open.tap();
  await expect(
    dialog.getByText("It disappears for everyone in the conversation.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(deletePaths).toEqual([]);
  await dialog.getByRole("button", "Cancel", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  await expect(browser).toHaveURL(
    new RegExp(`${RegExp.escape(path)}\\?settings=true$`),
  );
  await expect(item).toBeVisible();
  expect(deletePaths).toEqual([]);

  await open.tap();
  const deleted = browser.waitForResponse(api);
  try {
    await dialog.getByRole("button", "Delete", { exact: true }).tap();
    await expect.poll(() => deletePaths).toEqual(["/"]);
    await expect(browser).toHaveURL(new URL("/", app.baseUrl).href);
    await expect(item).toBeVisible();
  } finally {
    allowDelete.resolve();
  }
  expect((await deleted).status).toBeLessThan(300);
  await expect(item).toHaveCount(0);
  expect(
    await browser.evaluate(async (id) => {
      const response = await fetch(`/api/channels/${encodeURIComponent(id)}`);
      return response.status;
    }, id),
  ).toBe(404);
});

test("renaming through the sidebar saves a custom title and clearing it restores the automatic title", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const id = await createConversation(browser, bot.id, "Quarterly planning");
  const path = `/channel/${id}`;
  await configureChatStream(browser, []);
  const titles: { method: string; body: unknown }[] = [];
  await browser.route(
    new RegExp(`/api/channels/${RegExp.escape(id)}/title$`),
    (route) => {
      titles.push({
        method: route.request.method,
        body: JSON.parse(route.request.postData ?? "null"),
      });
      return route.continue();
    },
  );

  await app.open(path);
  const item = browser.locator(`[data-sidebar="content"] a[href="${path}"]`);
  const dialog = screen.getByRole("dialog", "Rename conversation", {
    exact: true,
  });
  const field = dialog.getByRole("textbox", "Name", { exact: true });
  const rename = async () => {
    await item.secondaryTap();
    await screen
      .getByRole("menuitem", "Rename conversation…", { exact: true })
      .tap();
  };

  await expect(item).toContainText("Quarterly planning");
  await rename();
  await expect(field).toHaveValue("Quarterly planning");
  await field.fill("Abandoned draft");
  await field.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(item).toContainText("Quarterly planning");
  expect(titles).toEqual([]);

  await rename();
  await field.fill("Invoice review");
  await field.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(item).toContainText("Invoice review");
  await browser.reload();
  await expect(item).toContainText("Invoice review");
  await rename();
  await expect(field).toHaveValue("Invoice review");
  await field.fill("");
  await dialog.getByRole("button", "Save", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  await expect(item).toContainText("New conversation");
  expect(titles).toEqual([
    { method: "PUT", body: { title: "Invoice review" } },
    { method: "PUT", body: { title: null } },
  ]);
});

if (process.env.OPENBOT_E2E_SUITE !== "personal") {
  test("opening an unread group marks it read once and reopening it keeps it read", async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const owner = await createBot(fixtures);
    const helper = await createBot(fixtures);
    const id = await createConversation(
      browser,
      [owner.id, helper.id],
      "Group receipts",
    );
    // The badge aggregates every Bot; other tests' unread conversations are not this scenario.
    await browser.route(/\/api\/bots\/attention$/, async (route) => {
      const response = await route.fetch();
      const data = await response.json<{ bots: { agentId: string }[] }>();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...data,
          bots: data.bots.filter((bot) =>
            [owner.id, helper.id].includes(bot.agentId),
          ),
        }),
      });
    });
    const answer = "The receipts are ready.";
    const postReply = (reply: string) =>
      browser.evaluate(
        async ({ id, reply, botId }) => {
          const response = await fetch(
            `/api/channels/${encodeURIComponent(id)}/activity`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                at: new Date().toISOString(),
                agentId: botId,
                text: reply,
              }),
            },
          );
          return response.status;
        },
        { id, reply, botId: owner.id },
      );
    expect(await postReply(answer)).toBe(204);
    const readPath = new RegExp(`/api/channels/${RegExp.escape(id)}/read$`);
    const methods: string[] = [];
    await browser.route(readPath, (route) => {
      methods.push(route.request.method);
      return route.continue();
    });

    const path = `/group/${id}`;
    await app.open("/");
    const row = browser.locator(`[data-sidebar="content"] a[href="${path}"]`);
    const unread = browser.locator(
      'a[href="/bots"] [aria-label="Unread messages"]',
    );
    await expect(row).toContainText("Group receipts");
    await expect(unread).toBeVisible();

    const read = browser.waitForResponse(readPath);
    await row.tap();
    await expect(browser).toHaveURL(path);
    expect((await read).status).toBeLessThan(300);
    await expect(unread).toHaveCount(0);
    expect(methods).toEqual(["PUT"]);

    await browser.reload();
    const roster = await browser.evaluate(async (id) => {
      const response = await fetch("/api/channels");
      if (!response.ok)
        throw new Error(`Cannot read the refreshed roster: ${response.status}`);
      const data: {
        channels: {
          id: string;
          lastReadAt: string | null;
          lastMessageAt: string | null;
        }[];
      } = await response.json();
      return data.channels.find((row) => row.id === id) ?? null;
    }, id);
    await expect(row).toContainText("Group receipts");
    await expect(unread).toHaveCount(0);
    await expect(
      screen.getByRole("textbox", "Message", { exact: true }),
    ).toBeVisible();
    expect(roster?.lastReadAt).toBeTruthy();
    expect(Date.parse(roster?.lastReadAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(roster?.lastMessageAt ?? ""),
    );
    expect(methods).toEqual(["PUT"]);

    const nextRead = browser.waitForResponse(readPath);
    expect(await postReply("The total has been reconciled.")).toBe(204);
    expect((await nextRead).status).toBeLessThan(300);
    await expect(unread).toHaveCount(0);
    expect(methods).toEqual(["PUT", "PUT"]);
  });
}

test("Bot details switch between a narrow sheet and a wide panel without replacing the composer", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const id = await createConversation(browser, bot.id, "Keep this draft");
  const path = `/channel/${id}`;
  await configureChatStream(browser, []);
  await browser.setViewport({ width: 600, height: 800 });
  await app.open(path);
  const message = screen.getByRole("textbox", "Message", { exact: true });
  const draft = "Keep the unsent details in this draft.";
  await message.fill(draft);
  const marker = '[data-slot="composer-input"] [role="textbox"]';
  await browser.evaluate((selector) => {
    const editor = document.querySelector<HTMLElement>(selector);
    if (!editor) throw new Error("The conversation composer was not mounted");
    editor.dataset.e2eDraftOriginal = "yes";
    return null;
  }, marker);
  const original = browser.locator(`${marker}[data-e2e-draft-original="yes"]`);
  const sheet = screen.getByRole("dialog", "Details", { exact: true });
  const details = screen.getByRole("heading", "This conversation", {
    exact: true,
  });
  await screen
    .getByRole("button", "This conversation's Bot", { exact: true })
    .tap();
  await expect(
    sheet.getByRole("heading", "This conversation", { exact: true }),
  ).toBeVisible();
  await expect(original).toHaveCount(1);

  await browser.setViewport({ width: 1450, height: 800 });
  await expect(sheet).toHaveCount(0);
  await expect(
    browser
      .locator('[data-slot="detail-pane"]')
      .getByRole("heading", "This conversation", { exact: true }),
  ).toBeVisible();
  await expect(original).toHaveText(draft);

  await browser.setViewport({ width: 600, height: 800 });
  await expect(sheet).toBeVisible();
  await expect(original).toHaveCount(1);
  await sheet.getByRole("button", "Close", { exact: true }).tap();
  await expect(browser).toHaveURL(path);
  await expect(sheet).toHaveCount(0);
  await expect(details).toHaveCount(0);
  await expect(original).toHaveText(draft);
});
