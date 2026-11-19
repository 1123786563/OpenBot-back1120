import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const bot = "general-assistant";
const profile = `/bots/${bot}/${process.env.OPENBOT_E2E_SUITE === "personal" ? "access" : "memory"}`;
const focus =
  "Read the product announcements and summarize any changes that affect the release schedule. Include version numbers and next steps for the team.";
const skipped = "Nothing to check: connect an app this Bot can read.";
const timestamp = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();
function run(outcome: "skipped" | "raised", minutesAgo: number) {
  const time = timestamp(-minutesAgo);
  return {
    outcome,
    trigger: "schedule",
    skipReason: outcome === "skipped" ? "no_sources" : null,
    why: outcome === "skipped" ? skipped : null,
    itemsRaised: outcome === "raised" ? 2 : 0,
    startedAt: time,
    finishedAt: time,
  };
}

for (const scenario of [
  "previously skipped",
  "skipped immediately",
  "queued",
  "no check-in",
]) {
  test(`the Bot Check-ins page presents a ${scenario} state`, async ({
    app,
    browser,
    screen,
  }) => {
    const channel = (
      id: string,
      summary: string,
      task: boolean,
      agentId = bot,
    ) => ({
      id,
      name: "Personal Assistant",
      agentIds: [agentId],
      threadId: `thread-${id}`,
      active: true,
      lastMessageAt: timestamp(-60),
      summary,
      lastMessage: null,
      lastMessageAgentId: null,
      createdAt: timestamp(-120),
      pinned: false,
      lastReadAt: null,
      task,
    });
    await browser.route(/\/api\/channels(?:\?|$)/, (route) =>
      route.fulfill({
        json: {
          channels: [
            channel("updates", "Release reports", false),
            channel("task", "Task reports", true),
            channel("another", "Another Bot's report", false, "another-bot"),
          ],
          nextCursor: null,
        },
      }),
    );
    let lastRun =
      scenario === "previously skipped"
        ? run("skipped", 5)
        : scenario === "queued"
          ? run("raised", 120)
          : null;
    await browser.route(/\/api\/proactive\/settings$/, (route) =>
      route.fulfill({
        json: {
          settings:
            scenario === "no check-in"
              ? []
              : [
                  {
                    id: "check-1",
                    agentId: bot,
                    channelId: "updates",
                    threadId: "thread-updates",
                    focus,
                    enabled: true,
                    intervalMinutes: 60,
                    nextRunAt: timestamp(45),
                    lastRunAt: lastRun?.startedAt ?? null,
                    lastStatus: "idle",
                    lastError: null,
                    lastRun,
                  },
                ],
          allowed: true,
        },
      }),
    );
    const runs: string[] = [];
    await browser.route(
      /\/api\/proactive\/settings\/check-1\/run$/,
      (route) => {
        runs.push(route.request.method);
        if (scenario === "skipped immediately") {
          lastRun = run("skipped", 0);
          return route.fulfill({
            json: { queued: false, skipped: "no_sources", why: skipped },
          });
        }
        return route.fulfill({ json: { queued: true } });
      },
    );
    await app.open(profile);
    await expect(
      screen.getByRole("heading", "Check-ins", { exact: true }),
    ).toBeVisible();
    const turnOn = screen.getByRole("button", "Turn on check-ins", {
      exact: true,
    });
    if (scenario === "no check-in") {
      await turnOn.first().click();
      const dialog = screen.getByRole("dialog", "Turn on check-ins", {
        exact: true,
      });
      await dialog
        .getByRole("combobox", "Conversation", { exact: true })
        .click();
      const choices = screen.getByRole("option");
      await expect(choices).toHaveCount(1);
      await expect(choices.first()).toContainText("Release reports");
      expect(runs).toEqual([]);
      return;
    }
    const row = screen.getByRole("button").filter({ hasText: focus });
    await expect(row).toBeVisible();
    await expect(turnOn).toHaveCount(0);
    await expect(row.getByText(/^Every hour · Next /)).toBeVisible();
    await expect(
      row.getByText(`Looks for: ${focus}`, { exact: true }),
    ).toBeVisible();
    const focusLayout = await browser.evaluate((value) => {
      const line = [
        ...document.querySelectorAll('button [data-slot="item-description"]'),
      ].find((node) => node.textContent?.includes(value));
      return line
        ? {
            schedule:
              line.parentElement?.querySelector(
                '[data-slot="item-description"]',
              )?.textContent ?? null,
            clamp:
              getComputedStyle(line).getPropertyValue("-webkit-line-clamp"),
          }
        : null;
    }, focus);
    expect(focusLayout?.schedule).toMatch(/^Every hour · Next /);
    expect(focusLayout?.clamp).toBe("1");
    const previouslySkipped = `Skipped 5 minutes ago. ${skipped}`;
    if (scenario === "previously skipped")
      await expect(
        row.getByText(previouslySkipped, { exact: true }),
      ).toBeVisible();
    await row.click();
    const dialog = screen.getByRole("dialog", "Check-ins", { exact: true });
    if (scenario === "previously skipped") {
      await expect(
        dialog.getByText(previouslySkipped, { exact: true }),
      ).toBeVisible();
      expect(runs).toEqual([]);
      return;
    }
    if (scenario === "queued")
      await expect(
        dialog.getByText("Checked 2 hours ago. Found 2 things for you.", {
          exact: true,
        }),
      ).toBeVisible();
    await dialog.getByRole("button", "Run now", { exact: true }).click();
    const result =
      scenario === "queued"
        ? "Queued. It checks in within a minute."
        : `Skipped just now. ${skipped}`;
    await expect(dialog.getByText(result, { exact: true })).toBeVisible();
    expect(runs).toEqual(["POST"]);
  });
}
