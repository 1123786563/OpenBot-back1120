import { test } from "@e2e-dev/web";
import { expect } from "e2e";

for (const path of ["/bots", "/channel/new", "/onboarding"]) {
  test(`a guest visiting ${path} sees the sign-in screen`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(path);
    await expect(browser).toHaveURL("/sign");
    await expect(screen.getByRole("heading", /^Sign in to /)).toBeVisible();
  });
}
