import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const page = "/tests/browser/tool-render-boundary.html";
const fallback =
  /Couldn't show (Chart|Choice)\. The rest of the conversation is fine\./;

test("a tool card recovers on the next argument chunk without flashing a failure", async ({
  app,
  screen,
}) => {
  await app.open(`${page}?scenario=streaming`);
  const card = screen.getByRole("region", "Tool card", { exact: true });
  const next = screen.getByRole("button", "Deliver next chunk", {
    exact: true,
  });
  await expect(next).toBeEnabled();
  await expect(card.getByText(fallback)).toHaveCount(0);
  await expect(card.getByText("Chart rendered", { exact: true })).toHaveCount(
    0,
  );
  await next.click();
  await expect(card.getByText("Chart rendered", { exact: true })).toBeVisible();
  await expect(card.getByText(fallback)).toHaveCount(0);
});

for (const scenario of ["final", "no-key", "stopped", "decision"]) {
  test(`the ${scenario} tool card shows a local error without taking down the conversation`, async ({
    app,
    screen,
  }) => {
    await app.open(`${page}?scenario=${scenario}`);
    const card = screen.getByRole("region", "Tool card", { exact: true });
    const error = card.getByText(fallback);
    await expect(error).toBeVisible();
    await expect(error).toHaveText(
      `Couldn't show ${scenario === "decision" ? "Choice" : "Chart"}. The rest of the conversation is fine.`,
    );
    await expect(
      screen.getByText("The conversation is still visible.", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText("Fixture render failed")).toHaveCount(0);
    if (scenario === "final" || scenario === "no-key") {
      await screen
        .getByRole("button", "Deliver next chunk", { exact: true })
        .click();
      await expect(error).toBeVisible();
      await expect(
        card.getByText("Chart rendered", { exact: true }),
      ).toHaveCount(0);
    }
  });
}
