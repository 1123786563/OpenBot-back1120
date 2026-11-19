import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixedReply } from "./model-reply";
import { sendMessage, workspace } from "./signed-in";

test(
  "a streamed reply is displayed and persisted",
  workspace,
  async (fixtures) => {
    const reply = await sendMessage(fixtures);
    await expect(reply).toHaveText(fixedReply, { timeout: 45_000 });
    await expect(
      fixtures.browser.locator('[data-testid="composer-stop"]'),
    ).toBeHidden();
    await fixtures.browser.reload();
    await expect(reply).toHaveText(fixedReply);
  },
);
