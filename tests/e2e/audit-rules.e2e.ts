import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const SITES = [
  "facebook.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "reddit.com",
  "snapchat.com",
  "pinterest.com",
  "threads.net",
  "bsky.app",
  "tumblr.com",
  "mastodon.social",
  "youtube.com",
];
/** The shape the plain-English translator writes: a clause per site, over a thousand characters. */
const SOCIAL = `intent == "navigate" && (${SITES.map(
  (site) =>
    `page.host == "${site}" || matches(page.host, "[.]${site.replace(".", "[.]")}$")`,
).join(" || ")})`;
const NAME = "Bots may not visit social media sites";

function refusal(decision: Record<string, string | boolean>) {
  return {
    id: "event-1",
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.action_refused",
    targetType: "computer",
    targetId: "bot-a",
    payload: {
      action: "computer_navigate",
      bot: "bot-a",
      actor: "person@example.test",
      page: "https://www.facebook.com/",
      ref: null,
      decision: {
        allowed: false,
        mode: "enforce",
        source: "deny",
        carriedOut: false,
        ...decision,
      },
    },
    createdAt: new Date(0).toISOString(),
  };
}

for (const { label, rule, ruleName, dryRun } of [
  { label: "a named rule", rule: SOCIAL, ruleName: NAME, dryRun: false },
  {
    label: "a legacy rule without a name",
    rule: SOCIAL,
    ruleName: null,
    dryRun: false,
  },
  {
    label: "a short rule",
    rule: 'intent == "navigate" && page.host == "x.com"',
    ruleName: "Stay off X",
    dryRun: false,
  },
  { label: "a trial-mode refusal", rule: SOCIAL, ruleName: NAME, dryRun: true },
]) {
  test(`Audit presents ${label}`, async ({ app, browser, screen }) => {
    await browser.setViewport({ width: 1280, height: 820 });
    const event = refusal({
      rule,
      ...(ruleName ? { ruleName } : {}),
      ...(dryRun ? { mode: "dry-run", carriedOut: true } : {}),
    });
    await browser.route(/\/api\/admin\/audit-events(?:\?|$)/, (route) =>
      route.fulfill({ json: { events: [event] } }),
    );
    await app.open("/admin/audit");
    const row = browser.locator("tbody tr");
    await expect(row.getByText("Blocked", { exact: true })).toBeVisible();
    const name = dryRun ? "Would be stopped by:" : "Stopped by:";
    if (ruleName) {
      await expect(
        row.getByText(`${name} ${ruleName}`, { exact: true }),
      ).toBeVisible();
    } else {
      await expect(row.getByText(/^Stopped by:/)).toHaveCount(0);
    }
    await expect(
      row.getByText("dry-run: recorded, not enforced", { exact: true }),
    ).toHaveCount(dryRun ? 1 : 0);
    const expression = row.getByText(rule, { exact: true });
    await expect(expression).toBeVisible();
    const more = row.getByRole("button", "Show full rule", { exact: true });
    if (rule !== SOCIAL) {
      await expect(more).toHaveCount(0);
      return;
    }
    expect(rule.length).toBeGreaterThan(1000);
    await expect(more).toHaveAttribute("aria-expanded", "false");
    const id = await expression.getAttribute("id");
    if (!id) throw new Error("The rule expression needs a control target");
    await expect(more).toHaveAttribute("aria-controls", id);
    const measured = () =>
      browser.evaluate((id) => {
        const element = document.getElementById(id);
        if (!element) throw new Error("Missing rule expression");
        const lineHeight = Number.parseFloat(
          getComputedStyle(element).lineHeight,
        );
        return {
          height: element.clientHeight,
          content: element.scrollHeight,
          lineHeight,
        };
      }, id);
    const clamped = await measured();
    expect(clamped.height).toBeLessThanOrEqual(2 * clamped.lineHeight + 1);
    expect(clamped.content).toBeGreaterThan(clamped.height);
    if (!ruleName || dryRun) return;

    await more.tap();
    const less = screen.getByRole("button", "Show less", { exact: true });
    await expect(less).toHaveAttribute("aria-expanded", "true");
    const expanded = await measured();
    expect(expanded.height).toBeGreaterThan(clamped.height);
    expect(expanded.content - expanded.height).toBeLessThanOrEqual(1);
    await less.tap();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect
      .poll(async () => (await measured()).height)
      .toBe(clamped.height);
  });
}
