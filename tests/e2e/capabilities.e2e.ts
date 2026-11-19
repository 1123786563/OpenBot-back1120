import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createBot } from "./signed-in";

const memoryLinks = ["/capabilities/memory", "/memory", "/settings/memory"];

if (process.env.OPENBOT_E2E_SUITE === "personal") {
  test("personal Bots opens its own Skills page and returns without a Memory link", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/bots");
    await expect(
      screen.getByRole("heading", "What your Bots know"),
    ).toBeVisible();
    await expect(browser.locator('a[href="/capabilities/memory"]')).toHaveCount(
      0,
    );
    const skills = screen.getByRole("link", /^Skills\b/);
    await expect(skills).toHaveAttribute("href", "/capabilities/skills");
    await skills.tap();
    await expect(browser).toHaveURL("/capabilities/skills");
    await expect(
      screen.getByRole("heading", "Skills", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByRole("navigation", "Capabilities")).toHaveCount(0);
    const back = screen.getByRole("button", "Bots", { exact: true });
    await expect(back).toHaveAttribute("href", "/bots");
    await back.tap();
    await expect(browser).toHaveURL("/bots");
    await expect(
      screen.getByRole("heading", "What your Bots know"),
    ).toBeVisible();
  });

  test("old personal Memory links return to Bots", async ({
    app,
    browser,
    screen,
  }) => {
    for (const link of memoryLinks) {
      await app.open(link);
      await expect(browser).toHaveURL("/bots");
      await expect(
        screen.getByRole("heading", "Bots", { exact: true }),
      ).toBeVisible();
    }
  });

  test("an old personal Bot Memory link opens its access page and Check-ins", async (fixtures) => {
    const { id } = await createBot(fixtures);
    const { app, browser, screen } = fixtures;
    await app.open(`/bots/${id}/memory`);
    await expect(browser).toHaveURL(`/bots/${id}/access`);
    await expect(screen.getByRole("heading", "What it can do")).toBeVisible();
    await expect(screen.getByRole("heading", "Check-ins")).toBeVisible();
  });
} else {
  test("team Capabilities keeps Skills and Memory as tabs and accepts old Memory links", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/capabilities/skills");
    await expect(screen.getByRole("heading", "Capabilities")).toBeVisible();
    const tabs = screen.getByRole("navigation", "Capabilities");
    await expect(
      tabs.getByRole("button", "Skills", { exact: true }),
    ).toBeVisible();
    const memory = tabs.getByRole("button", "Memory", { exact: true });
    await memory.tap();
    await expect(browser).toHaveURL("/capabilities/memory");
    await expect(
      screen.getByRole("heading", "Your memories", { exact: true }),
    ).toBeVisible();
    for (const link of memoryLinks) {
      await app.open(link);
      await expect(browser).toHaveURL("/capabilities/memory");
      await expect(
        screen.getByRole("heading", "Your memories", { exact: true }),
      ).toBeVisible();
    }
  });

  test("team Bots keep Check-ins on their Memory page", async (fixtures) => {
    const { id } = await createBot(fixtures);
    const { app, browser, screen } = fixtures;
    await app.open(`/bots/${id}/access`);
    await expect(
      screen.getByRole("heading", "Skills and access"),
    ).toBeVisible();
    await expect(screen.getByRole("heading", "Check-ins")).toHaveCount(0);
    await app.open(`/bots/${id}/memory`);
    await expect(browser).toHaveURL(`/bots/${id}/memory`);
    await expect(
      screen.getByRole("heading", "Memory", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByRole("heading", "Check-ins")).toBeVisible();
  });
}
