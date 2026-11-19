import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const PERSONAL = {
  "no-broker":
    "Connecting apps isn't set up yet, so nothing was recorded. Set it up in Settings under Setup.",
  "not-permitted":
    "You can't connect that app's account anymore, so nothing was recorded. The app's setup changed while the authorization was open. Start again from the app's page.",
  "not-recorded":
    "Couldn't record that authorization, so nothing was saved. Start again from the app's page, or check OpenBot's logs if it keeps happening.",
} satisfies Record<string, string>;

const TEAM = {
  "no-broker":
    "Connecting apps isn't set up yet, so nothing was recorded. Ask an admin to set it up.",
  "not-permitted":
    "You can't connect that app's account anymore, so nothing was recorded. Your access or the app's setup changed while the authorization was open. Ask an admin if you expected to finish it.",
  "not-recorded":
    "Couldn't record that authorization, so nothing was saved. Start again from the app's page, or ask an admin if it keeps happening.",
} satisfies Record<keyof typeof PERSONAL, string>;

const personal = process.env.OPENBOT_E2E_SUITE === "personal";
const notices = personal ? PERSONAL : TEAM;

for (const [code, message] of Object.entries(notices)) {
  test(`Connections explains the ${code} authorization result in the ${personal ? "personal" : "team"} edition`, async ({
    app,
    screen,
  }) => {
    await app.open(`/connections?authorized=${code}`);
    await expect(
      screen.getByRole("heading", "Connections", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("alert").filter({ hasText: message }),
    ).toHaveText(message);
  });
}

if (personal) {
  test("Connections explains when there is no authorization to finish", async ({
    app,
    screen,
  }) => {
    await app.open("/connections?authorized=no-attempt");
    const message =
      "There's no authorization in progress for you to finish. It may have expired, or started in another session. Start again from the app's page.";
    await expect(
      screen.getByRole("alert").filter({ hasText: message }),
    ).toHaveText(message);
  });
}

const callbacks = [
  ["connected=failed", /Couldn't connect that account/],
  ["authorized=no-attempt", /There's no authorization in progress/],
  ["linked=failed", /Couldn't link your GitHub account/],
] as const;

for (const indices of [[0], [1], [2], [0, 1, 2]]) {
  const reports = callbacks.filter((_, index) => indices.includes(index));
  test(`Connections consumes ${reports.map(([query]) => query).join(" and ")} once`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(`/connections?${reports.map(([query]) => query).join("&")}`);
    await expect(browser).toHaveURL("/connections");
    for (const [, text] of reports)
      await expect(screen.getByText(text)).toBeVisible();
    await browser.reload();
    await expect(
      screen.getByRole("heading", "Connections", { exact: true }),
    ).toBeVisible();
    await expect(browser).toHaveURL("/connections");
    for (const [, text] of callbacks)
      await expect(screen.getByText(text)).toHaveCount(0);
  });
}

test("Connections opens directly with a clean URL and no callback notice", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/connections");
  await expect(
    screen.getByRole("heading", "Connections", { exact: true }),
  ).toBeVisible();
  await expect(browser).toHaveURL("/connections");
  for (const [, text] of callbacks)
    await expect(screen.getByText(text)).toHaveCount(0);
});
