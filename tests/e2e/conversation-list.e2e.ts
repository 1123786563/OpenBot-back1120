import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const listPath = /\/api\/channels(?:\?.*)?$/;
const sidebar = '[data-sidebar="content"]';
const olderCursor = "older/page";

function conversation(
  index: number,
  summary: string,
  name = "Personal Assistant",
) {
  return {
    id: `fixture-conversation-${index}`,
    name,
    agentIds: [],
    threadId: `fixture-thread-${index}`,
    active: true,
    summary,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2026-09-15T00:00:00Z",
    pinned: false,
    lastReadAt: null,
  };
}

const firstPage = {
  channels: Array.from({ length: 40 }, (_, index) =>
    conversation(
      index,
      index === 0 ? "Recent conversation" : `Conversation ${index}`,
    ),
  ),
  nextCursor: olderCursor,
};

async function scrollList(browser: Browser, position: "top" | "bottom") {
  await browser.evaluate(
    ({ position, sidebar }) => {
      const list = document.querySelector(sidebar);
      if (!list || list.scrollHeight <= list.clientHeight)
        throw new Error("The conversation list is not scrollable");
      list.scrollTo({
        top: position === "top" ? 0 : list.scrollHeight,
        behavior: "instant",
      });
      return null;
    },
    { position, sidebar },
  );
}

test("scrolling the sidebar requests one encoded cursor and stops at the final page", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1200, height: 720 });
  const pending = Promise.withResolvers<void>();
  const cursors: string[] = [];
  await browser.route(listPath, async (route) => {
    const { search } = new URL(route.request.url);
    if (!search.includes("cursor=")) return route.fulfill({ json: firstPage });
    cursors.push(search);
    await pending.promise;
    return route.fulfill({
      json: {
        channels: [conversation(50, "Older conversation")],
        nextCursor: null,
      },
    });
  });
  try {
    await app.open("/");
    const recent = screen.getByRole("link", /Recent conversation/);
    await expect(recent).toBeVisible();
    expect(cursors).toEqual([]);
    await scrollList(browser, "bottom");
    const loading = screen.getByRole("button", "Loading older conversations…", {
      exact: true,
    });
    await expect(loading).toBeDisabled();
    await scrollList(browser, "top");
    await scrollList(browser, "bottom");
    expect(cursors).toEqual(["?cursor=older%2Fpage"]);
    pending.resolve();
    await expect(screen.getByRole("link", /Older conversation/)).toBeVisible();
    await expect(recent).toBeVisible();
    await expect(
      screen.getByRole("button", "Load older conversations", { exact: true }),
    ).toHaveCount(0);
    expect(cursors).toEqual(["?cursor=older%2Fpage"]);
  } finally {
    pending.resolve();
  }
});

test("a failed older page preserves the sidebar and retries the same cursor only after Try again", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1200, height: 720 });
  const cursors: string[] = [];
  await browser.route(listPath, (route) => {
    const { search } = new URL(route.request.url);
    if (!search.includes("cursor=")) return route.fulfill({ json: firstPage });
    cursors.push(search);
    if (cursors.length <= 2) return route.fulfill({ status: 503 });
    if (cursors.length === 3)
      return route.fulfill({
        json: {
          channels: Array.from({ length: 20 }, (_, index) =>
            conversation(
              50 + index,
              index === 0 ? "Recovered conversation" : `Recovered ${index}`,
            ),
          ),
          nextCursor: "last-page",
        },
      });
    return route.fulfill({
      json: {
        channels: [conversation(99, "Oldest conversation")],
        nextCursor: null,
      },
    });
  });
  await app.open("/");
  const recent = screen.getByRole("link", /Recent conversation/);
  await expect(recent).toBeVisible();
  await scrollList(browser, "bottom");
  await expect(
    screen.getByText("Couldn't load older conversations.", { exact: true }),
  ).toBeVisible();
  await expect(recent).toBeVisible();
  await scrollList(browser, "top");
  await scrollList(browser, "bottom");
  expect(cursors).toEqual(["?cursor=older%2Fpage", "?cursor=older%2Fpage"]);
  await screen.getByRole("button", "Try again", { exact: true }).tap();
  await expect(
    screen.getByRole("link", /Recovered conversation/),
  ).toBeVisible();
  expect(cursors).toEqual([
    "?cursor=older%2Fpage",
    "?cursor=older%2Fpage",
    "?cursor=older%2Fpage",
  ]);
  await scrollList(browser, "bottom");
  await expect(screen.getByRole("link", /Oldest conversation/)).toBeVisible();
  await expect(
    screen.getByRole("button", "Load older conversations", { exact: true }),
  ).toHaveCount(0);
  expect(cursors).toEqual([
    "?cursor=older%2Fpage",
    "?cursor=older%2Fpage",
    "?cursor=older%2Fpage",
    "?cursor=last-page",
  ]);
});

test("search expands into unloaded conversation history only when requested", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1200, height: 720 });
  const cursors: string[] = [];
  await browser.route(listPath, (route) => {
    const { search } = new URL(route.request.url);
    if (!search.includes("cursor=")) return route.fulfill({ json: firstPage });
    cursors.push(search);
    return route.fulfill({
      json: {
        channels: [conversation(80, "Archived conversation")],
        nextCursor: null,
      },
    });
  });
  await app.open("/");
  const recent = screen.getByRole("link", /Recent conversation/);
  await expect(recent).toBeVisible();
  const search = screen.getByRole("textbox", "Search conversations", {
    exact: true,
  });
  await search.fill("Archived");
  const noMatch = screen.getByText(
    "No loaded conversations match your search",
    { exact: true },
  );
  await expect(noMatch).toBeVisible();
  const load = screen.getByRole("button", "Load older conversations", {
    exact: true,
  });
  await expect(load).toBeEnabled();
  expect(cursors).toEqual([]);
  await load.tap();
  const archived = screen.getByRole("link", /Archived conversation/);
  await expect(archived).toBeVisible();
  await expect(noMatch).toHaveCount(0);
  await expect(recent).toHaveCount(0);
  await search.fill("");
  await expect(recent).toBeVisible();
  await expect(archived).toBeVisible();
  expect(cursors).toEqual(["?cursor=older%2Fpage"]);
});

test("choosing Bot name emphasis updates the settings preview and the conversation list", async ({
  app,
  browser,
  screen,
}) => {
  await browser.route(listPath, (route) =>
    route.fulfill({
      json: {
        channels: [conversation(1, "Recent conversation")],
        nextCursor: null,
      },
    }),
  );
  await app.open("/");
  const row = screen.getByRole("link", /Recent conversation/);
  await expect(row).toBeVisible();
  const fontDifference = (
    scope: string,
    titleLabel: string,
    botLabel: string,
  ) =>
    browser.evaluate(
      ({ scope, titleLabel, botLabel }) => {
        const container = document.querySelector(scope);
        const title = container?.querySelector(`[title="${titleLabel}"]`);
        const bot = container?.querySelector(`[title="${botLabel}"]`);
        if (!title || !bot) return 0;
        return (
          Number.parseFloat(getComputedStyle(bot).fontSize) -
          Number.parseFloat(getComputedStyle(title).fontSize)
        );
      },
      { scope, titleLabel, botLabel },
    );
  const sidebarEmphasis = () =>
    fontDifference(sidebar, "Recent conversation", "Personal Assistant");
  await expect.poll(sidebarEmphasis).toBeLessThan(0);

  await app.open("/settings");
  const previewEmphasis = () =>
    fontDifference(
      'figure[aria-label="Message list preview"]',
      "Plan next week",
      "General Assistant",
    );
  await expect.poll(previewEmphasis).toBeLessThan(0);
  const emphasis = screen.getByRole("combobox", "Message list emphasis", {
    exact: true,
  });
  await expect(emphasis).toBeEnabled();
  await emphasis.tap();
  const saved = browser.waitForResponse(/\/api\/settings\/preferences$/);
  await screen.getByRole("option", "Bot name", { exact: true }).tap();
  const response = await saved;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    preferences: { messageListEmphasis: "agent" },
  });
  await expect.poll(previewEmphasis).toBeGreaterThan(0);
  await screen.getByRole("link", "Back to app", { exact: true }).tap();
  await expect(row).toBeVisible();
  await expect.poll(sidebarEmphasis).toBeGreaterThan(0);
  await browser.reload();
  await expect.poll(sidebarEmphasis).toBeGreaterThan(0);
});
