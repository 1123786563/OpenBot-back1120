import { test } from "@e2e-dev/web";
import { expect } from "e2e";

for (const [legacy, current] of [
  ["/agents", "/bots"],
  ["/agents?agent=agent_1", "/bots/agent_1"],
  ["/approvals", "/settings/approvals"],
  ["/memory", "/capabilities/memory"],
  ["/reachability", "/settings/notifications"],
  ["/responsibilities", "/bots"],
  ["/group/new", "/channel/new"],
]) {
  test(`the saved link ${legacy} opens ${current}`, async ({
    app,
    browser,
  }) => {
    await app.open(legacy);
    await expect(browser).toHaveURL(current);
  });
}

for (const legacy of ["/agents?new=true", "/agents?new=true&agent=agent_1"]) {
  test(`the saved link ${legacy} opens the New Bot form`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(legacy);
    await expect(browser).toHaveURL("/bots?new=true");
    await expect(screen.getByRole("dialog", "New Bot")).toBeVisible();
  });
}

test("a legacy redirect replaces its history entry", async ({
  app,
  browser,
}) => {
  await app.open("/settings/approvals");
  await expect(browser).toHaveURL("/settings/approvals");
  await app.open("/agents");
  await expect(browser).toHaveURL("/bots");
  await browser.back();
  await expect(browser).toHaveURL("/settings/approvals");
});
