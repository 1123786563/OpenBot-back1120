import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import answers from "./fixtures/what-if.json";

const question =
  "Could the Sales Bot send an email from Gmail when a routine runs it?";
const audit = /\/api\/admin\/audit-events(?:\?|$)/;

test("What would happen confirms an action and shows the deciding control in order", async ({
  app,
  browser,
  screen,
}) => {
  const asked: unknown[] = [];
  const checked: unknown[] = [];
  await browser.route(/\/api\/admin\/what-if\/vocabulary$/, (route) =>
    route.fulfill({ json: answers.vocabulary }),
  );
  await browser.route(/\/api\/admin\/what-if\/ask$/, (route) => {
    expect(route.request.method).toBe("POST");
    asked.push(JSON.parse(route.request.postData ?? "null"));
    return route.fulfill({
      json: {
        understood: "yes",
        action: answers.checked.action,
        labels: answers.checked.labels,
        missing: null,
      },
    });
  });
  await browser.route(/\/api\/admin\/what-if\/check$/, (route) => {
    expect(route.request.method).toBe("POST");
    checked.push(JSON.parse(route.request.postData ?? "null"));
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(answers.checked),
    });
  });
  await app.open("/admin/what-if");
  const check = screen.getByRole("button", "Check", { exact: true });
  await expect(
    screen.getByText("Choose a Bot.", { exact: true }),
  ).toBeVisible();
  await expect(check).toBeDisabled();
  await screen.getByLabel("Ask what would happen").fill(question);
  await screen.getByRole("button", "Ask", { exact: true }).tap();
  const chips = browser.locator("[data-what-if-chip]");
  await expect(chips).toHaveCount(7);
  const applied = await browser.evaluate(() =>
    Array.from(
      document.querySelectorAll("[data-what-if-chip]"),
      (chip) => chip.textContent,
    ),
  );
  expect(applied).toEqual([
    "Bot:Sales",
    "Runs as:Sam Lee",
    "Started by:A routine",
    "Uses:An app",
    "App:Gmail",
    "Tool:Send email",
    "Effect:Changes something",
  ]);
  expect(asked).toEqual([{ question }]);
  await check.tap();
  await expect(screen.getByText("What happens", { exact: true })).toBeVisible();
  expect(checked).toEqual([{ action: answers.checked.action, question }]);
  const layers = await browser.evaluate(() =>
    Array.from(document.querySelectorAll("[data-layer]"), (layer) =>
      layer.getAttribute("data-layer"),
    ),
  );
  expect(layers).toEqual([
    "grant",
    "app_allowlist",
    "capabilities",
    "boundaries",
    "safety",
    "approvals",
  ]);
  const boundary = browser.locator('[data-layer="boundaries"]');
  await expect(boundary).toHaveAttribute("data-decides", "true");
  await expect(boundary.getByText("Refuses", { exact: true })).toBeVisible();
  await expect(boundary).toContainText(
    "Rule: No email when nobody is watching",
  );
  const safety = browser.locator('[data-layer="safety"]');
  await expect(safety).toHaveAttribute("data-unreached", "true");
  await expect(safety).toContainText("Not reached");
  await expect(browser.locator("[data-what-if-headline]")).toContainText(
    "Refused",
  );

  await browser
    .locator('[data-what-if-chip="initiator"]')
    .getByRole("button")
    .tap();
  await screen
    .getByRole("menuitemradio", "A person chatting", { exact: true })
    .tap();
  await expect(
    browser.locator('[data-what-if-chip="initiator"]'),
  ).toContainText("A person chatting");
  await expect(browser.locator("[data-layer]")).toHaveCount(0);
  expect(checked).toHaveLength(1);
});

test("Audit explains the recorded refusal and the current deciding control", async ({
  app,
  browser,
  screen,
}) => {
  const { event, explained } = answers;
  const reads: string[] = [];
  await browser.route(audit, (route) =>
    route.fulfill({ json: { events: [event] } }),
  );
  await browser.route(/\/api\/admin\/what-if\/explain\/[^/?]+$/, (route) => {
    reads.push(new URL(route.request.url).pathname);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(explained),
    });
  });
  await app.open("/admin/audit");
  await screen.getByRole("button", "Why?", { exact: true }).tap();
  const dialog = screen.getByRole("dialog", "Why did this happen?");
  const recorded = browser.locator("[data-why-recorded]");
  await expect(dialog).toBeVisible();
  await expect(recorded).toContainText(
    'Refused by the boundary "No email when nobody is watching".',
  );
  await expect(
    browser.locator('[role="dialog"] [data-layer="boundaries"]'),
  ).toHaveAttribute("data-decides", "true");
  await expect(dialog).not.toContainText(
    "Today's settings decide this differently",
  );
  expect(reads).toEqual([`/api/admin/what-if/explain/${event.id}`]);
});

test("Audit omits Why for configuration rows", async ({
  app,
  browser,
  screen,
}) => {
  const event = {
    ...answers.event,
    id: "00000000-0000-4000-8000-0000000000aa",
    eventType: "configuration.changed",
    targetType: "mcp_tool",
    payload: { change: "plugin_granted", ref: "whatif-gmail/send_email" },
  };
  await browser.route(audit, (route) =>
    route.fulfill({ json: { events: [event] } }),
  );
  await app.open("/admin/audit");
  await expect(browser.locator("[data-audit-count]")).toHaveText("1 event");
  await expect(screen.getByRole("button", "Why?", { exact: true })).toHaveCount(
    0,
  );
});
