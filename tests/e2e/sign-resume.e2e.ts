import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const verifier = "/api/plugins/arcade/verify";

for (const flowId of ["f 1", "12345", '{"a":1}', '["a"]', "true"]) {
  test(`a signed-in browser reaches the verifier with flow_id ${flowId}`, async ({
    app,
    browser,
    screen,
  }) => {
    const requests: { method: string; flowId: string | null }[] = [];
    await browser.route(/\/api\/plugins\/arcade\/verify\?/, async (route) => {
      requests.push({
        method: route.request.method,
        flowId: new URL(route.request.url).searchParams.get("flow_id"),
      });
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><h1>Authorization resumed</h1>",
      });
    });
    const query = `?flow_id=${encodeURIComponent(flowId)}`;
    await app.open(`/sign${query}`);
    await expect(
      screen.getByRole("heading", "Authorization resumed"),
    ).toBeVisible();
    await expect(browser).toHaveURL(`${verifier}${query}`);
    expect(requests).toEqual([{ method: "GET", flowId }]);
  });
}

test("a signed-in browser returns home without a flow handle", async ({
  app,
  browser,
}) => {
  await app.open("/sign");
  await expect(browser).toHaveURL("/");
});
