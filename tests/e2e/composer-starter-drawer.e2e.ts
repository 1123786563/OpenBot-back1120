import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = "/tests/browser/composer.html?starter-drawer";

for (const width of [420, 1000]) {
  test(`open questions and starter tasks fit above the composer at ${width}px`, async ({
    app,
    browser,
    screen,
  }) => {
    await browser.addInitScript(() => {
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        value: "default",
      });
    });
    await browser.setViewport({ width, height: 800 });
    await app.open(`${fixture}&question`);
    const question = screen.getByRole(
      "region",
      "Personal Assistant is waiting on your answer",
      { exact: true },
    );
    const submit = question.getByRole("button", "Send answer", { exact: true });
    const starter = screen.getByRole("region", "Starter tasks", {
      exact: true,
    });
    await expect(
      question.getByText("Which city should I look in?", { exact: true }),
    ).toBeVisible();
    await expect(submit).toBeVisible();
    await expect(starter).toHaveCount(0);
    await expect(browser.locator("[data-notify-prompt]")).toBeVisible();
    const geometry = await browser.evaluate(() => {
      const column = document.querySelector('[data-slot="composer-column"]');
      const form = column?.querySelector('form[data-slot="composer"]');
      const drawer = column?.querySelector('[data-slot="composer-drawer"]');
      const offer = column?.querySelector("[data-notify-prompt]");
      const button = drawer?.querySelector("button");
      if (!column || !form || !drawer || !offer || !button)
        throw new Error("Incomplete composer with question");
      const bounds = form.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return {
        inset: Math.round(bounds.left - column.getBoundingClientRect().left),
        width: Math.round(bounds.width),
        offerAbove:
          offer.getBoundingClientRect().bottom <=
          drawer.getBoundingClientRect().top,
        adjacent: drawer.nextElementSibling?.contains(form) ?? false,
        canClick: button.contains(
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ),
        ),
      };
    });
    expect(geometry).toEqual({
      inset: 16,
      width: Math.min(768, width - 32),
      offerAbove: true,
      adjacent: true,
      canClick: true,
    });
    await submit.click();
    await expect(question).toHaveCount(0);
    await expect(
      starter.getByRole("button", "Find weekend plans", { exact: true }),
    ).toBeVisible();
    expect(
      await browser.evaluate(() => {
        const tasks = document.querySelector('[aria-label="Starter tasks"]');
        return (
          tasks?.nextElementSibling?.querySelector(
            'form[data-slot="composer"]',
          ) !== null
        );
      }),
    ).toBe(true);
  });
}
