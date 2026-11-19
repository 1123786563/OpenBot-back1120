import { type Browser, test, type WebRoute } from "@e2e-dev/web";
import { expect } from "e2e";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../shared/attachments";
import { chatRunPath, configureChatStream, readChatRun } from "./chat-stream";
import { createBot } from "./signed-in";
import { stageChatRun } from "./staged-chat-stream";

const route = "/channel/new?agent=general-assistant";

type DroppedFile = {
  name: string;
  type: string;
  text?: string;
  base64?: string;
};

async function readMultipartPost(request: WebRoute["request"]) {
  const headers = new Headers(request.headers);
  return new Response(request.postData, { headers }).formData();
}

async function dropBatches(
  browser: Browser,
  batches: (string | DroppedFile)[][],
  options: {
    overWarning?: boolean;
    expectedEffect?: "none" | "copy";
    unreadable?: boolean;
  } = {},
) {
  const {
    overWarning = false,
    expectedEffect = "none",
    unreadable = false,
  } = options;
  const results = await browser.evaluate(
    ({ batches, overWarning, unreadable }) => {
      const form = document
        .querySelector('[data-slot="composer-input"]')
        ?.closest("form");
      if (!form) throw new Error("The conversation composer has no form");
      const target = overWarning
        ? form.parentElement?.querySelector('[role="alert"]')
        : form;
      if (!target) throw new Error("The composer has no file warning");
      return batches.map((files) => {
        const dataTransfer = new DataTransfer();
        const droppedFiles: File[] = [];
        let hasNonCanonicalType = false;
        for (const file of files) {
          const input =
            typeof file === "string"
              ? {
                  name: file,
                  type: file.endsWith(".txt") ? "text/plain" : "image/png",
                }
              : file;
          const content = input.base64
            ? Uint8Array.from(atob(input.base64), (char) => char.charCodeAt(0))
            : (input.text ?? "OpenBot browser test");
          const dropped = new File([content], input.name, { type: input.type });
          if (
            dropped.type !== input.type &&
            input.type === input.type.toUpperCase()
          ) {
            // File() lowercases the type. Model metadata from a source outside the browser constructor.
            Object.defineProperty(dropped, "type", { value: input.type });
            hasNonCanonicalType = true;
          }
          droppedFiles.push(dropped);
          dataTransfer.items.add(dropped);
        }
        if (hasNonCanonicalType) {
          Object.defineProperty(dataTransfer, "files", { value: droppedFiles });
        }
        if (unreadable) {
          Object.defineProperty(dataTransfer, "types", { value: ["Files"] });
        } else if (files.length === 0) {
          dataTransfer.setData("text/uri-list", "https://example.test/");
        }
        // Synthetic drags have no platform drag session to supply the incoming cursor effect.
        Object.defineProperty(dataTransfer, "dropEffect", {
          value: "copy",
          writable: true,
        });
        const hoverPrevented = !target.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
        );
        const { dropEffect } = dataTransfer;
        const dropPrevented = !target.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
        );
        return { hoverPrevented, dropEffect, dropPrevented };
      });
    },
    { batches, overWarning, unreadable },
  );
  expect(results).toEqual(
    batches.map(() => ({
      hoverPrevented: true,
      dropEffect: expectedEffect,
      dropPrevented: true,
    })),
  );
}

async function drop(
  browser: Browser,
  files: (string | DroppedFile)[],
  options?: Parameters<typeof dropBatches>[2],
) {
  await dropBatches(browser, [files], options);
}

test("a file dropped before a conversation starts is refused and the draft stays", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(route);
  const editor = browser.locator(
    '[data-slot="composer-input"] [role="textbox"]',
  );
  await editor.fill("Keep this draft");
  await drop(browser, ["screenshot.png"]);
  const alert = screen.getByRole("alert").filter({ hasText: "screenshot.png" });
  await expect(alert).toContainText("no conversation here yet");
  await expect(alert).not.toContainText("can no longer take messages");
  await expect(editor).toHaveText("Keep this draft");
  await expect(browser).toHaveURL(/\/channel\/new\?agent=general-assistant$/);
});

test("each refused file gets its own message", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(route);
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await drop(browser, ["one.png", "two.png"]);
  const alert = screen.getByRole("alert").filter({ hasText: "one.png" });
  await expect(alert).toContainText("two.png");
  await expect(browser.locator('[role="alert"] p')).toHaveCount(2);
});

test("dropping a link stays on the draft without a file warning", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(route);
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await drop(browser, []);
  await expect(screen.getByRole("alert")).toBeHidden();
  await expect(browser).toHaveURL(route);
});

test("the home composer refuses a file before the first message", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await drop(browser, ["home.png"]);
  const warning = screen.getByRole("alert").filter({ hasText: "home.png" });
  await expect(warning).toContainText("no conversation here yet");
  await expect(browser).toHaveURL("/");
});

test("a second file dropped over the first warning is also refused", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(route);
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await drop(browser, ["first.png"]);
  const warning = screen.getByRole("alert").filter({ hasText: "first.png" });
  await expect(warning).toBeVisible();
  await drop(browser, ["second.png"], { overWarning: true });
  await expect(warning).toContainText("second.png");
  await expect(browser.locator('[role="alert"] p')).toHaveCount(2);
  await expect(browser).toHaveURL(route);
});

async function watchDuplicateReactKeys(browser: Browser) {
  await browser.addInitScript(() => {
    const reportError = console.error;
    console.error = (...args: unknown[]) => {
      if (
        args.some((arg) => typeof arg === "string" && arg.includes("same key"))
      ) {
        performance.mark("openbot-e2e-duplicate-react-key");
      }
      reportError.apply(console, args);
    };
  });
}

async function countDuplicateReactKeys(browser: Browser) {
  return browser.evaluate(
    () =>
      performance.getEntriesByName("openbot-e2e-duplicate-react-key").length,
  );
}

test("the composer gives same-named refused files separate entries and dismisses them together", async ({
  app,
  browser,
  screen,
}) => {
  await watchDuplicateReactKeys(browser);
  await app.open(route);
  const editor = browser.locator(
    '[data-slot="composer-input"] [role="textbox"]',
  );
  await editor.fill("Keep my draft");
  const alert = browser.locator('[role="alert"]');
  await expect(alert).toHaveCount(0);

  await drop(browser, ["screenshot.png", "screenshot.png"]);
  const rows = browser.locator('[role="alert"] p');
  await expect(rows).toHaveCount(2);
  for (const line of [rows.first(), rows.last()]) {
    await expect(line).toContainText("screenshot.png:");
    await expect(line).toContainText("no conversation here yet");
  }
  expect(await countDuplicateReactKeys(browser)).toBe(0);

  await screen
    .getByRole("button", "Dismiss these 2 refusals", { exact: true })
    .tap();
  await expect(alert).toHaveCount(0);
  await expect(editor).toHaveText("Keep my draft");
});

for (const { name, svgName, pdfName } of [
  {
    name: "each rejected filename is paired with its own reason in drop order",
    svgName: "diagram.svg",
    pdfName: "invoice.pdf",
  },
  {
    name: "same-named rejected files keep their different reasons and React keys",
    svgName: "document",
    pdfName: "document",
  },
]) {
  test(name, async ({ app, browser, screen }) => {
    await watchDuplicateReactKeys(browser);
    await app.open("/");
    const channelId = await createConversation(browser, "general-assistant");
    await app.open(`/channel/${channelId}`);
    await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();

    await drop(
      browser,
      [
        { name: svgName, type: "image/svg+xml", text: "<svg />" },
        { name: pdfName, type: "application/pdf", text: "%PDF" },
      ],
      { expectedEffect: "copy" },
    );
    const rows = browser.locator('[role="alert"] p');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveText(
      `${svgName}: '${svgName}' can't be attached. SVG files aren't accepted.`,
    );
    await expect(rows.last()).toHaveText(
      `${pdfName}: '${pdfName}' isn't a file type you can attach.`,
    );
    expect(await countDuplicateReactKeys(browser)).toBe(0);
  });
}

test("a single file warning uses a singular dismiss action", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(route);
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await drop(browser, ["single.png"]);
  await expect(screen.getByRole("alert")).toContainText("single.png:");
  await screen
    .getByRole("button", "Dismiss this refusal", { exact: true })
    .tap();
  await expect(browser.locator('[role="alert"]')).toHaveCount(0);
  await expect(browser).toHaveURL(route);
});

test("the refusal panel leaves space above the composer after it expands", async ({
  app,
  browser,
  screen,
}) => {
  await browser.emulateMedia({ reducedMotion: "reduce" });
  await app.open(route);
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await drop(browser, ["gap.png"]);
  await expect(screen.getByRole("alert")).toContainText("gap.png");
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const form = document.querySelector('[data-slot="composer"]');
        const alert = form?.parentElement?.querySelector('[role="alert"]');
        if (!form || !alert) return null;
        const rootFontSize = Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        );
        const gap =
          form.getBoundingClientRect().top -
          alert.getBoundingClientRect().bottom;
        return Math.abs(gap - rootFontSize / 2);
      }),
    )
    .toBeLessThanOrEqual(1);
});

test("an active conversation accepts file drops and opens the file picker", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  const channelId = await createConversation(browser, "general-assistant");
  await app.open(`/channel/${channelId}`);
  const attach = screen.getByRole("button", "Attach a file", { exact: true });
  await expect(attach).toBeEnabled();
  const send = screen.getByRole("button", "Send message", { exact: true });

  await drop(browser, ["dropped.txt"], { expectedEffect: "copy" });
  const removeDrop = screen.getByRole("button", "Remove dropped.txt", {
    exact: true,
  });
  await expect(removeDrop).toBeVisible();
  await expect(send).toBeEnabled();
  await removeDrop.tap();
  await expect(removeDrop).toBeHidden();
  await expect(send).toBeDisabled();

  await attach.setInputFiles("tests/e2e/fixtures/attachment.txt");
  await expect(
    screen.getByRole("button", "Remove attachment.txt", { exact: true }),
  ).toBeVisible();
  await expect(send).toBeEnabled();
  await expect(screen.getByRole("alert")).toBeHidden();
  await expect(browser).toHaveURL(`/channel/${channelId}`);
});

async function createConversation(browser: Browser, agentId: string) {
  return browser.evaluate(async (agentId) => {
    const response = await fetch("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [agentId] }),
    });
    if (!response.ok)
      throw new Error(
        `Could not prepare the conversation: HTTP ${response.status}`,
      );
    const data: { channel: { id: string } } = await response.json();
    return data.channel.id;
  }, agentId);
}

test("a conversation with a deleted Bot refuses files without asking the person to send", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { id } = await createBot(fixtures);
  const channelId = await createConversation(browser, id);
  const deleted = await browser.evaluate(async (agentId) => {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
    });
    return response.status;
  }, id);
  expect(deleted).toBe(204);
  const uploads: string[] = [];
  await browser.route(/\/api\/channels\/[^/]+\/attachments$/, async (route) => {
    if (route.request.method === "POST") {
      uploads.push(new URL(route.request.url).pathname);
    }
    await route.continue();
  });
  await app.open(`/channel/${channelId}`);
  await expect(screen.getByRole("textbox", "Message")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(
    screen.getByRole("button", "Send message", { exact: true }),
  ).toBeDisabled();
  await expect(
    screen.getByRole("button", "Attach a file", { exact: true }),
  ).toBeDisabled();
  await expect(
    browser.locator('[data-slot="composer"] input[type="file"]'),
  ).toBeDisabled();
  await drop(browser, ["receipt.png"]);
  await expect(screen.getByRole("button", "Remove receipt.png")).toHaveCount(0);
  const warning = screen.getByRole("alert").filter({ hasText: "receipt.png" });
  await expect(warning).toContainText("can no longer take messages");
  await expect(warning).not.toContainText("no conversation here yet");
  await expect(browser).toHaveURL(`/channel/${channelId}`);

  const liveId = await createConversation(browser, "general-assistant");
  await app.open(`/channel/${liveId}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  const uploaded = browser.waitForResponse(
    new RegExp(`/api/channels/${RegExp.escape(liveId)}/attachments$`),
  );
  await drop(browser, ["kept.txt"], { expectedEffect: "copy" });
  const response = await uploaded;
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ name: "kept.txt" });
  await expect(screen.getByRole("button", "Remove kept.txt")).toBeVisible();
  await expect(screen.getByRole("button", "Remove receipt.png")).toHaveCount(0);
  expect(uploads).toEqual([`/api/channels/${liveId}/attachments`]);
});

test("an inactive conversation lets file paste bubble, while an active one uploads it", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const { id } = await createBot(fixtures);
  const channelId = await createConversation(browser, id);
  const liveId = await createConversation(browser, "general-assistant");
  const deleted = await browser.evaluate(async (agentId) => {
    return (
      await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: "DELETE",
      })
    ).status;
  }, id);
  expect(deleted).toBe(204);
  const uploads: string[] = [];
  await browser.route(/\/api\/channels\/[^/]+\/attachments$/, async (route) => {
    if (route.request.method === "POST") {
      uploads.push(new URL(route.request.url).pathname);
    }
    await route.continue();
  });
  const file = {
    name: "clipboard.png",
    type: "image/png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
  };
  const remove = screen.getByRole("button", "Remove clipboard.png");

  await app.open(`/channel/${channelId}`);
  await expect(screen.getByRole("textbox", "Message")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect((await pasteFile(browser, file)).bubbled).toBe(true);
  await expect(remove).toHaveCount(0);
  await expect(screen.getByRole("alert")).toHaveCount(0);

  await app.open(`/channel/${liveId}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  await screen.getByRole("textbox", "Message").focus();
  const uploaded = browser.waitForResponse(
    new RegExp(`/api/channels/${RegExp.escape(liveId)}/attachments$`),
  );
  expect(await pasteFile(browser, file)).toEqual({
    prevented: true,
    bubbled: false,
  });
  const response = await uploaded;
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ name: file.name });
  await expect(remove).toBeVisible();
  await expect(
    browser.locator('[data-slot="composer"] li img'),
  ).toHaveAttribute("alt", file.name);
  await expect(screen.getByRole("alert")).toHaveCount(0);
  expect(uploads).toEqual([`/api/channels/${liveId}/attachments`]);
});

test("the starting screen refuses files without asking the person to send again", async ({
  app,
  browser,
  screen,
}) => {
  const release = Promise.withResolvers<void>();
  await browser.route(/\/api\/route$/, async (route) => {
    await release.promise;
    await route.abort();
  });
  try {
    await app.open("/");
    const editor = screen.getByRole("textbox", "Message");
    await editor.fill("Wait while this starts");
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await expect(browser).toHaveURL(/\/start\/[^/?#]+$/);
    await expect(editor).toHaveAttribute("aria-disabled", "true");
    await expect(
      screen.getByRole("button", "Send message", { exact: true }),
    ).toBeDisabled();
    await drop(browser, ["late.png"]);
    const warning = screen.getByRole("alert").filter({ hasText: "late.png" });
    await expect(warning).toContainText("can no longer take messages");
    await expect(warning).not.toContainText("Send this message first");
    await expect(
      screen.getByText("Wait while this starts", { exact: true }),
    ).toBeVisible();
  } finally {
    release.resolve();
  }
});

test("a dropped PNG previews and uploads to its conversation", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const id = await createConversation(browser, "general-assistant");
  await app.open(`/channel/${id}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  const response = browser.waitForResponse(
    /\/api\/channels\/[^/]+\/attachments$/,
  );
  await drop(
    browser,
    [
      {
        name: "Screenshot.png",
        type: "image/png",
        base64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
      },
    ],
    { expectedEffect: "copy" },
  );

  const uploaded = await response;
  expect(uploaded.status).toBe(201);
  const attachment = await uploaded.json<{ id: string }>();
  await expect(browser.locator('[data-slot="composer"] li img')).toBeVisible();
  const list = screen.getByRole("list", "Attachments", { exact: true });
  await expect(list).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  const remove = screen.getByRole("button", "Remove Screenshot.png");
  await expect(remove).toBeVisible();
  await expect(screen.getByRole("button", "Send message")).toBeEnabled();
  await expect(screen.getByRole("alert")).toBeHidden();
  await remove.tap();
  await expect(list).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(
        async (id) =>
          (await fetch(`/api/attachments/${id}`, { cache: "no-store" })).status,
        attachment.id,
      ),
    )
    .toBe(404);
});

test("a rejected SVG is explained once and a parameterized text file still uploads", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const id = await createConversation(browser, "general-assistant");
  await app.open(`/channel/${id}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  let uploads = 0;
  const attachmentRoute = /\/api\/channels\/[^/]+\/attachments$/;
  await browser.route(attachmentRoute, async (route) => {
    if (route.request.method === "POST") uploads += 1;
    await route.continue();
  });
  await drop(
    browser,
    [{ name: "logo.svg", type: "image/svg+xml", text: "<svg />" }],
    { expectedEffect: "copy" },
  );
  const warning = screen.getByRole("alert");
  await expect(warning).toContainText("logo.svg");
  await expect(warning).toContainText("SVG");
  await expect(warning).not.toContainText("Supported types:");
  await expect(browser.locator('[role="alert"] p')).toHaveCount(1);
  expect(uploads).toBe(0);
  await screen.getByRole("button", "Dismiss this refusal").tap();

  const response = browser.waitForResponse(attachmentRoute);
  await drop(
    browser,
    [{ name: "notes.txt", type: "text/plain;charset=utf-8" }],
    { expectedEffect: "copy" },
  );
  expect((await response).status).toBe(201);
  await expect(screen.getByRole("button", "Remove notes.txt")).toBeVisible();
  await expect(screen.getByRole("button", "Send message")).toBeEnabled();
  await expect(warning).toBeHidden();
  expect(uploads).toBe(1);
});

test("a file drag without readable bytes explains how to attach the file", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const id = await createConversation(browser, "general-assistant");
  await app.open(`/channel/${id}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  let uploads = 0;
  await browser.route(/\/api\/channels\/[^/]+\/attachments$/, async (route) => {
    if (route.request.method === "POST") uploads += 1;
    await route.continue();
  });
  await drop(browser, [], { expectedEffect: "copy", unreadable: true });
  const warning = screen.getByRole("alert");
  await expect(warning).toContainText("Dropped file");
  await expect(warning).toContainText("Attach it with +");
  expect(uploads).toBe(0);
});

for (const { file, serverMime, warns } of [
  {
    file: {
      name: "shot.bin",
      type: "application/octet-stream",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
    },
    serverMime: "image/png",
    warns: false,
  },
  {
    file: {
      name: "large-notes.png",
      type: "image/png",
      text: "x".repeat(120_001),
    },
    serverMime: "text/plain",
    warns: true,
  },
  {
    file: { name: "small-notes.png", type: "image/png", text: "hello" },
    serverMime: "text/plain",
    warns: false,
  },
]) {
  test(`the composer uses the uploaded type for ${file.name}`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/");
    const id = await createConversation(browser, "general-assistant");
    await app.open(`/channel/${id}`);
    await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();

    const attachmentRoute = new RegExp(
      `/api/channels/${RegExp.escape(id)}/attachments$`,
    );
    if (serverMime === "text/plain") {
      await browser.route(attachmentRoute, async (route) => {
        await route.fulfill({
          status: 201,
          json: {
            id: "fixture-text-attachment",
            name: file.name,
            mimeType: serverMime,
          },
        });
      });
    }
    const upload = browser.waitForResponse(attachmentRoute);
    await drop(browser, [file], { expectedEffect: "copy" });
    const response = await upload;
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      name: file.name,
      mimeType: serverMime,
    });
    await expect(
      screen.getByRole("button", `Remove ${file.name}`),
    ).toBeVisible();
    await expect(screen.getByRole("button", "Send message")).toBeEnabled();
    const attachments = screen.getByRole("list", "Attachments");
    const preview = browser.locator('[data-slot="composer"] li img');
    if (serverMime === "image/png") {
      await expect(preview).toHaveAttribute("alt", file.name);
    } else {
      await expect(preview).toHaveCount(0);
      await expect(
        attachments.getByText(file.name, { exact: true }),
      ).toBeVisible();
    }
    if (warns) {
      await expect(attachments).toContainText("may be cut");
    } else {
      await expect(attachments).not.toContainText("may be cut");
    }
  });
}

test("non-file content dropped into an active composer does not trigger a refusal", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const id = await createConversation(browser, "general-assistant");
  await app.open(`/channel/${id}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  await drop(browser, [], { expectedEffect: "copy" });
  await expect(browser.locator('[role="alert"]')).toHaveCount(0);
  await expect(screen.getByRole("list", "Attachments")).toBeHidden();
  await expect(browser).toHaveURL(`/channel/${id}`);
});

test("a text attachment with an uppercase MIME type is accepted", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const id = await createConversation(browser, "general-assistant");
  await app.open(`/channel/${id}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();

  const upload = browser.waitForResponse(
    new RegExp(`/api/channels/${RegExp.escape(id)}/attachments$`),
  );
  await drop(browser, [{ name: "uppercase.txt", type: "TEXT/PLAIN" }], {
    expectedEffect: "copy",
  });
  const response = await upload;
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    name: "uppercase.txt",
    mimeType: "text/plain",
  });
  await expect(
    screen.getByRole("button", "Remove uppercase.txt", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("button", "Send message", { exact: true }),
  ).toBeEnabled();
  await expect(browser.locator('[role="alert"]')).toHaveCount(0);
});

for (const { file, preview } of [
  {
    file: {
      name: "pasted.png",
      type: "image/png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
    },
    preview: true,
  },
  { file: { name: "rows.csv", type: "text/csv", text: "a,b" }, preview: false },
  {
    file: {
      name: "notes.txt",
      type: "text/plain;charset=utf-8",
      text: "hello",
    },
    preview: false,
  },
]) {
  test(`pasting ${file.name} attaches it without inserting text`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/");
    const id = await createConversation(browser, "general-assistant");
    await app.open(`/channel/${id}`);
    await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
    const editor = screen.getByRole("textbox", "Message");
    await editor.focus();
    let uploads = 0;
    const path = /\/api\/channels\/[^/]+\/attachments$/;
    await browser.route(path, async (route) => {
      if (route.request.method === "POST") uploads += 1;
      await route.continue();
    });
    const upload = browser.waitForResponse(path);

    expect(await pasteFile(browser, file)).toEqual({
      prevented: true,
      bubbled: false,
    });
    const response = await upload;
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ name: file.name });
    await expect(
      screen.getByRole("button", `Remove ${file.name}`, { exact: true }),
    ).toBeVisible();
    await expect(screen.getByRole("button", "Send message")).toBeEnabled();
    if (preview) {
      await expect(
        browser.locator('[data-slot="composer"] li img'),
      ).toHaveAttribute("alt", file.name);
    }
    await expect(editor).toHaveText("");
    await expect(browser.locator('[role="alert"]')).toHaveCount(0);
    expect(uploads).toBe(1);
  });
}

test("pasting a spreadsheet cell inserts its plain text without uploading the file", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const id = await createConversation(browser, "general-assistant");
  await app.open(`/channel/${id}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  const editor = screen.getByRole("textbox", "Message");
  await editor.focus();
  let uploads = 0;
  await browser.route(/\/api\/channels\/[^/]+\/attachments$/, async (route) => {
    if (route.request.method === "POST") uploads += 1;
    await route.continue();
  });

  await pasteFile(
    browser,
    { name: "cell.html", type: "text/html", text: "<td>7</td>" },
    "7",
  );
  await expect(editor).toHaveText("7");
  await expect(screen.getByRole("list", "Attachments")).toBeHidden();
  await expect(browser.locator('[role="alert"]')).toHaveCount(0);
  expect(uploads).toBe(0);
});

async function pasteFile(
  browser: Browser,
  file: DroppedFile | null,
  plainText = "",
) {
  return browser.evaluate(
    ({ file, plainText }) => {
      const editor = document.querySelector(
        '[data-slot="composer-input"] [role="textbox"]',
      );
      if (!editor) throw new Error("The conversation has no composer");
      const caret = document.createRange();
      caret.selectNodeContents(editor);
      caret.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
      const clipboardData = new DataTransfer();
      if (file) {
        const content = file.base64
          ? Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))
          : (file.text ?? "");
        clipboardData.items.add(
          new File([content], file.name, { type: file.type }),
        );
      }
      if (plainText) clipboardData.setData("text/plain", plainText);
      const observation = { bubbled: false };
      const observeBubble = () => {
        observation.bubbled = true;
      };
      document.addEventListener("paste", observeBubble);
      try {
        const prevented = !editor.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
        return { prevented, bubbled: observation.bubbled };
      } finally {
        document.removeEventListener("paste", observeBubble);
      }
    },
    { file, plainText },
  );
}

test("an image pasted with a caption is uploaded without typing the caption", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const id = await createConversation(browser, "general-assistant");
  await app.open(`/channel/${id}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  const editor = screen.getByRole("textbox", "Message");
  await editor.focus();
  const response = browser.waitForResponse(
    /\/api\/channels\/[^/]+\/attachments$/,
  );
  await pasteFile(
    browser,
    {
      name: "chart.png",
      type: "image/png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
    },
    "Q3 revenue",
  );
  expect((await response).status).toBe(201);
  await expect(screen.getByRole("button", "Remove chart.png")).toBeVisible();
  await expect(
    browser.locator('[data-slot="composer"] li img'),
  ).toHaveAttribute("alt", "chart.png");
  await expect(editor).toHaveText("");

  const plain = await pasteFile(browser, null, "just words");
  expect(plain.bubbled).toBe(true);
  await expect(editor).toHaveText("just words");
});

test("a file paste before opening a conversation bubbles without staging or uploading", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    const listen = document.addEventListener.bind(document);
    document.addEventListener = (
      ...args: Parameters<Document["addEventListener"]>
    ) => {
      if (args[0] === "paste")
        performance.mark("openbot-e2e-document-paste-listener");
      listen(...args);
    };
  });
  await app.open(route);
  const editor = screen.getByRole("textbox", "Message");
  await editor.fill("Keep the existing draft");
  await editor.focus();
  let uploads = 0;
  await browser.route(/\/api\/channels\/[^/]+\/attachments$/, async (route) => {
    if (route.request.method === "POST") uploads += 1;
    await route.continue();
  });

  expect(
    await browser.evaluate(
      () =>
        performance.getEntriesByName("openbot-e2e-document-paste-listener")
          .length,
    ),
  ).toBe(0);
  const paste = await pasteFile(browser, {
    name: "notes.txt",
    type: "text/plain",
    text: "hello",
  });
  expect(paste.bubbled).toBe(true);
  await expect(editor).toHaveText("Keep the existing draft");
  await expect(screen.getByRole("list", "Attachments")).toBeHidden();
  await expect(browser.locator('[role="alert"]')).toHaveCount(0);
  expect(uploads).toBe(0);
});

for (const { name, files, removed, kept } of [
  {
    name: "removing the only pending upload deletes its attachment when the upload finishes",
    files: ["notes.txt"],
    removed: ["notes.txt"],
    kept: [],
  },
  {
    name: "removing one of two pending uploads deletes only that attachment",
    files: ["gone.txt", "kept.txt"],
    removed: ["gone.txt"],
    kept: ["kept.txt"],
  },
  {
    name: "finishing a pending upload keeps its attachment available to send",
    files: ["notes.txt"],
    removed: [],
    kept: ["notes.txt"],
  },
]) {
  test(name, async ({ app, browser, screen }) => {
    await app.open("/");
    const channelId = await createConversation(browser, "general-assistant");
    await app.open(`/channel/${channelId}`);
    await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
    const send = screen.getByRole("button", "Send message", { exact: true });
    const uploadPath = new RegExp(
      `/api/channels/${RegExp.escape(channelId)}/attachments$`,
    );
    const uploads = files.map((file) => ({
      file,
      release: Promise.withResolvers<void>(),
    }));
    const pending = [...uploads];
    const deletedPaths: string[] = [];
    await browser.route(uploadPath, async (route) => {
      const upload = pending.shift();
      if (!upload) throw new Error("The composer attempted an extra upload");
      await upload.release.promise;
      await route.continue();
    });
    await browser.route(/\/api\/attachments\/[^/?]+$/, async (route) => {
      if (route.request.method === "DELETE") {
        deletedPaths.push(new URL(route.request.url).pathname);
      }
      await route.continue();
    });
    const remove = (file: string) =>
      screen.getByRole("button", `Remove ${file}`, { exact: true });

    try {
      for (const file of files) {
        await drop(browser, [file], { expectedEffect: "copy" });
        await expect(remove(file)).toBeVisible();
      }
      await expect(send).toBeDisabled();
      for (const file of removed) {
        await remove(file).tap();
        await expect(remove(file)).toBeHidden();
      }
      expect(deletedPaths).toEqual([]);

      const attachmentPaths = new Map<string, string>();
      for (const { file, release } of uploads) {
        const completed = browser.waitForResponse(uploadPath);
        release.resolve();
        const response = await completed;
        expect(response.status).toBe(201);
        const attachment = await response.json<{ id: string; name: string }>();
        expect(attachment.name).toBe(file);
        expect(attachment.id).toMatch(/\S/);
        attachmentPaths.set(file, `/api/attachments/${attachment.id}`);
      }
      await expect
        .poll(() => deletedPaths)
        .toEqual(removed.map((file) => attachmentPaths.get(file)));
      for (const file of removed) {
        await expect(remove(file)).toBeHidden();
        await expect
          .poll(() =>
            browser.evaluate(async (path) => {
              if (!path) throw new Error("Missing uploaded attachment");
              return (await fetch(path, { cache: "no-store" })).status;
            }, attachmentPaths.get(file) ?? null),
          )
          .toBe(404);
      }
      for (const file of kept) {
        await expect(remove(file)).toBeVisible();
        const status = await browser.evaluate(async (path) => {
          if (!path) throw new Error("Missing uploaded attachment");
          return (await fetch(path, { cache: "no-store" })).status;
        }, attachmentPaths.get(file) ?? null);
        expect(status).toBe(200);
      }
      if (kept.length > 0) {
        await expect(send).toBeEnabled();
      } else {
        await expect(send).toBeDisabled();
      }
      expect(deletedPaths).toEqual(
        removed.map((file) => attachmentPaths.get(file)),
      );
    } finally {
      for (const { release } of uploads) release.resolve();
    }
  });
}

for (const deleteFails of [false, true]) {
  test(
    deleteFails
      ? "removing a ready attachment still clears the draft when deletion fails"
      : "removing a ready attachment deletes the uploaded file",
    async ({ app, browser, screen }) => {
      await app.open("/");
      const channelId = await createConversation(browser, "general-assistant");
      await app.open(`/channel/${channelId}`);
      await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
      const send = screen.getByRole("button", "Send message", { exact: true });
      const remove = screen.getByRole("button", "Remove ready.txt", {
        exact: true,
      });
      const uploaded = browser.waitForResponse(
        new RegExp(`/api/channels/${RegExp.escape(channelId)}/attachments$`),
      );
      await drop(browser, ["ready.txt"], { expectedEffect: "copy" });
      const response = await uploaded;
      expect(response.status).toBe(201);
      const attachment = await response.json<{ id: string; name: string }>();
      expect(attachment.name).toBe("ready.txt");
      await expect(send).toBeEnabled();
      await expect(remove).toBeVisible();

      const path = `/api/attachments/${attachment.id}`;
      const deletes: string[] = [];
      await browser.route(/\/api\/attachments\/[^/?]+$/, async (route) => {
        if (route.request.method === "DELETE") {
          if (deleteFails) {
            await route.abort();
          } else {
            await route.continue();
          }
          deletes.push(new URL(route.request.url).pathname);
          return;
        }
        await route.continue();
      });
      await remove.tap();

      await expect(remove).toBeHidden();
      await expect(send).toBeDisabled();
      await expect.poll(() => deletes).toEqual([path]);
      await expect
        .poll(() =>
          browser.evaluate(
            async (path) => (await fetch(path, { cache: "no-store" })).status,
            path,
          ),
        )
        .toBe(deleteFails ? 200 : 404);
    },
  );
}

const composerFixture = "/tests/browser/composer.html";

test("the compact composer cannot add files until its conversation is set", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  const uploadPath = `/api/channels/${channelId}/attachments`;
  const uploadRequests: string[] = [];
  await browser.route(/\/api\/channels\/[^/]+\/attachments$/, async (route) => {
    if (route.request.method === "POST") {
      uploadRequests.push(new URL(route.request.url).pathname);
    }
    await route.continue();
  });
  await app.open(`${composerFixture}?layout=compact&channel=${channelId}`);
  const attach = screen.getByRole("button", "Attach a file");
  await expect(
    screen.getByRole("button", "More message options unavailable"),
  ).toBeDisabled();
  await expect(attach).toHaveCount(0);
  await expect(browser.locator('input[type="file"]')).toHaveCount(0);

  await drop(browser, [
    { name: "logo.svg", type: "image/svg+xml", text: "<svg />" },
    "ignored.txt",
  ]);
  const warning = screen.getByRole("alert");
  await expect(warning).toContainText("logo.svg");
  await expect(warning).toContainText("ignored.txt");
  await expect(warning).toContainText("no conversation here yet");
  await expect(warning).not.toContainText("SVG");

  await screen.getByRole("button", "Set conversation", { exact: true }).tap();
  await expect(attach).toBeEnabled();
  const uploaded = browser.waitForResponse(
    new RegExp(`${RegExp.escape(uploadPath)}$`),
  );
  await drop(browser, ["kept.txt"], { expectedEffect: "copy" });
  const response = await uploaded;
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ name: "kept.txt" });
  await expect(screen.getByRole("button", "Remove kept.txt")).toBeVisible();
  await expect(screen.getByRole("button", "Remove ignored.txt")).toHaveCount(0);
  await expect(screen.getByRole("button", "Remove logo.svg")).toHaveCount(0);
  await expect(warning).toContainText("no conversation here yet");
  expect(uploadRequests).toEqual([uploadPath]);
});

test("the full-size composer uploads an image pasted alongside text", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  await app.open(`${composerFixture}?channel=${channelId}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  const editor = screen.getByRole("textbox", "Message");
  await editor.focus();
  const uploadPath = new RegExp(
    `/api/channels/${RegExp.escape(channelId)}/attachments$`,
  );
  const uploadRequests: string[] = [];
  await browser.route(uploadPath, async (route) => {
    if (route.request.method === "POST") uploadRequests.push(route.request.url);
    await route.continue();
  });
  const uploaded = browser.waitForResponse(uploadPath);
  const paste = await pasteFile(
    browser,
    {
      name: "chart.png",
      type: "image/png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
    },
    "Q3 revenue",
  );
  expect(paste.prevented).toBe(true);

  const response = await uploaded;
  expect(response.status).toBe(201);
  const attachment = await response.json<{ id: string; name: string }>();
  expect(attachment.name).toBe("chart.png");
  await expect(screen.getByRole("button", "Remove chart.png")).toBeVisible();
  const preview = browser.locator('[data-slot="composer"] li img');
  await expect(preview).toHaveAttribute("alt", "chart.png");
  await expect(preview).toHaveAttribute(
    "src",
    `/api/attachments/${attachment.id}`,
  );
  await expect(editor).toHaveText("");
  expect(uploadRequests).toHaveLength(1);
});

test("removing the first same-named refusal preserves the surviving row", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${composerFixture}?rejections`);
  const rows = browser.locator('[role="alert"] p');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveText("screenshot.png: File is too large");
  await expect(rows.last()).toHaveText("screenshot.png: Unsupported file type");
  await browser.evaluate(() => {
    const survivor = document.querySelector('[role="alert"] p:last-child');
    if (!survivor) throw new Error("The second refusal was not rendered");
    survivor.setAttribute("data-e2e-survivor", "");
    return null;
  });

  await screen
    .getByRole("button", "Remove first refusal", { exact: true })
    .tap();

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText(
    "screenshot.png: Unsupported file type",
  );
  await expect(
    browser.locator('[role="alert"] p[data-e2e-survivor]'),
  ).toBeVisible();
});

for (const mode of ["send", "queue"]) {
  test(
    mode === "send"
      ? "a pending send carries its attachment once and leaves later uploads in the draft"
      : "a busy composer queues its attachment without sending or deleting the file",
    async ({ app, browser, screen }) => {
      await app.open("/");
      const channelId = await createConversation(browser, "general-assistant");
      await app.open(`${composerFixture}?channel=${channelId}&run=${mode}`);
      await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
      const queueing = mode === "queue";
      const action = screen.getByRole(
        "button",
        queueing ? "Queue message" : "Send message",
        { exact: true },
      );
      const sent = screen.getByRole("status", "Sent drafts");
      const queued = screen.getByRole("status", "Queued drafts");
      const uploadPath = new RegExp(
        `/api/channels/${RegExp.escape(channelId)}/attachments$`,
      );
      const deletes: string[] = [];
      await browser.route(/\/api\/attachments\/[^/?]+$/, async (route) => {
        if (route.request.method === "DELETE") {
          deletes.push(new URL(route.request.url).pathname);
        }
        await route.continue();
      });

      const logo = { name: "logo.svg", type: "image/svg+xml", text: "<svg />" };
      const warning = screen.getByRole("alert");
      if (!queueing) {
        await drop(browser, [logo], { expectedEffect: "copy" });
        await expect(warning).toContainText("SVG files aren't accepted");
        await screen.getByRole("button", "Dismiss this refusal").tap();
        await expect(warning).toHaveCount(0);
      }

      const firstUpload = browser.waitForResponse(uploadPath);
      await drop(browser, queueing ? ["notes.txt"] : [logo, "notes.txt"], {
        expectedEffect: "copy",
      });
      const response = await firstUpload;
      expect(response.status).toBe(201);
      const attachment = await response.json<{ id: string; name: string }>();
      expect(attachment.name).toBe("notes.txt");
      const notes = screen.getByRole("button", "Remove notes.txt");
      await expect(notes).toBeVisible();
      await expect(action).toBeEnabled();
      if (!queueing) await expect(warning).toContainText("logo.svg");

      await action.tap();
      await expect(notes).toHaveCount(0);
      if (queueing) {
        await expect(queued).toHaveText(JSON.stringify([[attachment.id]]));
        await expect(sent).toHaveText("[]");
      } else {
        await expect(sent).toHaveText(JSON.stringify([[attachment.id]]));
        await expect(warning).toHaveCount(0);
        await expect(action).toBeDisabled();
        await browser.evaluate(() => {
          const form = document
            .querySelector('[data-slot="composer-input"]')
            ?.closest("form");
          if (!form) throw new Error("The composer has no form");
          form.requestSubmit();
          return null;
        });
        await expect(sent).toHaveText(JSON.stringify([[attachment.id]]));
        await expect(queued).toHaveText("[]");

        const secondUpload = browser.waitForResponse(uploadPath);
        await drop(browser, ["report.txt"], { expectedEffect: "copy" });
        const reportResponse = await secondUpload;
        expect(reportResponse.status).toBe(201);
        expect(await reportResponse.json()).toMatchObject({
          name: "report.txt",
        });
        const report = screen.getByRole("button", "Remove report.txt");
        await expect(report).toBeVisible();

        await screen.getByRole("button", "Finish send").tap();
        await expect(action).toBeEnabled();
        await expect(report).toBeVisible();
        await expect(notes).toHaveCount(0);
        await expect(sent).toHaveText(JSON.stringify([[attachment.id]]));
        await expect(queued).toHaveText("[]");
      }
      const status = await browser.evaluate(async (id) => {
        return (await fetch(`/api/attachments/${id}`, { cache: "no-store" }))
          .status;
      }, attachment.id);
      expect(status).toBe(200);
      expect(deletes).toEqual([]);
    },
  );
}

const opening = "Stored opening";

for (const withdraw of [false, true]) {
  test(
    withdraw
      ? "a failed queued message gives back its attachment only when withdrawn"
      : "a failed queued reply keeps its attachment and retries before the next message",
    async ({ app, browser, screen }) => {
      await configureChatStream(browser, opening);
      await app.open("/");
      const channelId = await createConversation(browser, "general-assistant");
      const runs: ReturnType<typeof readChatRun>[] = [];
      const releaseFirst = Promise.withResolvers<void>();
      const releaseFailed = Promise.withResolvers<void>();
      const deletes: string[] = [];
      const plan = "Use the attached plan";
      const correction = "And the summary too";
      await browser.route(chatRunPath, async (route) => {
        const run = readChatRun(route.request.postData);
        const attempt = runs.push(run);
        if (attempt === 1) await releaseFirst.promise;
        if (attempt === 2) {
          await releaseFailed.promise;
          await route.fulfill({ status: 503, body: "upstream unavailable" });
          return;
        }
        const ids = { threadId: run.threadId, runId: run.runId };
        const events = [
          { type: "RUN_STARTED", ...ids },
          { type: "RUN_FINISHED", ...ids },
        ];
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: events
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        });
      });
      await browser.route(/\/api\/attachments\/[^/?]+$/, async (route) => {
        if (route.request.method === "DELETE") {
          deletes.push(new URL(route.request.url).pathname);
        }
        await route.continue();
      });

      try {
        await app.open(`/channel/${channelId}`);
        await expect(screen.getByText(opening, { exact: true })).toBeVisible();
        const editor = screen.getByRole("textbox", "Message");
        const send = screen.getByRole("button", "Send message", {
          exact: true,
        });
        const queue = screen.getByRole("button", "Queue message", {
          exact: true,
        });
        const queued = screen.getByRole("button", /^Remove queued message/);
        await editor.fill("Get started");
        await send.tap();
        await expect.poll(() => runs.length).toBe(1);

        const uploaded = browser.waitForResponse(
          new RegExp(`/api/channels/${RegExp.escape(channelId)}/attachments$`),
        );
        await drop(browser, ["plan.txt"], { expectedEffect: "copy" });
        const response = await uploaded;
        expect(response.status).toBe(201);
        const attachment = await response.json<{ id: string; name: string }>();
        expect(attachment.name).toBe("plan.txt");
        const path = `/api/attachments/${attachment.id}`;
        await expect(
          screen.getByRole("button", "Remove plan.txt"),
        ).toBeVisible();

        await editor.fill(plan);
        await expect(queue).toBeEnabled();
        await queue.tap();
        await expect(queued).toBeVisible();
        expect(deletes).toEqual([]);

        releaseFirst.resolve();
        await expect.poll(() => runs.length).toBe(2);
        await expect(queued).toHaveCount(0);
        const drained = browser.waitForResponse(chatRunPath);
        releaseFailed.resolve();
        expect((await drained).status).toBe(503);
        const parked = browser
          .locator('[data-slot="message"]')
          .filter({ has: queued });
        await expect(parked).toContainText(plan);
        await expect(parked).toContainText("plan.txt");
        const transcript = browser
          .locator('[data-slot="message"]')
          .filter({ hasText: plan })
          .filter({ hasNot: queued });
        await expect(transcript).toContainText(plan);
        await expect(screen.getByText("plan.txt", { exact: true })).toHaveCount(
          2,
        );
        const failedMessage = JSON.stringify(runs[1]?.messages.at(-1));
        expect(failedMessage).toContain(path);
        expect(failedMessage).toContain(plan);
        expect(deletes).toEqual([]);

        if (withdraw) {
          expect(runs).toHaveLength(2);
          await queued.tap();
          await expect(queued).toHaveCount(0);
          await expect.poll(() => deletes).toEqual([path]);
          await expect
            .poll(() =>
              browser.evaluate(
                async (path) =>
                  (await fetch(path, { cache: "no-store" })).status,
                path,
              ),
            )
            .toBe(404);
          expect(runs).toHaveLength(2);
          return;
        }

        await editor.fill(correction);
        await expect(send).toBeEnabled();
        expect(runs).toHaveLength(2);
        await send.tap();
        await expect.poll(() => runs.length).toBe(3);
        await expect(queued).toHaveCount(0);
        const retried = JSON.stringify(runs[2]?.messages.at(-1));
        expect(retried).toContain(path);
        expect(retried).toContain(
          JSON.stringify(`${plan}\n${correction}`).slice(1, -1),
        );
        const status = await browser.evaluate(
          async (path) => (await fetch(path, { cache: "no-store" })).status,
          path,
        );
        expect(status).toBe(200);
        expect(deletes).toEqual([]);
      } finally {
        releaseFirst.resolve();
        releaseFailed.resolve();
      }
    },
  );
}

for (const newer of [false, true]) {
  test(
    newer
      ? "a failed send restores the original text ahead of words typed while sending"
      : "a failed send restores the draft and re-enables Send",
    async ({ app, browser, screen }) => {
      await app.open(`${composerFixture}?run=send`);
      const editor = screen.getByRole("textbox", "Message");
      const send = screen.getByRole("button", "Send message", { exact: true });
      const form = browser.locator("form[aria-busy]");
      await editor.fill("Ship it");
      await send.tap();
      await expect(form).toHaveAttribute("aria-busy", "true");
      await expect(editor).toHaveText("");
      if (newer) {
        await editor.fill("Include the update");
        await expect(editor).toHaveText("Include the update");
      }

      await screen.getByRole("button", "Fail send", { exact: true }).tap();

      await expect(form).toHaveAttribute("aria-busy", "false");
      await expect(editor).toHaveText(
        newer ? /Ship it\s*Include the update/ : "Ship it",
      );
      await expect(send).toBeEnabled();
    },
  );
}

test("attachments restored after a failed send block retries above the per-message cap", async ({
  app,
  browser,
  screen,
}) => {
  await configureChatStream(browser, opening);
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  const release = Promise.withResolvers<void>();
  const uploads = new Map<string, string>();
  const deletes: string[] = [];
  const runs: ReturnType<typeof readChatRun>[] = [];
  await browser.route(chatRunPath, async (route) => {
    runs.push(readChatRun(route.request.postData));
    await release.promise;
    await route.fulfill({ status: 503, body: "upstream unavailable" });
  });
  await browser.route(
    new RegExp(`/api/channels/${RegExp.escape(channelId)}/attachments$`),
    async (route) => {
      // Both batches reached storage in the original regression, before the send failed.
      // Replay those successful uploads while the test supplies the run failure separately.
      const file = (await readMultipartPost(route.request)).get("file");
      if (!(file instanceof File)) throw new Error("No file sent for upload");
      const id = `fixture-${file.name}`;
      uploads.set(file.name, id);
      await route.fulfill({
        status: 201,
        json: { id, name: file.name, mimeType: "text/plain" },
      });
    },
  );
  await browser.route(/\/api\/attachments\/fixture-[^/?]+$/, async (route) => {
    if (route.request.method === "DELETE") {
      deletes.push(new URL(route.request.url).pathname);
      await route.fulfill({ status: 204 });
    } else {
      await route.continue();
    }
  });

  try {
    await app.open(`/channel/${channelId}`);
    await expect(screen.getByText(opening, { exact: true })).toBeVisible();
    const send = screen.getByRole("button", "Send message", { exact: true });
    const queue = screen.getByRole("button", "Queue message", { exact: true });
    const chips = browser.locator(
      '[data-slot="composer"] button[aria-label^="Remove "]',
    );
    const remove = (name: string) =>
      screen.getByRole("button", `Remove ${name}`, { exact: true });
    const names = (batch: string) =>
      Array.from(
        { length: MAX_ATTACHMENTS_PER_MESSAGE },
        (_, index) => `${batch}-${index}.txt`,
      );
    const first = names("first");
    const second = names("second");

    await drop(browser, first, { expectedEffect: "copy" });
    await expect(chips).toHaveCount(first.length);
    await expect(send).toBeEnabled();
    await send.tap();
    await expect.poll(() => runs.length).toBe(1);
    await expect(chips).toHaveCount(0);

    await drop(browser, second, { expectedEffect: "copy" });
    await expect(chips).toHaveCount(second.length);
    await expect(queue).toBeEnabled();
    expect([...uploads.keys()]).toEqual([...first, ...second]);
    const failed = browser.waitForResponse(chatRunPath);
    release.resolve();
    expect((await failed).status).toBe(503);
    await expect(chips).toHaveCount(first.length + second.length);
    for (const name of [...first, ...second]) {
      await expect(remove(name)).toBeVisible();
    }
    const cap = screen.getByText(
      new RegExp(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`),
    );
    await expect(cap).toBeVisible();
    await expect(send).toBeDisabled();
    expect(deletes).toEqual([]);

    for (const name of second) await remove(name).tap();
    await expect(chips).toHaveCount(first.length);
    await expect(send).toBeEnabled();
    await expect(cap).toHaveCount(0);
    await expect
      .poll(() => [...deletes].sort())
      .toEqual(
        second.map((name) => `/api/attachments/${uploads.get(name)}`).sort(),
      );
    expect(runs).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

for (const { action, count, name } of [
  {
    action: "remove",
    count: MAX_ATTACHMENTS_PER_MESSAGE,
    name: "a full attachment queue refuses overflow locally and withdrawal frees its slots",
  },
  {
    action: "drain",
    count: MAX_ATTACHMENTS_PER_MESSAGE,
    name: "a full attachment queue drains all its files into the next turn",
  },
  {
    action: "mixed",
    count: MAX_ATTACHMENTS_PER_MESSAGE - 1,
    name: "parked attachments and draft attachments share the same cap",
  },
  {
    action: "leave",
    count: 1,
    name: "leaving a conversation deletes the attachments of its parked draft",
  },
  {
    action: "empty",
    count: 1,
    name: "leaving with an empty queue leaves the composer's staged attachment alone",
  },
  {
    action: "disable",
    count: 1,
    name: "a conversation disabled as its turn ends retains its queued attachment",
  },
]) {
  test(name, async ({ app, browser, screen }) => {
    await configureChatStream(browser, opening);
    await app.open("/");
    const channelId = await createConversation(browser, "general-assistant");
    const release = Promise.withResolvers<void>();
    const runs: ReturnType<typeof readChatRun>[] = [];
    const uploadedRequests: string[] = [];
    const deletedPaths: string[] = [];
    const paths: string[] = [];
    const uploadPath = new RegExp(
      `/api/channels/${RegExp.escape(channelId)}/attachments$`,
    );
    await browser.route(chatRunPath, async (route) => {
      const run = readChatRun(route.request.postData);
      const attempt = runs.push(run);
      if (attempt === 1) await release.promise;
      const ids = { threadId: run.threadId, runId: run.runId };
      const events = [
        { type: "RUN_STARTED", ...ids },
        { type: "RUN_FINISHED", ...ids },
      ];
      await route.fulfill({
        contentType: "text/event-stream",
        body: events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      });
    });
    await browser.route(uploadPath, async (route) => {
      if (route.request.method === "POST")
        uploadedRequests.push(route.request.url);
      await route.continue();
    });
    await browser.route(/\/api\/attachments\/[^/?]+$/, async (route) => {
      if (route.request.method === "DELETE") {
        deletedPaths.push(new URL(route.request.url).pathname);
      }
      await route.continue();
    });
    const upload = async (name: string) => {
      const uploaded = browser.waitForResponse(uploadPath);
      await drop(browser, [name], { expectedEffect: "copy" });
      const response = await uploaded;
      expect(response.status).toBe(201);
      const attachment = await response.json<{ id: string; name: string }>();
      expect(attachment.name).toBe(name);
      return `/api/attachments/${attachment.id}`;
    };
    const readStatuses = (paths: string[]) =>
      browser.evaluate(
        (paths) =>
          Promise.all(
            paths.map(
              async (path) => (await fetch(path, { cache: "no-store" })).status,
            ),
          ),
        paths,
      );

    try {
      if (action === "disable") {
        await app.open(`${composerFixture}?channel=${channelId}&conversation`);
      } else {
        await app.open(`/channel/${channelId}`);
        await expect(screen.getByText(opening, { exact: true })).toBeVisible();
      }
      const send = screen.getByRole("button", "Send message", { exact: true });
      const queue = screen.getByRole("button", "Queue message", {
        exact: true,
      });
      const queued = screen.getByRole("button", /^Remove queued message/);
      const chips = browser.locator(
        '[data-slot="composer"] button[aria-label^="Remove "]',
      );
      const bots = screen.getByRole("link", "Bots", { exact: true });

      if (action !== "empty" && action !== "disable") {
        await screen.getByRole("textbox", "Message").fill("Get started");
        await send.tap();
        await expect.poll(() => runs.length).toBe(1);
      }

      for (let index = 0; index < count; index += 1) {
        paths.push(await upload(`parked-${index}.txt`));
      }
      await expect(chips).toHaveCount(count);
      await expect(action === "empty" ? send : queue).toBeEnabled();

      if (action === "empty") {
        await expect(queued).toHaveCount(0);
        await bots.tap();
        await expect(browser).toHaveURL("/bots");
        expect(await readStatuses(paths)).toEqual([200]);
        expect(deletedPaths).toEqual([]);
        expect(runs).toHaveLength(0);
        return;
      }

      await queue.tap();
      await expect(queued).toBeVisible();
      await expect(chips).toHaveCount(0);
      expect(deletedPaths).toEqual([]);
      expect(await readStatuses(paths)).toEqual(paths.map(() => 200));

      if (action === "mixed") {
        paths.push(await upload("last-slot.txt"));
        await expect(chips).toHaveCount(1);
        await expect(queue).toBeEnabled();
        await drop(browser, ["overflow.txt"], { expectedEffect: "copy" });
        await expect(
          screen.getByRole("alert").filter({ hasText: "overflow.txt" }),
        ).toContainText(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
        await expect(
          screen.getByRole("button", "Remove last-slot.txt"),
        ).toBeVisible();
        await expect(chips).toHaveCount(1);
        await expect(queued).toBeVisible();
        expect(uploadedRequests).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
        expect(deletedPaths).toEqual([]);
        return;
      }

      if (action === "disable") {
        await screen
          .getByRole("button", "Finish turn and disable conversation", {
            exact: true,
          })
          .tap();
        await expect(screen.getByRole("textbox", "Message")).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await expect(queued).toBeVisible();
        await expect(screen.getByRole("status", "Sent drafts")).toHaveText(
          "[]",
        );
        expect(await readStatuses(paths)).toEqual([200]);
        expect(deletedPaths).toEqual([]);
        return;
      }

      if (action === "remove" || action === "drain") {
        await drop(browser, ["overflow.txt"], { expectedEffect: "copy" });
        const overflow = screen
          .getByRole("alert")
          .filter({ hasText: "overflow.txt" });
        await expect(overflow).toContainText(
          `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
        );
        await expect(chips).toHaveCount(0);
        expect(uploadedRequests).toHaveLength(count);
      }

      if (action === "drain") {
        release.resolve();
        await expect.poll(() => runs.length).toBe(2);
        await expect(queued).toHaveCount(0);
        const message = JSON.stringify(runs[1]?.messages.at(-1));
        for (const path of paths) expect(message).toContain(path);
        await expect(chips).toHaveCount(0);
        expect(await readStatuses(paths)).toEqual(paths.map(() => 200));
        expect(uploadedRequests).toHaveLength(count);
        expect(deletedPaths).toEqual([]);
        return;
      }

      if (action === "remove") {
        await queued.tap();
        for (let index = 0; index < count; index += 1) {
          const name = `parked-${index}.txt`;
          const notice = browser
            .locator('[role="alert"] p')
            .filter({ hasText: name });
          await expect(notice).toHaveText(
            `${name}: removed with its queued message.`,
          );
        }
        await expect(queued).toHaveCount(0);
      } else {
        await bots.tap();
        await expect(browser).toHaveURL("/bots");
      }

      await expect
        .poll(() => [...deletedPaths].sort())
        .toEqual([...paths].sort());
      await expect
        .poll(() => readStatuses(paths))
        .toEqual(paths.map(() => 404));
      if (action === "remove") {
        paths.push(await upload("overflow.txt"));
        await expect(
          screen.getByRole("button", "Remove overflow.txt"),
        ).toBeVisible();
        await expect(chips).toHaveCount(1);
        await expect(queue).toBeEnabled();
        expect(uploadedRequests).toHaveLength(count + 1);
      }
      expect(runs).toHaveLength(1);
    } finally {
      release.resolve();
      if (paths.length > 0) {
        const statuses = await browser.evaluate(
          (paths) =>
            Promise.all(
              paths.map(
                async (path) =>
                  (await fetch(path, { method: "DELETE" })).status,
              ),
            ),
          paths,
        );
        for (const status of statuses) expect([204, 404]).toContain(status);
      }
    }
  });
}

test("an ordinary send failure restores its unsent attachment without deleting the file", async ({
  app,
  browser,
  screen,
}) => {
  await configureChatStream(browser, opening);
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  const release = Promise.withResolvers<void>();
  const runs: ReturnType<typeof readChatRun>[] = [];
  const deletes: string[] = [];
  await browser.route(chatRunPath, async (route) => {
    runs.push(readChatRun(route.request.postData));
    await release.promise;
    await route.fulfill({ status: 503, body: "upstream unavailable" });
  });
  await browser.route(/\/api\/attachments\/[^/?]+$/, async (route) => {
    if (route.request.method === "DELETE") deletes.push(route.request.url);
    await route.continue();
  });

  try {
    await app.open(`/channel/${channelId}`);
    await expect(screen.getByText(opening, { exact: true })).toBeVisible();
    const editor = screen.getByRole("textbox", "Message");
    const send = screen.getByRole("button", "Send message", { exact: true });
    const chip = screen.getByRole("button", "Remove notes.txt");
    const uploaded = browser.waitForResponse(
      new RegExp(`/api/channels/${RegExp.escape(channelId)}/attachments$`),
    );
    await drop(browser, ["notes.txt"], { expectedEffect: "copy" });
    const response = await uploaded;
    expect(response.status).toBe(201);
    const attachment = await response.json<{ id: string; name: string }>();
    const path = `/api/attachments/${attachment.id}`;
    await expect(chip).toBeVisible();
    await expect(send).toBeEnabled();
    await editor.fill("Keep these notes");
    await send.tap();
    await expect.poll(() => runs.length).toBe(1);
    await expect(chip).toHaveCount(0);
    expect(JSON.stringify(runs[0]?.messages.at(-1))).toContain(path);

    const failed = browser.waitForResponse(chatRunPath);
    release.resolve();
    expect((await failed).status).toBe(503);
    await expect(chip).toBeVisible();
    await expect(editor).toHaveText("Keep these notes");
    await expect(send).toBeEnabled();
    expect(
      await browser.evaluate(
        async (path) => (await fetch(path, { cache: "no-store" })).status,
        path,
      ),
    ).toBe(200);
    expect(deletes).toEqual([]);
    expect(runs).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

test("queuing a correction does not sweep the attachment from a pending send that fails", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  await app.open(`${composerFixture}?channel=${channelId}&run=send`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  const send = screen.getByRole("button", "Send message", { exact: true });
  const queue = screen.getByRole("button", "Queue message", { exact: true });
  const sent = screen.getByRole("status", "Sent drafts");
  const queued = screen.getByRole("status", "Queued drafts");
  const uploadPath = new RegExp(
    `/api/channels/${RegExp.escape(channelId)}/attachments$`,
  );
  const upload = async (name: string) => {
    const response = browser.waitForResponse(uploadPath);
    await drop(browser, [name], { expectedEffect: "copy" });
    const uploaded = await response;
    expect(uploaded.status).toBe(201);
    const attachment = await uploaded.json<{ id: string; name: string }>();
    expect(attachment.name).toBe(name);
    await expect(screen.getByRole("button", `Remove ${name}`)).toBeVisible();
    return attachment.id;
  };

  const notesChip = screen.getByRole("button", "Remove notes.txt");
  const correctionChip = screen.getByRole("button", "Remove correction.txt");
  const notes = await upload("notes.txt");
  await expect(send).toBeEnabled();
  await send.tap();
  await expect(sent).toHaveText(JSON.stringify([[notes]]));
  await expect(notesChip).toHaveCount(0);

  const correction = await upload("correction.txt");
  await expect(queue).toBeEnabled();
  await queue.tap();
  await expect(queued).toHaveText(JSON.stringify([[correction]]));
  await expect(correctionChip).toHaveCount(0);
  await expect(notesChip).toHaveCount(0);

  await screen.getByRole("button", "Fail send", { exact: true }).tap();

  await expect(notesChip).toBeVisible();
  await expect(correctionChip).toHaveCount(0);
  await expect(send).toBeEnabled();
  await expect(sent).toHaveText(JSON.stringify([[notes]]));
  await expect(queued).toHaveText(JSON.stringify([[correction]]));
  const statuses = await browser.evaluate(
    (ids) =>
      Promise.all(
        ids.map(
          async (id) =>
            (await fetch(`/api/attachments/${id}`, { cache: "no-store" }))
              .status,
        ),
      ),
    [notes, correction],
  );
  expect(statuses).toEqual([200, 200]);
});

async function observeUploadGroups(browser: Browser, uploadPath: RegExp) {
  const requests: { name: string; group: string }[] = [];
  await browser.route(uploadPath, async (route) => {
    if (route.request.method === "POST") {
      const body = await readMultipartPost(route.request);
      const file = body.get("file");
      const group = body.get("uploadGroup");
      if (
        !(file instanceof File) ||
        typeof group !== "string" ||
        !group.trim()
      ) {
        throw new Error("Each file upload needs a name and an upload group");
      }
      requests.push({ name: file.name, group });
    }
    await route.continue();
  });
  return requests;
}

test("two drops in the same browser task cannot upload more than the message cap", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  const uploadPath = new RegExp(
    `/api/channels/${RegExp.escape(channelId)}/attachments$`,
  );
  const requests = await observeUploadGroups(browser, uploadPath);
  await app.open(`/channel/${channelId}`);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
  const batchSize = Math.floor(MAX_ATTACHMENTS_PER_MESSAGE / 2) + 1;
  const first = Array.from(
    { length: batchSize },
    (_, index) => `first-${index}.txt`,
  );
  const second = Array.from(
    { length: batchSize },
    (_, index) => `second-${index}.txt`,
  );
  const names = [...first, ...second];
  const accepted = names.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const refused = names.slice(MAX_ATTACHMENTS_PER_MESSAGE);

  await dropBatches(browser, [first, second], { expectedEffect: "copy" });

  const chips = browser.locator(
    '[data-slot="composer"] button[aria-label^="Remove "]',
  );
  await expect(chips).toHaveCount(accepted.length);
  await expect(screen.getByRole("button", "Send message")).toBeEnabled();
  expect(requests.map((request) => request.name)).toEqual(accepted);
  const warnings = browser.locator('[role="alert"] p');
  await expect(warnings).toHaveCount(refused.length);
  for (const name of refused) {
    const warning = warnings.filter({ hasText: name });
    await expect(warning).toContainText(
      `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
    );
    await expect(screen.getByRole("button", `Remove ${name}`)).toHaveCount(0);
  }
  for (const name of accepted) {
    const remove = screen.getByRole("button", `Remove ${name}`, {
      exact: true,
    });
    await expect(remove).toBeVisible();
    const deletion = browser.waitForResponse(/\/api\/attachments\/[^/?]+$/);
    await remove.tap();
    expect((await deletion).status).toBe(204);
  }
  await expect(chips).toHaveCount(0);
});

test("uploads keep one group in the editor and use a new group after reopening the conversation", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  const uploadPath = new RegExp(
    `/api/channels/${RegExp.escape(channelId)}/attachments$`,
  );
  const requests = await observeUploadGroups(browser, uploadPath);
  const attachmentPaths: string[] = [];
  const upload = async (name: string) => {
    const pending = browser.waitForResponse(uploadPath);
    await drop(browser, [name], { expectedEffect: "copy" });
    const response = await pending;
    expect(response.status).toBe(201);
    const attachment = await response.json<{ id: string; name: string }>();
    attachmentPaths.push(`/api/attachments/${attachment.id}`);
    expect(attachment.name).toBe(name);
    await expect(screen.getByRole("button", `Remove ${name}`)).toBeVisible();
    await expect(screen.getByRole("button", "Send message")).toBeEnabled();
  };
  const attach = screen.getByRole("button", "Attach a file");

  try {
    await app.open(`/channel/${channelId}`);
    await expect(attach).toBeEnabled();
    await upload("first.txt");
    await upload("second.txt");
    expect(requests.map((request) => request.name)).toEqual([
      "first.txt",
      "second.txt",
    ]);
    expect(requests[0]?.group).toMatch(/\S/);
    expect(requests[1]?.group).toBe(requests[0]?.group);

    await browser.reload();

    await expect(attach).toBeEnabled();
    await expect(screen.getByRole("button", "Remove first.txt")).toHaveCount(0);
    await upload("third.txt");
    expect(requests.map((request) => request.name)).toEqual([
      "first.txt",
      "second.txt",
      "third.txt",
    ]);
    expect(requests[2]?.group).toMatch(/\S/);
    expect(requests[2]?.group).not.toBe(requests[0]?.group);
  } finally {
    if (attachmentPaths.length > 0) {
      const statuses = await browser.evaluate(
        (paths) =>
          Promise.all(
            paths.map(
              async (path) => (await fetch(path, { method: "DELETE" })).status,
            ),
          ),
        attachmentPaths,
      );
      expect(statuses).toEqual(attachmentPaths.map(() => 204));
    }
  }
});

test("the mounted attachment list enters and leaves the accessibility tree as files are added and removed", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${composerFixture}?strip`);
  const list = screen.getByRole("list", "Attachments", { exact: true });
  const mountedList = browser.locator('ul[aria-label="Attachments"]');
  await expect(mountedList).toHaveCount(1);
  await expect(mountedList).toHaveAttribute("aria-hidden", "true");
  await expect(screen.getByRole("list")).toHaveCount(0);

  await screen.getByRole("button", "Add text files").tap();

  await expect(list).toBeVisible();
  await expect(screen.getByRole("listitem")).toHaveCount(2);
  const notes = screen.getByRole("listitem").filter({ hasText: "notes.txt" });
  const long = screen.getByRole("listitem").filter({ hasText: "long.txt" });
  await expect(notes).not.toContainText("may be cut");
  await expect(long).toContainText("may be cut");

  await screen.getByRole("button", "Remove notes.txt", { exact: true }).tap();
  await expect(screen.getByRole("listitem")).toHaveCount(1);
  await expect(list).toBeVisible();
  await screen.getByRole("button", "Remove long.txt", { exact: true }).tap();

  await expect(mountedList).toHaveCount(1);
  await expect(mountedList).toHaveAttribute("aria-hidden", "true");
  await expect(screen.getByRole("list")).toHaveCount(0);
});

test("a pending image by itself exposes the attachment list and an accessible upload name", async ({
  app,
  screen,
}) => {
  await app.open(`${composerFixture}?strip`);
  const list = screen.getByRole("list", "Attachments", { exact: true });
  await expect(list).toHaveCount(0);

  await screen.getByRole("button", "Add a named image").tap();

  await expect(list).toBeVisible();
  await expect(screen.getByRole("listitem")).toHaveCount(1);
  await expect(
    screen.getByRole("img", "A cat, uploading", { exact: true }),
  ).toBeVisible();

  await screen.getByRole("button", "Add an unnamed image").tap();

  await expect(list).toBeVisible();
  await expect(screen.getByRole("listitem")).toHaveCount(1);
  await expect(
    screen.getByRole("img", "A cat, uploading", { exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("img", "Attachment, uploading", { exact: true }),
  ).toBeVisible();
});

for (const claim of ["", "application/octet-stream"]) {
  test(`a text file with ${claim || "no MIME type"} reaches server detection`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.addInitScript(() => {
      window.fetch = new Proxy(window.fetch, {
        apply(target, receiver, args: Parameters<typeof window.fetch>) {
          const [, init] = args;
          const file =
            init?.body instanceof FormData ? init.body.get("file") : null;
          if (file instanceof File) {
            performance.mark("openbot-e2e-uploaded-file", {
              detail: { name: file.name, type: file.type },
            });
          }
          return Reflect.apply(target, receiver, args);
        },
      });
    });
    await app.open("/");
    const id = await createConversation(browser, "general-assistant");
    await app.open(`/channel/${id}`);
    await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();
    const uploaded = browser.waitForResponse(
      new RegExp(`/api/channels/${RegExp.escape(id)}/attachments$`),
    );
    await drop(
      browser,
      [
        {
          name: "notes.txt",
          type: claim,
          text: "Hello from a plain text file.",
        },
      ],
      { expectedEffect: "copy" },
    );
    const response = await uploaded;
    expect(response.status).toBe(201);
    const attachment = await response.json<{
      id: string;
      name: string;
      mimeType: string;
    }>();
    expect(attachment).toMatchObject({
      name: "notes.txt",
      mimeType: "text/plain",
    });
    const remove = screen.getByRole("button", "Remove notes.txt", {
      exact: true,
    });
    await expect(remove).toBeVisible();
    await expect(screen.getByRole("button", "Send message")).toBeEnabled();
    await expect(screen.getByRole("alert")).toHaveCount(0);
    expect(
      await browser.evaluate(() =>
        performance
          .getEntriesByName("openbot-e2e-uploaded-file")
          .flatMap((entry) =>
            entry instanceof PerformanceMark ? [entry.detail] : [],
          ),
      ),
    ).toEqual([{ name: "notes.txt", type: claim }]);

    const deletion = browser.waitForResponse(
      new RegExp(`/api/attachments/${RegExp.escape(attachment.id)}$`),
    );
    await remove.tap();
    expect((await deletion).status).toBe(204);
  });
}

test("pick, upload, and queue refusals still name files without crypto.randomUUID", async ({
  app,
  browser,
  screen,
}) => {
  await configureChatStream(browser, opening);
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  const release = Promise.withResolvers<void>();
  const runs: ReturnType<typeof readChatRun>[] = [];
  const uploads: string[] = [];
  const uploadPath = new RegExp(
    `/api/channels/${RegExp.escape(channelId)}/attachments$`,
  );
  const refusedByServer = "That file is not allowed here.";
  await browser.route(chatRunPath, async (route) => {
    runs.push(readChatRun(route.request.postData));
    await release.promise;
    await route.abort();
  });
  await browser.route(uploadPath, async (route) => {
    const file = (await readMultipartPost(route.request)).get("file");
    if (!(file instanceof File)) throw new Error("No file sent for upload");
    uploads.push(file.name);
    if (file.name === "denied.txt") {
      await route.fulfill({ status: 415, json: { error: refusedByServer } });
    } else {
      await route.continue();
    }
  });

  try {
    await app.open(`/channel/${channelId}`);
    await expect(screen.getByText(opening, { exact: true })).toBeVisible();
    expect(
      await browser.evaluate(() => {
        Object.defineProperty(crypto, "randomUUID", {
          configurable: true,
          value: undefined,
        });
        return typeof crypto.randomUUID;
      }),
    ).toBe("undefined");
    await screen.getByRole("textbox", "Message").fill("Get started");
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    await expect.poll(() => runs.length).toBe(1);

    const uploaded = browser.waitForResponse(uploadPath);
    await drop(
      browser,
      [
        { name: "logo.svg", type: "image/svg+xml", text: "<svg />" },
        "notes.txt",
      ],
      { expectedEffect: "copy" },
    );
    const response = await uploaded;
    expect(response.status).toBe(201);
    const attachment = await response.json<{ id: string; name: string }>();
    expect(attachment.name).toBe("notes.txt");
    const rows = browser.locator('[role="alert"] p');
    await expect(rows.filter({ hasText: "logo.svg" })).toContainText(
      "SVG files aren't accepted",
    );
    const chip = screen.getByRole("button", "Remove notes.txt", {
      exact: true,
    });
    await expect(chip).toBeVisible();

    const denied = browser.waitForResponse(uploadPath);
    await drop(browser, ["denied.txt"], { expectedEffect: "copy" });
    expect((await denied).status).toBe(415);
    await expect(rows.filter({ hasText: "denied.txt" })).toContainText(
      refusedByServer,
    );
    await expect(screen.getByRole("button", "Remove denied.txt")).toHaveCount(
      0,
    );
    expect(uploads).toEqual(["notes.txt", "denied.txt"]);

    const queue = screen.getByRole("button", "Queue message", { exact: true });
    await expect(queue).toBeEnabled();
    await queue.tap();
    const removeQueued = screen.getByRole("button", /^Remove queued message/);
    await expect(removeQueued).toBeVisible();
    await expect(chip).toHaveCount(0);
    const deletion = browser.waitForResponse(
      new RegExp(`/api/attachments/${RegExp.escape(attachment.id)}$`),
    );
    await removeQueued.tap();
    expect((await deletion).status).toBe(204);
    await expect(removeQueued).toHaveCount(0);
    await expect(rows.filter({ hasText: "notes.txt" })).toHaveText(
      "notes.txt: removed with its queued message.",
    );
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();
    expect(runs).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

test("sending only an attachment shows Thinking until the Bot finishes", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  await configureChatStream(browser, []);
  let sent: unknown;
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId, messages }) => {
      sent = messages.at(-1);
      return [{ type: "RUN_STARTED", runId, threadId }];
    },
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );
  await app.open(`/channel/${channelId}`);
  await expect(
    screen.getByRole("button", "Attach a file", { exact: true }),
  ).toBeEnabled();
  const uploaded = browser.waitForResponse(
    new RegExp(`/api/channels/${RegExp.escape(channelId)}/attachments$`),
  );
  await drop(browser, ["observations.txt"], { expectedEffect: "copy" });
  const response = await uploaded;
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: string }>();
  const send = screen.getByRole("button", "Send message", { exact: true });
  await expect(send).toBeEnabled();
  await send.tap();
  const message = screen.getByRole("region", "Messages", { exact: true });
  const thinking = message.getByText("Thinking", { exact: true });
  await expect(
    message.getByText("observations.txt", { exact: true }),
  ).toBeVisible();
  await expect(thinking).toBeVisible();
  await expect
    .poll(() => JSON.stringify(sent) ?? "")
    .toContain(`/api/attachments/${id}`);

  stream.finish();
  await expect(thinking).toHaveCount(0);
  await expect(
    message.getByText("observations.txt", { exact: true }),
  ).toBeVisible();
});

test("queued screenshots stay in the transcript with their own removal controls", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  await configureChatStream(browser, [
    { id: "queue-history", role: "assistant", content: opening },
  ]);
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId }) => [{ type: "RUN_STARTED", runId, threadId }],
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );
  await app.open(`/channel/${channelId}`);
  await expect(screen.getByText(opening, { exact: true })).toBeVisible();
  const editor = screen.getByRole("textbox", "Message", { exact: true });
  await editor.fill("Start working");
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  const queue = screen.getByRole("button", "Queue message", { exact: true });
  const uploadPath = new RegExp(
    `/api/channels/${RegExp.escape(channelId)}/attachments$`,
  );
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const rows = browser.locator('[data-slot="message"]');
  const screenshot =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=";
  const attachments = [];
  for (const [name, caption] of [
    ["chart.png", ""],
    ["updated-chart.png", "Use this one instead."],
  ]) {
    const uploaded = browser.waitForResponse(uploadPath);
    await drop(browser, [{ name, type: "image/png", base64: screenshot }], {
      expectedEffect: "copy",
    });
    const response = await uploaded;
    expect(response.status).toBe(201);
    const { id } = await response.json<{ id: string }>();
    if (caption) await editor.fill(caption);
    await expect(queue).toBeEnabled();
    await queue.tap();

    const remove = screen.getByRole(
      "button",
      `Remove queued message: ${caption || name}`,
      { exact: true },
    );
    const row = rows.filter({ has: remove });
    await expect(row.getByText("Queued", { exact: true })).toBeVisible();
    const thumbnail = row.getByRole("img", `Attachment: ${name}`, {
      exact: true,
    });
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveAttribute("src", `/api/attachments/${id}`);
    await expect(
      screen.getByRole("button", `Remove ${name}`, { exact: true }),
    ).toHaveCount(0);
    if (caption) {
      await expect(row.getByText(caption, { exact: true })).toBeVisible();
    } else {
      await expect(
        row.filter({
          has: browser.locator('[data-slot="bubble"]'),
        }),
      ).toHaveCount(0);
    }
    attachments.push({ id, remove, thumbnail });
  }

  expect(
    await browser.evaluate(() => {
      const content = document.querySelector(
        '[data-slot="message-scroller-content"]',
      );
      if (!content) throw new Error("Messages scroller content is missing");
      const children = [...content.children];
      const parked = children.findIndex((child) =>
        child.querySelector(
          'button[aria-label="Remove queued message: chart.png"]',
        ),
      );
      const firstMessage = children.findIndex((child) =>
        child.hasAttribute("data-message-id"),
      );
      return parked >= 0 && firstMessage > parked;
    }),
  ).toBe(true);

  for (const { id, remove, thumbnail } of attachments) {
    const deletion = browser.waitForResponse(
      new RegExp(`/api/attachments/${RegExp.escape(id)}$`),
    );
    await remove.tap();
    expect((await deletion).status).toBe(204);
    await expect(remove).toHaveCount(0);
    await expect(thumbnail).toHaveCount(0);
  }
  await expect(transcript.getByText("Queued", { exact: true })).toHaveCount(0);
  stream.finish();
  await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
});

test("queued files follow the uploaded media type and only document cards probe the server", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  await configureChatStream(browser, [
    { id: "queue-type-history", role: "assistant", content: opening },
  ]);
  using stream = await stageChatRun(
    browser,
    ({ runId, threadId }) => [{ type: "RUN_STARTED", runId, threadId }],
    ({ runId, threadId }) => [{ type: "RUN_FINISHED", runId, threadId }],
  );

  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=";
  const uploadPath = new RegExp(
    `/api/channels/${RegExp.escape(channelId)}/attachments$`,
  );
  const files = [
    { name: "unknown.bin", type: "application/octet-stream", base64: png },
    { name: "notes.png", type: "image/png", text: "Text carried as an image" },
    { name: "photo.png", type: "image/png", text: "Unsupported image fixture" },
    { name: "legacy.png", type: "image/png", base64: png },
  ];
  const uploadFixtures: Record<string, { id: string; mimeType: string }> = {
    "notes.png": { id: "fixture-queued-text", mimeType: "text/plain" },
    "photo.png": { id: "fixture-queued-heic", mimeType: "image/heic" },
    "legacy.png": { id: "fixture-queued-legacy", mimeType: "" },
  };
  const uploadedIds = new Map<string, string>();
  const requests: { id: string; method: string }[] = [];
  await browser.route(uploadPath, async (route) => {
    const file = (await readMultipartPost(route.request)).get("file");
    if (!(file instanceof File))
      throw new Error("No attachment upload was sent");
    const fixture = uploadFixtures[file.name];
    if (!fixture) {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 201, json: { ...fixture, name: file.name } });
  });
  await browser.route(/\/api\/attachments\/[^/]+$/, (route) => {
    const id = new URL(route.request.url).pathname.split("/").at(-1) ?? "";
    const { method } = route.request;
    requests.push({ id, method });
    if (!id.startsWith("fixture-queued-")) return route.continue();
    if (id === "fixture-queued-legacy" && method === "GET") {
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(png, "base64"),
      });
    }
    return route.fulfill({ status: 200 });
  });

  await app.open(`/channel/${channelId}`);
  await expect(screen.getByText(opening, { exact: true })).toBeVisible();
  const editor = screen.getByRole("textbox", "Message", { exact: true });
  await editor.fill("Start working");
  await screen.getByRole("button", "Send message", { exact: true }).tap();
  const queue = screen.getByRole("button", "Queue message", { exact: true });
  for (const file of files) {
    const uploaded = browser.waitForResponse(uploadPath);
    await drop(browser, [file], { expectedEffect: "copy" });
    const response = await uploaded;
    expect(response.status).toBe(201);
    const { id, name, mimeType } = await response.json<{
      id: string;
      name: string;
      mimeType: string;
    }>();
    expect(name).toBe(file.name);
    expect(mimeType).toBe(uploadFixtures[name]?.mimeType ?? "image/png");
    uploadedIds.set(name, id);
  }
  const caption = "Check these four files.";
  await editor.fill(caption);
  await expect(queue).toBeEnabled();
  requests.length = 0;
  await queue.tap();
  const remove = screen.getByRole(
    "button",
    `Remove queued message: ${caption}`,
    { exact: true },
  );
  const row = browser.locator('[data-slot="message"]').filter({ has: remove });
  await expect(row.getByText("Queued", { exact: true })).toBeVisible();
  for (const name of ["unknown.bin", "legacy.png"]) {
    const thumbnail = row.getByRole("img", `Attachment: ${name}`, {
      exact: true,
    });
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveAttribute(
      "src",
      `/api/attachments/${uploadedIds.get(name)}`,
    );
  }
  for (const name of ["notes.png", "photo.png"]) {
    await expect(row.getByText(name, { exact: true })).toBeVisible();
    await expect(
      row.getByRole("img", `Attachment: ${name}`, { exact: true }),
    ).toHaveCount(0);
  }
  await expect(row.getByText("Attachment", { exact: true })).toHaveCount(2);
  const expectedHeads = ["fixture-queued-heic", "fixture-queued-text"];
  await expect
    .poll(() =>
      requests
        .filter(({ method }) => method === "HEAD")
        .map(({ id }) => id)
        .sort(),
    )
    .toEqual(expectedHeads);
  await expect(row).not.toContainText("unavailable");
  await remove.tap();
  await expect(row).toHaveCount(0);
  stream.finish();
  await expect(browser.locator('[data-testid="composer-stop"]')).toBeHidden();
});

test("queued attachment notices distinguish merges, removal, and pick-time refusal", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const channelId = await createConversation(browser, "general-assistant");
  await app.open(`${composerFixture}?channel=${channelId}&dropped`);
  const warning = screen.getByRole("alert");
  const lines = browser.locator('[role="alert"] p');
  const merge = screen.getByRole("button", "Report merged files", {
    exact: true,
  });
  await expect(warning).toHaveCount(0);
  await expect(screen.getByRole("button", "Attach a file")).toBeEnabled();

  await merge.tap();

  await expect(lines).toHaveCount(2);
  const mergeReason = `dropped when your queued messages were merged. A message can take at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`;
  await expect(lines.first()).toHaveText(`invoice.pdf: ${mergeReason}`);
  await expect(lines.last()).toHaveText(`receipt.png: ${mergeReason}`);

  await drop(
    browser,
    [{ name: "logo.svg", type: "image/svg+xml", text: "<svg />" }],
    { expectedEffect: "copy" },
  );
  await expect(lines).toHaveCount(3);
  await expect(lines.last()).toHaveText(
    "logo.svg: 'logo.svg' can't be attached. SVG files aren't accepted.",
  );
  await expect(lines.first()).toHaveText(`invoice.pdf: ${mergeReason}`);

  await screen
    .getByRole("button", "Report removed file", { exact: true })
    .tap();

  await expect(lines).toHaveCount(4);
  await expect(lines.last()).toHaveText(
    "invoice.pdf: removed with its queued message.",
  );
  await expect(lines.first()).toHaveText(`invoice.pdf: ${mergeReason}`);
});

test("a newly reported drop with equal files appends notices after an unrelated rerender", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${composerFixture}?dropped`);
  const lines = browser.locator('[role="alert"] p');
  const merge = screen.getByRole("button", "Report merged files", {
    exact: true,
  });
  await merge.tap();
  await expect(lines).toHaveCount(2);

  await screen.getByRole("button", "Refresh composer", { exact: true }).tap();

  await expect(screen.getByRole("status", "Composer revision")).toHaveText("1");
  await expect(lines).toHaveCount(2);

  await merge.tap();

  await expect(lines).toHaveCount(4);
  await expect(lines.filter({ hasText: "invoice.pdf" })).toHaveCount(2);
  await expect(lines.filter({ hasText: "receipt.png" })).toHaveCount(2);
});

test("a queued attachment with no filename uses the default name in its notice", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(`${composerFixture}?dropped`);
  await screen
    .getByRole("button", "Report unnamed file", { exact: true })
    .tap();
  const lines = browser.locator('[role="alert"] p');
  await expect(lines).toHaveCount(1);
  await expect(lines.first()).toHaveText(
    /^Attachment: dropped when your queued messages were merged\./,
  );
});

test("a new conversation saves its selected model and effort before the first run", async ({
  app,
  browser,
  screen,
}) => {
  await configureChatStream(browser, opening);
  const selectedModel = { model: "gpt-6.1-terra", effort: "xhigh" };
  const catalogue = {
    provider: "openai",
    source: "openai",
    exposure: "all",
    default: "gpt-5.5",
    choosable: true,
    models: [
      {
        id: selectedModel.model,
        label: "GPT-6.1 Terra",
        vendor: "openai",
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
      },
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        vendor: "openai",
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
    ],
  };
  const trace: string[] = [];
  const releaseSave = Promise.withResolvers<void>();
  const saves: { path: string; pick: unknown }[] = [];
  const runs: ReturnType<typeof readChatRun>[] = [];
  let saved: { model: string | null; effort: string | null } = {
    model: null,
    effort: null,
  };
  await browser.route(/\/api\/models$/, async (route) => {
    await route.fulfill({ json: catalogue });
  });
  await browser.route(/\/api\/channels$/, async (route) => {
    if (route.request.method === "POST") trace.push("create");
    await route.continue();
  });
  await browser.route(/\/api\/channels\/[^/]+\/model$/, async (route) => {
    if (route.request.method === "PUT") {
      trace.push("save");
      saves.push({
        path: new URL(route.request.url).pathname,
        pick: JSON.parse(route.request.postData ?? "null"),
      });
      await releaseSave.promise;
      saved = selectedModel;
    }
    await route.fulfill({ json: saved });
  });
  await browser.route(chatRunPath, async (route) => {
    trace.push("run");
    const run = readChatRun(route.request.postData);
    runs.push(run);
    const ids = { threadId: run.threadId, runId: run.runId };
    const messageId = "fixture-model-reply";
    const events = [
      { type: "RUN_STARTED", ...ids },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "Fixed model reply." },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", ...ids },
    ];
    await route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });

  try {
    await app.open(route);
    const dialog = screen.getByRole("dialog");
    await screen
      .getByRole("combobox", "Model: GPT-5.5, thinking: Medium", {
        exact: true,
      })
      .tap();
    await dialog.getByRole("option", "GPT-6.1 Terra", { exact: true }).tap();
    await expect(
      screen.getByRole("combobox", "Model: GPT-6.1 Terra, thinking: Medium", {
        exact: true,
      }),
    ).toBeVisible();
    await dialog.getByRole("option", "Extra high", { exact: true }).tap();
    const trigger = screen.getByRole(
      "combobox",
      "Model: GPT-6.1 Terra, thinking: Extra high",
      { exact: true },
    );
    await expect(trigger).toBeVisible();
    expect(trace).toEqual([]);

    const message = "Summarise the quarter.";
    const editor = screen.getByRole("textbox", "Message");
    await editor.fill(message);
    await editor.press("Enter");

    await expect.poll(() => trace).toEqual(["create", "save"]);
    expect(saves[0]?.pick).toEqual(selectedModel);
    expect(runs).toHaveLength(0);
    releaseSave.resolve();
    await expect.poll(() => trace).toEqual(["create", "save", "run"]);
    expect(JSON.stringify(runs[0]?.messages.at(-1))).toContain(message);
    const path = saves[0]?.path;
    if (!path) throw new Error("The conversation's model was not saved");
    await expect(browser).toHaveURL(
      path.replace(/^\/api\/channels(\/[^/]+)\/model$/, "/channel$1"),
    );
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(
      transcript.getByText("Fixed model reply.", { exact: true }),
    ).toBeVisible();
    await expect(transcript.getByText(message, { exact: true })).toBeVisible();
    await expect(trigger).toBeVisible();
  } finally {
    releaseSave.resolve();
  }
});
