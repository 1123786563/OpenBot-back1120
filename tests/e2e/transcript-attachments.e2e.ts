import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const imagePath = "/api/attachments/transcript-image";
const documentPath = "/api/attachments/transcript-document";
const outsideUrl = "https://transcript-fixture.example.test/outside.pdf";
const outsideImageUrl = "https://transcript-fixture.example.test/outside.png";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
  "base64",
);

function attachment(
  type: "image" | "document",
  value: string,
  filename?: string,
) {
  return {
    type,
    source: { type: "url", value },
    metadata: { attachmentId: value, filename },
  };
}

test("an attachment-only message has a thumbnail that opens and closes a full picture", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const imageRequests: string[] = [];
  await browser.route(/\/api\/attachments\/transcript-image$/, (route) => {
    imageRequests.push(route.request.method);
    return route.fulfill({ contentType: "image/png", body: png });
  });
  await configureChatStream(browser, [
    {
      id: "picture-message",
      role: "user",
      content: [attachment("image", imagePath, "screenshot.png")],
    },
  ]);
  await app.open(`/channel/${channel}`);
  const message = screen.getByRole("region", "Messages", { exact: true });
  const open = message.getByRole("button", "Open screenshot.png", {
    exact: true,
  });
  const thumbnail = open.getByRole("img", "Attachment: screenshot.png", {
    exact: true,
  });
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail).toHaveAttribute("src", imagePath);
  await expect(open).toHaveAttribute("aria-haspopup", "dialog");
  const dialog = screen.getByRole("dialog", "screenshot.png", { exact: true });
  await expect(dialog).toBeHidden();
  expect(
    await browser.evaluate(() => {
      const image = document.querySelector(
        'img[alt="Attachment: screenshot.png"]',
      );
      return image ? getComputedStyle(image).objectFit : null;
    }),
  ).toBe("cover");
  await open.tap();
  const picture = dialog.getByRole("img", "screenshot.png", { exact: true });
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute("src", imagePath);
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const image = document.querySelector<HTMLImageElement>(
          'img[alt="screenshot.png"]',
        );
        return image
          ? {
              objectFit: getComputedStyle(image).objectFit,
              loaded: image.naturalWidth > 0,
            }
          : null;
      }),
    )
    .toEqual({ objectFit: "contain", loaded: true });
  const close = dialog.getByRole("button", "Close", { exact: true });
  await close.press("Escape");
  await expect(dialog).toBeHidden();
  await open.tap();
  await expect(picture).toBeVisible();
  await close.tap();
  await expect(dialog).toBeHidden();
  expect(imageRequests.length).toBeGreaterThan(0);
  expect([...new Set(imageRequests)]).toEqual(["GET"]);
});

test("a missing document is checked with HEAD and an off-site file makes no request", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const requests: string[] = [];
  await browser.route(/\/api\/attachments\/transcript-document$/, (route) => {
    requests.push(route.request.method);
    return route.fulfill({ status: 404 });
  });
  await browser.route(
    /^https:\/\/transcript-fixture\.example\.test\//,
    (route) => {
      requests.push("external");
      return route.abort();
    },
  );
  await configureChatStream(browser, [
    {
      id: "documents-message",
      role: "user",
      content: [
        attachment("document", documentPath, "report.pdf"),
        attachment("document", outsideUrl, "outside.pdf"),
        attachment("image", outsideImageUrl, "outside.png"),
      ],
    },
  ]);
  await app.open(`/channel/${channel}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    transcript.getByText("report.pdf is unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("outside.pdf is unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("outside.png is unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(browser.locator('[role="note"]')).toHaveCount(3);
  await expect(transcript.getByText("Attachment", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    transcript.getByRole("img", "Attachment: outside.png"),
  ).toHaveCount(0);
  await expect(transcript.getByRole("alert")).toHaveCount(0);
  expect(requests).toEqual(["HEAD"]);
});

test("a broken thumbnail becomes an unavailable attachment note", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const requests: string[] = [];
  await browser.route(/\/api\/attachments\/transcript-image$/, (route) => {
    requests.push(route.request.method);
    return route.fulfill({ status: 404 });
  });
  await configureChatStream(browser, [
    {
      id: "missing-picture-message",
      role: "user",
      content: [attachment("image", imagePath, "deleted.png")],
    },
  ]);
  await app.open(`/channel/${channel}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(browser.locator('[role="note"]')).toHaveText(
    "deleted.png is unavailable.",
  );
  await expect(
    transcript.getByRole("img", "Attachment: deleted.png", { exact: true }),
  ).toHaveCount(0);
  await expect(
    transcript.getByRole("button", "Open deleted.png", { exact: true }),
  ).toHaveCount(0);
  expect(requests).toEqual(["GET"]);
});

test("both cards for the same document share a pending probe and a reload checks again", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const firstProbe = Promise.withResolvers<void>();
  const requests: string[] = [];
  const probePath = /\/api\/attachments\/transcript-document$/;
  let status = 404;
  await browser.route(probePath, async (route) => {
    requests.push(route.request.method);
    await firstProbe.promise;
    await route.fulfill({ status, headers: { "cache-control": "no-store" } });
  });
  await configureChatStream(browser, [
    {
      id: "repeated-document",
      role: "user",
      content: [
        attachment("document", documentPath, "report.pdf"),
        attachment("document", documentPath, "report.pdf"),
      ],
    },
  ]);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const documents = transcript.getByText("report.pdf", { exact: true });
  const missing = transcript.getByText("report.pdf is unavailable.", {
    exact: true,
  });
  try {
    await app.open(`/channel/${channel}`);
    await expect(documents).toHaveCount(2);
    await expect.poll(() => requests.length).toBe(1);
    await expect(missing).toHaveCount(0);
    firstProbe.resolve();
    await expect(missing).toHaveCount(2);
    await expect(documents).toHaveCount(0);
    expect(requests).toEqual(["HEAD"]);

    status = 200;
    const response = browser.waitForResponse(probePath);
    await browser.reload();
    expect((await response).status).toBe(200);
    await expect(documents).toHaveCount(2);
    await expect(missing).toHaveCount(0);
    expect(requests).toEqual(["HEAD", "HEAD"]);
  } finally {
    firstProbe.resolve();
  }
});

test("transient document probe failures keep the cards and unnamed attachments retain labels", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const statuses = [200, 304, 401, 403, 500, 503] as const;
  const probes: Record<string, string> = {};
  const paths = statuses.map((status) => `/api/attachments/probe-${status}`);
  const offlinePath = "/api/attachments/probe-offline";
  await browser.route(
    /\/api\/attachments\/probe-(?:\d+|offline)$/,
    async (route) => {
      const path = new URL(route.request.url).pathname;
      probes[path] = route.request.method;
      if (path === offlinePath) {
        await route.abort();
      } else {
        await route.fulfill({
          status: Number(path.split("-").at(-1)),
          headers: { "cache-control": "no-store" },
        });
      }
    },
  );
  await configureChatStream(browser, [
    {
      id: "probe-statuses",
      role: "user",
      content: [
        ...paths.map((path, index) =>
          attachment(
            "document",
            path,
            index === 0 ? undefined : `report-${statuses[index]}.pdf`,
          ),
        ),
        attachment("document", offlinePath, "offline.pdf"),
        attachment("image", outsideImageUrl),
      ],
    },
  ]);
  const responses = paths.map((path) =>
    browser.waitForResponse(new RegExp(`${path}$`)),
  );
  await app.open(`/channel/${channel}`);
  expect((await Promise.all(responses)).map(({ status }) => status)).toEqual([
    ...statuses,
  ]);
  await expect.poll(() => Object.keys(probes).length).toBe(paths.length + 1);
  expect(probes).toEqual(
    Object.fromEntries([...paths, offlinePath].map((path) => [path, "HEAD"])),
  );

  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    transcript.getByText("Untitled file", { exact: true }),
  ).toBeVisible();
  for (const status of statuses.slice(1)) {
    await expect(
      transcript.getByText(`report-${status}.pdf`, { exact: true }),
    ).toBeVisible();
  }
  await expect(
    transcript.getByText("offline.pdf", { exact: true }),
  ).toBeVisible();
  await expect(transcript.getByText("Attachment", { exact: true })).toHaveCount(
    7,
  );
  await expect(browser.locator('[role="note"]')).toHaveText(
    "This attachment is unavailable.",
  );
});

test("each attachment turn has one scroll anchor on its file list", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  await browser.route(/\/api\/attachments\/transcript-image$/, (route) =>
    route.fulfill({ contentType: "image/png", body: png }),
  );
  await configureChatStream(browser, [
    {
      id: "only-image",
      role: "user",
      content: [attachment("image", imagePath, "single.png")],
    },
    {
      id: "two-images",
      role: "user",
      content: [
        attachment("image", imagePath, "left.png"),
        attachment("image", imagePath, "right.png"),
      ],
    },
    {
      id: "captioned-image",
      role: "user",
      content: [
        { type: "text", text: "Does this look right?" },
        attachment("image", imagePath, "captioned.png"),
      ],
    },
    {
      id: "plain-message",
      role: "user",
      content: "When does the offer expire?",
    },
  ]);
  await app.open(`/channel/${channel}`);
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    transcript.getByText("Does this look right?", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("When does the offer expire?", { exact: true }),
  ).toBeVisible();
  const lists = transcript.getByRole("list");
  await expect(lists).toHaveCount(3);
  const pair = lists.filter({
    has: screen.getByRole("button", "Open left.png", { exact: true }),
  });
  await expect(pair.getByRole("listitem")).toHaveCount(2);
  await expect(
    pair.getByRole("button", "Open right.png", { exact: true }),
  ).toBeVisible();
  expect(
    await browser.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          '[data-slot="message-scroller-content"] [data-scroll-anchor="true"]',
        ),
        (row) => row.getAttribute("data-message-id"),
      ),
    ),
  ).toEqual([
    "only-image:attachments",
    "two-images:attachments",
    "captioned-image:attachments",
    "plain-message",
  ]);
});

for (const filename of ["photo.png", undefined]) {
  test(`the full-size viewer reports an unavailable ${filename ? "named" : "unnamed"} picture`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(browser, bot.id);
    await browser.route(/\/api\/attachments\/transcript-image$/, (route) =>
      route.fulfill({
        contentType: "image/png",
        body: png,
        headers: { "cache-control": "no-store" },
      }),
    );
    const reloadPath = `${imagePath}?preview=missing`;
    await browser.route(
      /\/api\/attachments\/transcript-image\?preview=missing$/,
      (route) => route.fulfill({ status: 404 }),
    );
    await configureChatStream(browser, [
      {
        id: "viewer-image",
        role: "user",
        content: [attachment("image", imagePath, filename)],
      },
    ]);
    await app.open(`/channel/${channel}`);
    const label = filename ?? "Attachment";
    const open = screen.getByRole("button", `Open ${label}`, { exact: true });
    await expect(open).toBeVisible();
    await open.tap();
    const viewer = screen.getByRole("dialog", label, { exact: true });
    await expect(viewer.getByRole("img", label, { exact: true })).toBeVisible();

    // Force a fresh read for the popup so Chromium cannot reuse the thumbnail bytes.
    const missingRequest = browser.waitForResponse(
      /\/api\/attachments\/transcript-image\?preview=missing$/,
    );
    await browser.evaluate((url) => {
      const image = document.querySelector<HTMLImageElement>(
        '[role="dialog"] img',
      );
      if (!image) throw new Error("Full-size picture is missing");
      image.src = url;
      return null;
    }, reloadPath);
    expect((await missingRequest).status).toBe(404);
    const note = browser.locator('[role="dialog"] [role="note"]');
    await expect(note).toHaveText(
      filename
        ? `${filename} is unavailable.`
        : "This attachment is unavailable.",
    );
    await expect(viewer.getByRole("img", label, { exact: true })).toHaveCount(
      0,
    );
    await expect(viewer.getByRole("alert")).toHaveCount(0);
    await viewer.getByRole("button", "Close", { exact: true }).tap();
    await expect(viewer).toBeHidden();
    await expect(open.getByRole("img")).toBeVisible();
  });
}
