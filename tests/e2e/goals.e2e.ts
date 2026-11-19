import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { frameFiring } from "../../shared/routine-firing";
import { configureChatStream } from "./chat-stream";
import { createConversation } from "./conversations";
import { createBot } from "./signed-in";

async function seedGoal(
  browser: Browser,
  {
    agentId,
    channelId,
    title,
  }: { agentId: string; channelId: string; title: string },
) {
  await browser.evaluate(
    async ({ agentId, channelId, title }) => {
      const response = await fetch("/api/responsibilities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          channelId,
          title,
          instruction: "Review the open items.",
          successCriteria: "Every open item has an update.",
        }),
      });
      if (!response.ok)
        throw new Error(
          `Cannot create the test Goal: ${response.status} ${await response.text()}`,
        );
      return null;
    },
    { agentId, channelId, title },
  );
}

test("a Bot's Goals page filters Goals and creates one using only its Conversations", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const finance = await createBot(fixtures);
  const docs = await createBot(fixtures);
  const financeChannel = await createConversation(
    browser,
    finance.id,
    "Finance desk",
  );
  const docsChannel = await createConversation(browser, docs.id, "Docs desk");
  await seedGoal(browser, {
    agentId: finance.id,
    channelId: financeChannel,
    title: "Reconcile receipts",
  });
  await seedGoal(browser, {
    agentId: docs.id,
    channelId: docsChannel,
    title: "Keep the wiki fresh",
  });
  const requests: unknown[] = [];
  await browser.route(/\/api\/responsibilities$/, (route) => {
    if (route.request.method === "POST")
      requests.push(JSON.parse(route.request.postData ?? "null"));
    return route.continue();
  });
  const page = `/bots/${finance.id}/responsibilities`;
  await app.open(page);
  await expect(
    screen.getByText("Reconcile receipts", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Keep the wiki fresh", { exact: true }),
  ).toHaveCount(0);
  await screen.getByRole("button", "New goal", { exact: true }).tap();
  const dialog = screen.getByRole("dialog", "New goal");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", /^Bot/)).toHaveCount(0);
  await dialog.getByRole("combobox", /^Conversation/).tap();
  await expect(
    screen.getByRole("option", `${finance.name}: Finance desk`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(screen.getByRole("option", /Docs desk$/)).toHaveCount(0);
  await screen
    .getByRole("option", `${finance.name}: Finance desk`, { exact: true })
    .tap();
  await dialog.getByLabel("Title").fill("Close the month");
  await dialog.getByLabel("Instruction").fill("Close the monthly books.");
  await dialog
    .getByLabel("Success criteria")
    .fill("The books are ready for review.");
  await dialog.getByRole("button", "Create goal", { exact: true }).tap();
  await expect(dialog).toBeHidden();
  await expect(
    screen.getByText("Close the month", { exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    agentId: finance.id,
    channelId: financeChannel,
    title: "Close the month",
    instruction: "Close the monthly books.",
    successCriteria: "The books are ready for review.",
  });
  await expect(browser).toHaveURL(page);
  await browser.reload();
  await expect(
    screen.getByText("Close the month", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Keep the wiki fresh", { exact: true }),
  ).toHaveCount(0);
});

test("an empty Bot Goals page names the Goal in the heading, empty state and dialog", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  await app.open(`/bots/${bot.id}/responsibilities`);
  const newGoal = screen.getByRole("button", "New goal", { exact: true });
  const empty = browser
    .locator('[data-slot="empty"]')
    .filter({ hasText: "No goals yet" });
  await expect(
    screen.getByRole("heading", "Goals", { exact: true }),
  ).toBeVisible();
  await expect(empty).toBeVisible();
  await expect(newGoal).toHaveCount(2);
  await empty.getByRole("button", "New goal", { exact: true }).tap();
  const dialog = screen.getByRole("dialog", "New goal");
  await expect(
    dialog.getByRole("button", "Create goal", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(/responsibilit/i)).toHaveCount(0);
});

test("a Goal turn keeps the Bot's instructions behind Details", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const bot = await createBot(fixtures);
  const channel = await createConversation(
    browser,
    bot.id,
    "Goal conversation",
  );
  const instruction = "Summarise the front page.";
  const criteria = "Success criteria: Posted.";
  const prompt = [
    frameFiring(instruction),
    "",
    criteria,
    "Progress so far: No progress recorded yet.",
    "Trigger: manual/requested",
    "Event data:",
    "{}",
    "",
    "Record meaningful progress with report_responsibility_progress for responsibility 0b6c1a52-8d7e-4f0a-9b1f-3c2d1e0f9a8b.",
  ].join("\n");
  await configureChatStream(browser, [
    { id: "goal-firing", role: "user", content: prompt },
  ]);
  await app.open(`/channel/${channel}`);
  const messages = screen.getByRole("region", "Messages", { exact: true });
  await expect(
    messages.getByText("Worked on a goal.", { exact: true }),
  ).toBeVisible();
  await expect(messages.getByText(instruction, { exact: true })).toBeVisible();
  await expect(
    messages.getByText("Worked on a goal. Trigger: manual", { exact: true }),
  ).toBeVisible();
  const content = browser.locator("details > p").filter({ hasText: criteria });
  await expect(content).toHaveCount(1);
  await expect(content).toBeHidden();
  const details = messages.getByText("Details", { exact: true });
  await details.tap();
  await expect(content).toBeVisible();
  await details.tap();
  await expect(content).toBeHidden();
});
