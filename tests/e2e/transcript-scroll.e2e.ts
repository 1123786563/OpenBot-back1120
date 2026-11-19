import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";
import { stageChatRun } from "./staged-chat-stream";

test("a short transcript adds no keyboard tab stop", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(browser, [
    { id: "short-history", role: "user", content: "A short conversation." },
  ]);
  await app.open(`/channel/${channel}`);
  const messages = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    messages.getByText("A short conversation.", { exact: true }),
  ).toBeVisible();
  await expect(messages).toHaveAttribute("tabindex", "-1");
});

test("an empty restored conversation has no loading placeholder or messages", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(browser, []);
  await app.open(`/channel/${channel}`);
  const messages = screen.getByRole("region", "Messages", { exact: true });
  await expect(messages).toBeVisible();
  await expect(
    screen.getByRole("status", "Loading this conversation", { exact: true }),
  ).toHaveCount(0);
  await expect(
    browser.locator('[data-slot="message-scroller-content"] [data-message-id]'),
  ).toHaveCount(0);
  await expect(screen.getByText(/Couldn't load earlier messages/)).toHaveCount(
    0,
  );
});

test("a long transcript opens at the newest message and supports keyboard scrolling", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(
    browser,
    Array.from({ length: 40 }, (_, index) => ({
      id: `history-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Conversation message ${index + 1}.`,
    })),
  );
  await app.open(`/channel/${channel}`);
  const messages = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    messages.getByText("Conversation message 40.", { exact: true }),
  ).toBeVisible();
  await expect(messages).toHaveAttribute("tabindex", "0");
  const scrollPosition = () =>
    browser.evaluate(() => {
      const viewport = document.querySelector(
        '[data-slot="message-scroller-viewport"]',
      );
      if (!viewport) throw new Error("Messages viewport is missing");
      return {
        top: viewport.scrollTop,
        bottom:
          viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      };
    });
  await expect
    .poll(async () => (await scrollPosition()).bottom)
    .toBeLessThan(2);
  const pointer = await browser.evaluate(() => {
    const viewport = document.querySelector(
      '[data-slot="message-scroller-viewport"]',
    );
    if (!viewport) throw new Error("Messages viewport is missing");
    const rect = viewport.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await browser.mouse.move(pointer.x, pointer.y);
  await browser.mouse.wheel(0, -260);
  await expect(messages).toHaveAttribute("data-following", "false");
  await expect
    .poll(async () => (await scrollPosition()).bottom)
    .toBeGreaterThan(100);

  await messages.press("Home");
  await expect.poll(async () => (await scrollPosition()).top).toBeLessThan(2);
  const latest = screen.getByRole("button", "Scroll to end", { exact: true });
  await expect(latest).toBeVisible();
  await latest.tap();
  await expect
    .poll(async () => (await scrollPosition()).bottom)
    .toBeLessThan(2);
});

test("opening the conversation waits for stored history before displaying the snapshot", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const snapshotMessage = {
    id: "snapshot-question",
    role: "user",
    content: "This question arrived in the snapshot.",
  };
  let requestStarted = false;
  const archive = Promise.withResolvers<readonly object[]>();
  await configureChatStream(browser, [snapshotMessage], () => {
    requestStarted = true;
    return archive.promise;
  });

  try {
    await app.open(`/channel/${channel}`);
    const loading = screen.getByRole("status", "Loading this conversation", {
      exact: true,
    });
    await expect(loading).toBeVisible();
    await expect.poll(() => requestStarted).toBe(true);
    const question = screen.getByText(snapshotMessage.content, { exact: true });
    await expect(question).toHaveCount(0);

    const storedMessage = "This newer reply arrived from storage.";
    archive.resolve([
      snapshotMessage,
      { id: "stored-answer", role: "assistant", content: storedMessage },
    ]);
    const messages = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      messages.getByText(storedMessage, { exact: true }),
    ).toBeVisible();
    await expect(question).toBeVisible();
    await expect(question).toHaveCount(1);
    await expect(loading).toHaveCount(0);
    await expect(
      screen.getByText(/Couldn't load earlier messages/),
    ).toHaveCount(0);
  } finally {
    archive.resolve([]);
  }
});

test("selecting transcript text pauses following and the first sent message resumes it", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const nextChannel = await createConversation(
    browser,
    bot.id,
    "Another digest",
  );
  await configureChatStream(
    browser,
    Array.from({ length: 40 }, (_, index) => ({
      id: `digest-${index + 1}`,
      role: "assistant",
      content: `Daily digest item ${index + 1}.`,
    })),
  );
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId }) => [{ type: "RUN_STARTED", runId, threadId }],
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );

  await app.open(`/channel/${channel}`);
  const messages = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    messages.getByText("Daily digest item 40.", { exact: true }),
  ).toBeVisible();
  await expect(messages).toHaveAttribute("data-following", "true");
  const latest = browser.locator(
    '[data-slot="message-scroller-button"][data-direction="end"]',
  );
  await expect(latest).toHaveCount(1);
  await expect(latest).toHaveAttribute("data-active", "false");

  const select = (selector: string | null) =>
    browser.evaluate((target) => {
      const selection = window.getSelection();
      if (!selection) throw new Error("Browser selection is unavailable");
      selection.removeAllRanges();
      if (target) {
        const node = document.querySelector(target);
        if (!node) throw new Error(`Selection target is missing: ${target}`);
        selection.selectAllChildren(node);
      }
      return selection.toString();
    }, selector);
  expect(await select('a[href="/"]')).toContain("OpenBot");
  await expect(messages).toHaveAttribute("data-following", "true");
  expect(await select('[data-message-id="digest-40"]')).toContain(
    "Daily digest item 40.",
  );
  await expect(messages).toHaveAttribute("data-following", "false");
  expect(await select(null)).toBe("");
  await expect(messages).toHaveAttribute("data-following", "true");

  await messages.press("PageUp");
  await expect(messages).toHaveAttribute("data-following", "false");
  await expect(latest).toHaveAttribute("data-active", "true");
  await screen.getByRole("link", /Another digest/).tap();
  await expect(browser).toHaveURL(
    new RegExp(`/channel/${RegExp.escape(nextChannel)}$`),
  );
  await expect(
    messages.getByText("Daily digest item 40.", { exact: true }),
  ).toBeVisible();
  await expect(messages).toHaveAttribute("data-following", "true");
  await messages.press("PageUp");
  await expect(messages).toHaveAttribute("data-following", "false");
  const question = "What changed since yesterday?";
  await screen.getByRole("textbox", "Message", { exact: true }).fill(question);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect(messages.getByText(question, { exact: true })).toBeVisible();
  await expect(messages).toHaveAttribute("data-following", "true");
  stream.finish();
  await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();

  await messages.press("PageUp");
  await expect(messages).toHaveAttribute("data-following", "false");
  const followUp = "Which items need a reply?";
  await screen.getByRole("textbox", "Message", { exact: true }).fill(followUp);
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  await expect(messages.getByText(followUp, { exact: true })).toBeVisible();
  await expect(messages).toHaveAttribute("data-following", "true");
  await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
});

test("navigation keys in a generated form leave transcript following enabled", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const catalogId = "openbot/ui@1";
  const surfaceId = "trip-form";
  await configureChatStream(browser, [
    {
      id: "trip-form-message",
      role: "activity",
      activityType: "generative-ui-surface",
      content: {
        surfaceId,
        target: "chat",
        catalogId,
        status: "ready",
        rejected: [],
        operations: [
          {
            version: "1.0",
            createSurface: {
              surfaceId,
              catalogId,
              dataModel: { destination: "Paris" },
            },
          },
          {
            version: "1.0",
            updateComponents: {
              surfaceId,
              components: [
                {
                  id: "root",
                  component: "TextField",
                  label: "Destination",
                  value: { "@path": "/destination" },
                },
              ],
            },
          },
        ],
      },
    },
  ]);
  await app.open(`/channel/${channel}`);
  const messages = screen.getByRole("region", "Messages", { exact: true });
  const input = messages.getByRole("textbox", "Destination", { exact: true });
  await expect(input).toBeVisible();
  await expect(messages).toHaveAttribute("data-following", "true");
  await input.fill("New");
  await input.press("ArrowUp");
  await expect(messages).toHaveAttribute("data-following", "true");
  await input.press("Shift+Space");
  await expect(messages).toHaveAttribute("data-following", "true");
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const input = document.activeElement;
        return input instanceof HTMLInputElement ? input.value : null;
      }),
    )
    .toMatch(/^( New|New )$/);
});

test("a layout clamp during a message press preserves following, while a scrollbar drag pauses it", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await configureChatStream(
    browser,
    Array.from({ length: 40 }, (_, index) => ({
      id: `scroll-history-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `History item ${index + 1}.`,
    })),
  );
  await app.open(`/channel/${channel}`);
  const messages = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    messages.getByText("History item 40.", { exact: true }),
  ).toBeVisible();
  const position = () =>
    browser.evaluate(() => {
      const viewport = document.querySelector(
        '[data-slot="message-scroller-viewport"]',
      );
      if (!viewport) throw new Error("Messages viewport is missing");
      return {
        top: viewport.scrollTop,
        distanceFromEnd:
          viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      };
    });
  await expect
    .poll(async () => (await position()).distanceFromEnd)
    .toBeLessThan(2);
  const before = await position();
  expect(before.top).toBeGreaterThan(250);

  const messagePoint = await browser.evaluate(() => {
    const message = document.querySelector(
      '[data-message-id="scroll-history-40"] p',
    );
    if (!message) throw new Error("Latest message text is missing");
    const rect = message.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    if (!message.contains(document.elementFromPoint(x, y))) {
      throw new Error("Latest message is covered at the pointer location");
    }
    return { x, y };
  });
  await browser.mouse.move(messagePoint.x, messagePoint.y);
  await browser.mouse.down();
  try {
    await browser.evaluate(() => {
      // Model a preceding row becoming shorter while the pointer is held on the latest message.
      const preceding = document.querySelector<HTMLElement>(
        '[data-message-id="scroll-history-38"]',
      );
      if (!preceding) throw new Error("Previous message is missing");
      preceding.hidden = true;
      return null;
    });
    await expect
      .poll(async () => (await position()).top)
      .toBeLessThan(before.top);
    await expect(messages).toHaveAttribute("data-following", "true");
  } finally {
    await browser.mouse.up();
  }

  const beforeDrag = await position();
  await browser.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    );
    if (!viewport) throw new Error("Messages viewport is missing");
    // Model an overlay scrollbar whose thumb lies inside the viewport's content box.
    const bounds = viewport.getBoundingClientRect();
    viewport.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: bounds.right - 2,
        clientY: bounds.bottom - 5,
        pointerType: "mouse",
      }),
    );
    viewport.scrollTop -= 220;
    return null;
  });
  try {
    await expect
      .poll(async () => (await position()).top)
      .toBeLessThan(beforeDrag.top - 100);
    await expect(messages).toHaveAttribute("data-following", "false");
  } finally {
    await browser.evaluate(() => {
      window.dispatchEvent(
        new PointerEvent("pointerup", { pointerType: "mouse" }),
      );
      return null;
    });
  }
});

test("restored history staggers its newest rows and a live message uses its own entrance", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const nextChannel = await createConversation(
    browser,
    bot.id,
    "Restored after switching",
  );
  const archive = Promise.withResolvers<readonly object[]>();
  let readArchive = () => archive.promise;
  await configureChatStream(browser, [], () => readArchive());
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId }) => [{ type: "RUN_STARTED", runId, threadId }],
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );

  const history = Array.from({ length: 10 }, (_, index) => ({
    id: `entrance-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Restored message ${index + 1}.`,
  }));
  const observeEntrances = (count: number, idPrefix?: string) =>
    browser.evaluate(
      ({ count, idPrefix }) => {
        document.documentElement.dataset.e2eMessageEntrance = "[]";
        const observed = new Map<
          HTMLElement,
          {
            id: string;
            delay: string;
            startsHidden: boolean;
          }
        >();
        const observer = new MutationObserver(() => {
          for (const row of document.querySelectorAll<HTMLElement>(
            '[data-slot="message-scroller-content"] [data-message-id]',
          )) {
            if (observed.has(row)) continue;
            const arrival = row.querySelector<HTMLElement>(
              '[data-slot="message-arriving"]',
            );
            const id = row.dataset.messageId;
            if (!arrival || !id || (idPrefix && !id.startsWith(idPrefix)))
              continue;
            observed.set(row, {
              id,
              delay: row.style.getPropertyValue("--arrive-delay"),
              startsHidden: arrival.style.opacity === "0",
            });
          }
          document.documentElement.dataset.e2eMessageEntrance = JSON.stringify([
            ...observed.values(),
          ]);
          if (observed.size >= count) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return null;
      },
      { count, idPrefix: idPrefix ?? null },
    );

  try {
    await app.open(`/channel/${channel}`);
    await expect(
      screen.getByRole("status", "Loading this conversation", { exact: true }),
    ).toBeVisible();
    await observeEntrances(11);
    archive.resolve(history);

    const observations = async () =>
      JSON.parse(
        await browser.evaluate(
          () => document.documentElement.dataset.e2eMessageEntrance ?? "[]",
        ),
      ) as { id: string; delay: string; startsHidden: boolean }[];
    await expect.poll(observations).toEqual(
      history.map(({ id }, index) => ({
        id,
        delay: index < 2 ? "" : `${(index - 2) * 30}ms`,
        startsHidden: false,
      })),
    );
    const message = "A new message after restoring.";
    await screen.getByRole("textbox", "Message", { exact: true }).fill(message);
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    const messages = screen.getByRole("region", "Messages", { exact: true });
    await expect(messages.getByText(message, { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await observations()).at(-1))
      .toMatchObject({
        delay: "",
        startsHidden: true,
      });
    stream.finish();
    await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
    readArchive = async () => [
      {
        id: "switch-question",
        role: "user",
        content: "An earlier question in this conversation.",
      },
      {
        id: "switch-reply",
        role: "assistant",
        content: "Its previously saved reply.",
      },
    ];
    await observeEntrances(2, "switch-");
    await screen.getByRole("link", /Restored after switching/).tap();
    await expect(browser).toHaveURL(
      new RegExp(`/channel/${RegExp.escape(nextChannel)}$`),
    );
    await expect(
      messages.getByText("Its previously saved reply.", { exact: true }),
    ).toBeVisible();
    await expect.poll(observations).toEqual([
      { id: "switch-question", delay: "0ms", startsHidden: false },
      { id: "switch-reply", delay: "30ms", startsHidden: false },
    ]);
  } finally {
    archive.resolve([]);
  }
});

test("a follow-up typed during history restoration is visible below the placeholder", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const archive = Promise.withResolvers<readonly object[]>();
  await configureChatStream(browser, [], () => archive.promise);
  const requests: unknown[][] = [];
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId, messages }) => {
      requests.push(messages);
      return [{ type: "RUN_STARTED", runId, threadId }];
    },
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );
  try {
    await app.open(`/channel/${channel}`);
    const loading = screen.getByRole("status", "Loading this conversation", {
      exact: true,
    });
    await expect(loading).toBeVisible();
    const first = "Start while opening.";
    const followUp = "Keep this correction.";
    const editor = screen.getByRole("textbox", "Message", { exact: true });
    await editor.fill(first);
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await editor.fill(followUp);
    await screen.getByRole("button", "Queue message", { exact: true }).tap();
    await expect(loading).toBeVisible();
    const pending = browser
      .locator("[data-transcript-column]")
      .getByText(followUp, { exact: true });
    await expect(pending).toBeVisible();
    const remove = screen.getByRole(
      "button",
      `Remove queued message: ${followUp}`,
      { exact: true },
    );
    await expect(remove).toBeVisible();
    expect(requests).toHaveLength(0);

    archive.resolve([]);
    await expect(loading).toHaveCount(0);
    await expect.poll(() => requests.length).toBe(1);
    expect(JSON.stringify(requests[0])).toContain(first);
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(transcript.getByText(followUp, { exact: true })).toBeVisible();
    await remove.tap();
    await expect(transcript.getByText(followUp, { exact: true })).toHaveCount(
      0,
    );
    stream.finish();
    await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
    expect(requests).toHaveLength(1);
  } finally {
    archive.resolve([]);
  }
});

test("the first sent message is visible in a newly seeded conversation while its archive is pending", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const archive = Promise.withResolvers<readonly object[]>();
  let requested = false;
  await configureChatStream(browser, [], () => {
    requested = true;
    return archive.promise;
  });
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId }) => [{ type: "RUN_STARTED", runId, threadId }],
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );
  try {
    await app.open(`/channel/new?agent=${encodeURIComponent(bot.id)}`);
    const first = "Show my first message while opening.";
    await screen.getByRole("textbox", "Message", { exact: true }).fill(first);
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/channel\/(?!new(?:[/?#]|$))[^/?#]+$/);
    await expect.poll(() => requested).toBe(true);
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(transcript.getByText(first, { exact: true })).toBeVisible();
    await expect(
      screen.getByRole("status", "Loading this conversation", { exact: true }),
    ).toHaveCount(0);
    archive.resolve([]);
    stream.finish();
    await expect(transcript.getByText(first, { exact: true })).toHaveCount(1);
  } finally {
    archive.resolve([]);
  }
});
