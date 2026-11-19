import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { NOT_SHOWN, NOT_SHOWN_TAIL } from "../../shared/component-markers";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";
import { stageChatRun } from "./staged-chat-stream";

const refusal = "It can't read the data it needs.";
const confirmation =
  "The report is on screen for the person, filled with figures read from this deployment. You were not given the figures.";

for (const scenario of [
  { name: "allowed report", report: "activity", allowed: true },
  { name: "refused report", report: "activity", allowed: false },
  { name: "recent refusals report", report: "refusals", allowed: true },
]) {
  test(`the ${scenario.name} reads only after the call is finalized`, async (fixtures) => {
    const { app, browser, screen } = fixtures;
    const bot = await createBot(fixtures);
    const channel = await createConversation(browser, bot.id);
    await configureChatStream(browser);
    await browser.route(/\/api\/components\/for-agent\/[^/?]+$/, (route) =>
      route.fulfill({
        json: {
          components: [
            {
              name: "showActivityReport",
              description: "Show an Activity report",
            },
          ],
        },
      }),
    );
    const reads: unknown[] = [];
    await browser.route(
      /\/api\/components\/showActivityReport\/call$/,
      (route) => {
        expect(route.request.method).toBe("POST");
        reads.push(JSON.parse(route.request.postData ?? "null"));
        const data =
          scenario.report === "refusals"
            ? {
                rows: [
                  {
                    at: "2026-11-07T19:00:00Z",
                    bot: bot.id,
                    what: "computer.action_refused",
                    reason: "Local computer access is off for you.",
                  },
                ],
              }
            : { days: 7, rows: [{ bot: bot.id, actions: 42 }] };
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ allowed: true, data }),
        });
      },
    );

    const toolCallId = "fixture-activity-report";
    using stream = await stageChatRun(
      browser,
      ({ threadId, runId }) => [
        { type: "RUN_STARTED", threadId, runId },
        {
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: "showActivityReport",
          parentMessageId: "fixture-report-step",
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId,
          delta: `{"report":"${scenario.report}"`,
        },
      ],
      ({ threadId, runId }) => [
        { type: "TOOL_CALL_ARGS", toolCallId, delta: ',"days":7}' },
        { type: "TOOL_CALL_END", toolCallId },
        {
          type: "TOOL_CALL_RESULT",
          messageId: "fixture-report-result",
          toolCallId,
          role: "tool",
          content: scenario.allowed
            ? confirmation
            : `${NOT_SHOWN}Activity report. ${refusal}${NOT_SHOWN_TAIL}`,
        },
        { type: "RUN_FINISHED", threadId, runId },
      ],
    );
    await app.open(`/channel/${channel}`);
    await screen
      .getByRole("textbox", "Message", { exact: true })
      .fill("Show an Activity report for the last seven days.");
    await screen.getByRole("button", "Send message", { exact: true }).tap();
    const transcript = screen.getByRole("region", "Messages", {
      exact: true,
    });
    await expect(
      transcript.getByText("Reading…", { exact: true }),
    ).toBeVisible();
    expect(reads).toEqual([]);
    stream.finish();
    if (!scenario.allowed) {
      await expect(
        transcript.getByText(refusal, { exact: true }),
      ).toBeVisible();
      expect(reads).toEqual([]);
      return;
    }
    await expect(transcript.getByText(bot.name, { exact: true })).toBeVisible();
    if (scenario.report === "activity") {
      await expect(transcript.getByText("42", { exact: true })).toBeVisible();
    } else {
      await expect(
        transcript.getByText("Use the computer", { exact: true }),
      ).toBeVisible();
      await expect(
        transcript.getByText("Local computer access is off for you.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(transcript).not.toContainText("computer.action_refused");
    }
    await expect(transcript).not.toContainText(bot.id);
    expect(reads).toEqual([
      {
        agentId: bot.id,
        args: { days: 7 },
        function:
          scenario.report === "activity" ? "botActivity" : "recentRefusals",
      },
    ]);
  });
}
