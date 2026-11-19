import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { OFFER_CHECK_IN_TOOL } from "../../shared/check-in-offer";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";

const bot = "general-assistant";
const subject = "Launch brief in Notion";
const link = "https://www.notion.so/launch-brief";
const question = "Read the launch brief.";
const toolCallId = "offer-brief";

for (const { state, title } of [
  {
    state: "accept",
    title: "a check-in offer creates a daily check-in only after confirmation",
  },
  {
    state: "decline",
    title: "declining a check-in offer persists after reload",
  },
  {
    state: "already-on",
    title: "a check-in offer reports when the Bot already watches that page",
  },
  {
    state: "restricted",
    title:
      "the transcript hides check-in offers when the admin disables check-ins",
  },
]) {
  test(title, async ({ app, browser, screen }) => {
    await app.open("/");
    const channelId = await createConversation(browser, bot);
    const setting = {
      id: "existing-watch",
      agentId: bot,
      channelId,
      focus: "",
      subject,
      sourceLink: link,
      enabled: true,
      intervalMinutes: 1440,
    };
    let active = state === "already-on";
    let reads = 0;
    const writes: unknown[] = [];
    await browser.route(/\/api\/proactive\/settings$/, (route) => {
      if (route.request.method === "POST") {
        active = true;
        writes.push(JSON.parse(route.request.postData ?? "null"));
        return route.fulfill({ status: 201, json: { setting } });
      }
      reads++;
      return route.fulfill({
        json: {
          settings: active ? [setting] : [],
          allowed: state !== "restricted",
        },
      });
    });
    const messages = [
      { id: "question", role: "user", content: question },
      {
        id: "answer",
        role: "assistant",
        content: "I found the launch brief.",
        toolCalls: [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: OFFER_CHECK_IN_TOOL,
              arguments: JSON.stringify({ subject, link }),
            },
          },
        ],
      },
      {
        id: "offered",
        role: "tool",
        toolCallId,
        content: "Offered a check-in.",
      },
    ];
    await configureChatStream(browser, messages, async () => messages);
    const url = `/channel/${channelId}`;
    await app.open(url);
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(screen.getByText(question, { exact: true })).toBeVisible();
    const turnOn = screen.getByRole("button", "Turn on", { exact: true });
    const offer = screen.getByText(`Keep an eye on ${subject}?`, {
      exact: true,
    });
    const watching = screen.getByText(
      /checks Launch brief in Notion once a day/,
    );
    expect(writes).toEqual([]);
    switch (state) {
      case "accept":
        await expect(offer).toBeVisible();
        await turnOn.click();
        await expect(watching).toBeVisible();
        expect(writes).toEqual([
          {
            agentId: bot,
            channelId,
            subject,
            focus: "",
            sourceLink: link,
            intervalMinutes: 1440,
          },
        ]);
        break;
      case "decline": {
        await expect(offer).toBeVisible();
        await screen.getByRole("button", "Not now", { exact: true }).click();
        const declined = screen.getByText(
          /No check-in on Launch brief in Notion/,
        );
        await expect(declined).toBeVisible();
        await app.open(url);
        await expect(declined).toBeVisible();
        expect(writes).toEqual([]);
        break;
      }
      case "already-on":
        await expect(watching).toBeVisible();
        await expect(turnOn).toHaveCount(0);
        expect(writes).toEqual([]);
        break;
      case "restricted":
        await expect(offer).toHaveCount(0);
        await expect(turnOn).toHaveCount(0);
        expect(writes).toEqual([]);
        break;
    }
  });
}
