import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { generatedSurface } from "./a2ui-surface";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

const fixture = "/tests/browser/late-renderers.html";

for (const trigger of [
  "Connect runtime",
  "Finish loading capabilities",
  "Connect before installing renderer",
]) {
  test(`waiting activities see new renderers after ${trigger.toLowerCase()}`, async ({
    app,
    screen,
  }) => {
    await app.open(fixture);
    const version = screen.getByRole("status", "Renderer version", {
      exact: true,
    });
    await expect(version).toHaveText("0");
    await screen.getByRole("button", trigger, { exact: true }).tap();
    await expect(version).toHaveText("1");
  });
}

test("an activity that already has a renderer adds no subscription", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?mode=already-ready`);
  await screen
    .getByRole("button", "Read subscriber count", { exact: true })
    .tap();
  await expect(
    screen.getByRole("status", "Runtime subscribers", { exact: true }),
  ).toHaveText("0");
});

test("the transcript subscribes once and emits one notification for a renderer change", async ({
  app,
  screen,
}) => {
  await app.open(`${fixture}?mode=transcript`);
  await screen
    .getByRole("button", "Read subscriber count", { exact: true })
    .tap();
  await expect(
    screen.getByRole("status", "Runtime subscribers", { exact: true }),
  ).toHaveText("1");
  await screen.getByRole("button", "Connect runtime", { exact: true }).tap();
  await expect(
    screen.getByRole("status", "Renderer notifications", { exact: true }),
  ).toHaveText("[1]");
});

test("historical activities draw when capabilities arrive without another conversation message", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(browser, bot.id);
  const snapshot = [
    { id: "one", role: "assistant", content: "Your saved options are below." },
    generatedSurface(
      "first-late",
      [
        {
          id: "root",
          component: "TextField",
          label: "Destination",
          value: { "@path": "/destination" },
        },
      ],
      { destination: "Paris" },
    ),
    generatedSurface("second-late", [
      { id: "root", component: "Text", text: "Travel dates: 12 to 18 June" },
    ]),
  ];
  await configureChatStream(browser, snapshot);
  const release = Promise.withResolvers<void>();
  await browser.route(/\/api\/capabilities$/, async (route) => {
    const data = await (await route.fetch()).json<Record<string, unknown>>();
    await release.promise;
    return route.fulfill({ json: { ...data, generativeUi: true } });
  });
  const transcript = screen.getByRole("region", "Messages", { exact: true });
  const destination = transcript.getByRole("textbox", "Destination", {
    exact: true,
  });
  const dates = transcript.getByText("Travel dates: 12 to 18 June", {
    exact: true,
  });
  try {
    await app.open(`/channel/${channel}`);
    const reply = transcript.getByText("Your saved options are below.", {
      exact: true,
    });
    await expect(reply).toBeVisible();
    await expect(destination).toHaveCount(0);
    await expect(dates).toHaveCount(0);
    release.resolve();
    await expect(destination).toHaveValue("Paris");
    await expect(dates).toBeVisible();
    await expect(reply).toHaveCount(1);
  } finally {
    release.resolve();
  }
});
