import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { confirmComposition } from "./ime";
import { createBot } from "./signed-in";

const composedName = "経費";

test("composing a character in the Bot name editor leaves the draft until ordinary Enter", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const path = `/bots/${bot.id}/setup`;
  const writes: unknown[] = [];
  await browser.route(
    new RegExp(`/api/agents/${RegExp.escape(bot.id)}$`),
    async (route) => {
      if (route.request.method === "PATCH")
        writes.push(JSON.parse(route.request.postData ?? "null"));
      await route.continue();
    },
  );
  await app.open(path);
  await screen.getByRole("button", /^Name/).click();
  const dialog = screen.getByRole("dialog", "Name", { exact: true });
  const name = dialog.getByRole("textbox", "Name", { exact: true });
  await name.fill(composedName);
  await name.focus();
  expect(await confirmComposition(browser)).toEqual([false, false]);
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue(composedName);
  expect(writes).toEqual([]);

  await name.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => writes)
    .toEqual([expect.objectContaining({ name: composedName })]);
  await expect(
    screen.getByText(composedName, { exact: true }).first(),
  ).toBeVisible();
});

test("composing a character in the New Bot sheet keeps it open until ordinary Enter", async ({
  app,
  browser,
  screen,
}) => {
  const writes: unknown[] = [];
  await browser.route(/\/api\/agents$/, async (route) => {
    if (route.request.method === "POST")
      writes.push(JSON.parse(route.request.postData ?? "null"));
    await route.continue();
  });
  await app.open("/bots");
  await screen.getByRole("button", "New Bot", { exact: true }).first().click();
  const dialog = screen.getByRole("dialog", "New Bot", { exact: true });
  const name = dialog.getByRole("textbox", "Name", { exact: true });
  await name.fill(composedName);
  await name.focus();
  expect(await confirmComposition(browser)).toEqual([true, true]);
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue(composedName);
  expect(writes).toEqual([]);

  await name.press("Enter");
  await expect(browser).toHaveURL(/\/bots\/[^/?#]+\/?$/);
  await expect(
    screen.getByRole("heading", composedName, { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([expect.objectContaining({ name: composedName })]);
});
