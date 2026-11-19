import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";
import { installSkill } from "./skills";

test("a skill written in personal Settings is already enabled on a newly created Bot", async (fixtures) => {
  const { app, browser, screen } = fixtures;
  const command = `tide-${crypto.randomUUID().slice(0, 8)}`;
  const title = `Tide report ${command.slice(-8)}`;
  await app.open("/settings/skills/new");
  await expect(
    screen.getByRole("heading", "New skill", { exact: true }),
  ).toBeVisible();
  await screen.getByLabel("Command").fill(command);
  await screen.getByLabel("Title").fill(title);
  await screen
    .getByLabel("One-liner")
    .fill("When the tide turns at the harbour mouth.");
  await screen
    .getByLabel("Instructions")
    .fill("Read the tide table and say when it turns.");
  await screen.getByRole("button", "Save skill", { exact: true }).tap();
  await expect(browser).toHaveURL(`/settings/skills/${command}`);
  await expect(
    screen.getByRole("heading", title, { exact: true }),
  ).toBeVisible();
  const second = {
    slug: `receipt-${command.slice(-8)}`,
    title: `Receipt summary ${command.slice(-8)}`,
    summary: "Summarise receipts.",
    instructions: "List receipt totals.",
    global: true,
  };
  await installSkill(browser, second);

  const { id } = await createBot(fixtures);
  await app.open(`/bots/${id}/access`);
  await expect(
    screen.getByRole("heading", "What it can do", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole("switch", title, { exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    screen.getByRole("switch", second.title, { exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(screen.getByText(title, { exact: true })).toHaveCount(2);
  await expect(screen.getByText(`/${command}`, { exact: true })).toHaveCount(0);
  await expect(screen.getByText("No skills yet", { exact: true })).toHaveCount(
    0,
  );
  const shippedSkill = await browser.evaluate(async () => {
    const response = await fetch("/api/plugins");
    if (!response.ok)
      throw new Error(`Loading skills returned ${response.status}`);
    const {
      skills,
    }: {
      skills: { slug: string; title: string; ownerUserId: string | null }[];
    } = await response.json();
    return skills.find(({ slug }) => slug === "find-a-document") ?? null;
  });
  expect(shippedSkill).toMatchObject({
    title: "Find a document",
    ownerUserId: null,
  });
  await expect(
    screen.getByRole("switch", "Find a document", { exact: true }),
  ).toHaveCount(0);
});
