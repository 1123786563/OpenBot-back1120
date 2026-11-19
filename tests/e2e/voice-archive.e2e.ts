import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";

const message = "Will my voice chats show up here?";
const summary = "We agreed to check the shipment on Friday.";
const history = [{ id: "u1", role: "user", content: message }];

for (const status of [200, 500]) {
  test(`conversation waits for its voice archive and becomes readable after HTTP ${status}`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    await app.open("/");
    const channel = await createConversation(browser, "general-assistant");
    await configureChatStream(browser, history, async () => history);
    const release = Promise.withResolvers<void>();
    const requestedChannels = new Set<string | null>();
    await browser.route(/\/api\/voice\/sessions\?/, async (route) => {
      requestedChannels.add(
        new URL(route.request.url).searchParams.get("channelId"),
      );
      await release.promise;
      return route.fulfill({
        status,
        json:
          status === 500
            ? { error: "Down for maintenance." }
            : {
                sessions: [
                  {
                    id: "shipment-call",
                    channelId: channel,
                    anchorMessageId: "u1",
                    startedAt: "2026-11-10T11:00:00Z",
                    endedAt: "2026-11-10T11:01:00Z",
                    durationSeconds: 60,
                    transcript: [
                      {
                        id: "call-word",
                        role: "user",
                        text: "Check the shipment Friday.",
                      },
                    ],
                    summary,
                    summaryStatus: "ready",
                  },
                ],
                nextCursor: null,
              },
      });
    });
    const loading = screen.getByRole("status", "Loading this conversation", {
      exact: true,
    });
    const question = screen.getByText(message, { exact: true });
    try {
      await app.open(`/channel/${channel}`);
      await expect.poll(() => requestedChannels.has(channel)).toBe(true);
      await expect(loading).toBeVisible();
      await expect(question).toHaveCount(0);
    } finally {
      release.resolve();
    }
    await expect(loading).toHaveCount(0);
    await expect(question).toBeVisible();
    const problem = screen
      .getByRole("alert")
      .filter({ hasText: "Couldn’t load voice chats. Reload the page." });
    if (status === 500) {
      await expect(problem).toBeVisible();
      await expect(screen.getByText(summary, { exact: true })).toHaveCount(0);
    } else {
      await expect(problem).toHaveCount(0);
      await expect(screen.getByText(summary, { exact: true })).toBeVisible();
      const entry = browser.locator(
        '[data-message-id="voice-chat:shipment-call"]',
      );
      await entry.getByText("Voice chat", { exact: true }).click();
      await expect(
        entry.getByText("Check the shipment Friday.", { exact: true }),
      ).toBeVisible();
    }
    expect(requestedChannels).toEqual(new Set([channel]));
  });
}
