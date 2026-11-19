import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";
import { stageChatRun } from "./staged-chat-stream";

/*
 * Skins dress OpenBot's own elements through `data-slot` hooks, never through Tailwind classes or
 * copy, so restyling the composer or a header cannot silently undress every skin. Each test here
 * holds a hook to the element it names, drawn by the real page in a real browser, under every skin
 * the product ships. A hook that moves to another element, or goes, fails here.
 *
 * The one check from the old DOM suite a browser cannot answer — that no app-level hook reuses a
 * name the ui primitives give themselves — is source scanning, and lives on in
 * app/tests/skin-slots-names.test.ts.
 */

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

const skins = ["openbot", "openduet", "opendots", "openmuse"] as const;

/** The skin as the person's account would serve it, through the preferences route. */
async function serveSkin(browser: Browser, skin: (typeof skins)[number]) {
  await browser.route(/\/api\/settings\/preferences$/, (route) =>
    route.fulfill({ json: { preferences: { skin } } }),
  );
}

/**
 * Opens a real conversation with `skin` active. The account's preferences say it, and the
 * browser's pre-paint cache (`openbot-skin` in localStorage, which `index.html` reads before the
 * first paint) agrees, which is how a reload keeps a skin from flashing the default first.
 */
async function openConversation(
  { app, browser }: Fixtures,
  skin: (typeof skins)[number],
) {
  await serveSkin(browser, skin);
  // A settled, empty chat stream, so a failing agent connect cannot leave the composer mid-turn.
  await configureChatStream(browser, []);
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  await browser.evaluate((skin) => {
    window.localStorage.setItem("openbot-skin", skin);
    return null;
  }, skin);
  await app.open(`/channel/${channelId}`);
  return channelId;
}

for (const skin of skins) {
  test(`the ${skin} skin keeps every composer hook on the element it names`, async (fixtures) => {
    const { browser, screen } = fixtures;
    await openConversation(fixtures, skin);
    await expect(browser.locator('form[data-slot="composer"]')).toBeVisible();
    // A draft keeps Send drawn rather than the empty-draft voice-call button.
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("Keep the hooks honest");
    const hooks = await browser.evaluate(() => {
      const composer = document.querySelector('[data-slot="composer"]');
      const input = composer?.querySelector('[data-slot="composer-input"]');
      const attach = composer?.querySelector('[data-slot="composer-attach"]');
      const send = composer?.querySelector('[data-slot="composer-send"]');
      const column = document.querySelector('[data-slot="composer-column"]');
      return {
        skin: document.documentElement.dataset.skin ?? "",
        composer: composer?.tagName ?? null,
        editor:
          input?.querySelector(
            '[role="textbox"][aria-label="Message"]',
          ) instanceof HTMLElement,
        inputButtons: input?.querySelectorAll("button").length ?? null,
        attach: attach?.tagName ?? null,
        attachLabel: attach?.getAttribute("aria-label") ?? null,
        send: send?.tagName ?? null,
        sendType: send?.getAttribute("type") ?? null,
        sendLabel: send?.getAttribute("aria-label") ?? null,
        columnHoldsComposer:
          column?.querySelector('form[data-slot="composer"]') instanceof
          HTMLElement,
        columnHoldsTranscript:
          column?.querySelector('[data-slot="message-scroller"]') instanceof
          HTMLElement,
      };
    });
    // The default skin clears `data-skin`, so no skin rule can match it.
    expect(hooks).toEqual({
      skin: skin === "openbot" ? "" : skin,
      composer: "FORM",
      editor: true,
      inputButtons: 0,
      attach: "BUTTON",
      attachLabel: "Attach a file",
      send: "BUTTON",
      sendType: "submit",
      sendLabel: "Send message",
      // The column holds the composer, not the transcript.
      columnHoldsComposer: true,
      columnHoldsTranscript: false,
    });
  });
}

test("the full-size composer on the home page carries the same hooks", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = browser.locator('form[data-slot="composer"]');
  await expect(composer).toBeVisible();
  await screen
    .getByRole("textbox", "Message", { exact: true })
    .fill("Keep the hooks honest");
  await expect(
    browser.locator(
      '[data-slot="composer-input"] [role="textbox"][aria-label="Message"]',
    ),
  ).toBeVisible();
  await expect(
    browser.locator('[data-slot="composer-input"] button'),
  ).toHaveCount(0);
  const send = browser.locator('[data-slot="composer-send"]');
  await expect(send).toHaveAttribute("type", "submit");
  await expect(send).toHaveAttribute("aria-label", "Send message");

  // The attach hook on the full layout needs a conversation to attach to.
  const channelId = await createConversation(browser, "general-assistant");
  await app.open(`/tests/browser/composer.html?channel=${channelId}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  const attach = await browser.evaluate(() => {
    const attach = document.querySelector('[data-slot="composer-attach"]');
    return {
      tag: attach?.tagName ?? null,
      label: attach?.getAttribute("aria-label") ?? null,
    };
  });
  expect(attach).toEqual({ tag: "BUTTON", label: "Attach a file" });
});

test("the composer's stop button carries its hook while a Bot is working", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  await configureChatStream(browser, []);
  const partial = "Still reading your inbox.";
  // Held open for the whole test; finish() ends the run and disposal stops the stub server.
  using stagedRun = await stageChatRun(
    browser,
    ({ threadId, runId }) => [
      { type: "RUN_STARTED", threadId, runId },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "slots-partial",
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "slots-partial",
        delta: partial,
      },
    ],
    ({ threadId, runId }) => [
      { type: "TEXT_MESSAGE_END", messageId: "slots-partial" },
      { type: "RUN_FINISHED", threadId, runId },
    ],
  );
  await app.open(`/channel/${channelId}`);
  await screen
    .getByRole("textbox", "Message", { exact: true })
    .fill("Summarise my inbox.");
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  const stop = browser.locator('[data-slot="composer-stop"]');
  await expect(stop).toBeVisible();
  await expect(stop).toHaveAttribute("aria-label", "Stop the Bot");
  // One action button: while the Bot works, Stop stands in for Send.
  await expect(browser.locator('[data-slot="composer-send"]')).toHaveCount(0);
  await stagedRun.finish();
});

test("the detail pane, its header and its title carry their hooks", async (fixtures) => {
  const { app, browser } = fixtures;
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  // Wide enough that the detail draws as a pane beside the chat, not a sheet over it.
  await browser.setViewport({ width: 1450, height: 800 });
  await app.open(`/channel/${channelId}?watch=true`);
  await expect(browser.locator('[data-slot="detail-pane"]')).toBeVisible();
  const pane = await browser.evaluate(() => {
    const pane = document.querySelector('[data-slot="detail-pane"]');
    const header = pane?.querySelector('[data-slot="detail-pane-header"]');
    const title = header?.querySelector('[data-slot="detail-pane-title"]');
    return {
      headerIsChild: header?.parentElement === pane,
      title: title?.textContent?.trim() ?? null,
      close:
        header?.querySelector('button[aria-label="Close details"]') instanceof
        HTMLElement,
      holdsComposer:
        pane?.querySelector('[data-slot="composer"]') instanceof HTMLElement,
    };
  });
  expect(pane).toEqual({
    headerIsChild: true,
    title: "Computer",
    close: true,
    // The pane holds the Bot's screen, not the conversation it belongs to.
    holdsComposer: false,
  });
});

test("a settings page's header and title carry their hooks", async ({
  app,
  browser,
}) => {
  await app.open("/settings");
  await expect(browser.locator('[data-slot="page-title"]')).toHaveText(
    "General",
  );
  const header = await browser.evaluate(() => {
    const header = document.querySelector('[data-slot="page-header"]');
    const title = header?.querySelector('[data-slot="page-title"]');
    return {
      tag: header?.tagName ?? null,
      titleTag: title?.tagName ?? null,
      describes:
        header?.textContent?.includes(
          "Set your name, how OpenBot looks, and the instructions every Bot follows.",
        ) ?? null,
    };
  });
  expect(header).toEqual({ tag: "HEADER", titleTag: "H1", describes: true });
});

test("each conversation page has one header naming the conversation", async (fixtures) => {
  const { app, browser } = fixtures;
  await app.open("/");
  const first = await createBot(fixtures);
  const second = await createBot(fixtures);
  const channel = await createConversation(browser, first.id);
  const group = await createConversation(browser, [first.id, second.id]);
  const header = browser.locator('[data-slot="conversation-header"]');

  // A conversation's name on its page is its Bot's name.
  await app.open(`/channel/${channel}`);
  await expect(header).toHaveCount(1);
  await expect(header).toContainText(first.name);

  // A channel with several Bots is the group conversation, at its own address, naming them.
  await app.open(`/channel/${group}`);
  await expect(browser).toHaveURL(new RegExp(`/group/${RegExp.escape(group)}`));
  await expect(header).toHaveCount(1);
  await expect(header).toContainText(second.name);

  await app.open("/channel/new");
  await expect(header).toHaveCount(1);
  await expect(header).toContainText("To:");
});

test("the dictation buttons carry their hooks while idle and while recording", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/tests/browser/composer-dictation.html?source=provider");
  const dictate = browser.locator('[data-slot="composer-dictate"]');
  await expect(dictate).toBeVisible();
  await screen
    .getByRole("button", "Dictate a message", { exact: true })
    .click();
  await expect(
    screen.getByRole("img", "Live audio waveform", { exact: true }),
  ).toBeVisible();
  await expect(
    browser.locator('[data-slot="composer-dictate-cancel"]'),
  ).toBeVisible();
  await expect(
    browser.locator('[data-slot="composer-dictate-stop"]'),
  ).toBeVisible();
  await screen.getByRole("button", "Cancel dictation", { exact: true }).click();
  await expect(dictate).toBeVisible();
});
