import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const fixture = (kind: "bot" | "skill", scenario?: string) =>
  `/tests/browser/proposal-cards.html?kind=${kind}${scenario ? `&scenario=${scenario}` : ""}`;

const cases = [
  {
    kind: "bot",
    streaming: "Writing the Bot…",
    decline: "Don't create",
    declineAnswer:
      "The person did not create this coworker. Ask what to change rather than proposing the same one again.",
    invalid: /Not created, and the person was not asked.*name:/,
    refusal: "A coworker called Renewal Desk already exists.",
    success:
      /"type":"create".*"visibility":"private".*"type":"answer".*Renewal Desk now exists and is private.*granted no connector, no tool and no address/,
  },
  {
    kind: "skill",
    streaming: "Writing the skill…",
    decline: "Don't save",
    declineAnswer:
      "The person did not save this skill. Ask what to change rather than saving it again unchanged.",
    invalid: /Not saved, and the person was not asked.*slug:/,
    refusal: "weekly-summary is somebody else's skill.",
    success:
      /"type":"save".*"slug":"weekly-summary".*"type":"answer".*Saved\. \/weekly-summary is now in the slash menu/,
  },
] as const;

for (const item of cases) {
  test(`a streaming ${item.kind} proposal has no decision controls`, async ({
    app,
    screen,
  }) => {
    await app.open(fixture(item.kind, "streaming"));
    const proposal = screen.getByRole("region", "Proposal");
    await expect(
      proposal.getByText(item.streaming, { exact: true }),
    ).toBeVisible();
    await expect(proposal.getByRole("button")).toHaveCount(0);
    await expect(screen.getByRole("status", "Tool events")).toHaveText("[]");
  });

  test(`declining a ${item.kind} proposal replies exactly once without a write`, async ({
    app,
    screen,
  }) => {
    await app.open(fixture(item.kind));
    const attempts = screen.getByRole("status", "Write attempts");
    const events = screen.getByRole("status", "Tool events");
    await expect(events).toHaveText("[]");
    await screen.getByRole("button", item.decline, { exact: true }).click();
    await expect(events).toHaveText(
      JSON.stringify([{ type: "answer", answer: item.declineAnswer }]),
    );
    await expect(attempts).toHaveText("0");
  });

  test(`an invalid ${item.kind} proposal reports its problems once across refreshed inputs`, async ({
    app,
    browser,
    screen,
  }) => {
    await app.open(fixture(item.kind, "invalid"));
    const events = screen.getByRole("status", "Tool events");
    await expect(events).toHaveText(item.invalid);
    await expect(
      screen.getByRole("region", "Proposal").getByRole("button"),
    ).toHaveCount(0);
    const refresh = screen.getByRole("button", "Refresh proposal", {
      exact: true,
    });
    for (let revision = 1; revision <= 3; revision += 1) {
      await refresh.click();
      await expect(screen.getByRole("status", "Fixture revision")).toHaveText(
        String(revision),
      );
    }
    const recorded = await browser.evaluate(() =>
      JSON.parse(
        document.querySelector('output[aria-label="Tool events"]')
          ?.textContent ?? "null",
      ),
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0].type).toBe("answer");
    expect(recorded[0].answer).toMatch(item.invalid);
    await expect(screen.getByRole("status", "Write attempts")).toHaveText("0");
  });

  test(`a refused ${item.kind} proposal stays open and resumes after a successful retry`, async ({
    app,
    screen,
  }) => {
    await app.open(fixture(item.kind, "retry"));
    const create = screen.getByRole("button", "Create it", { exact: true });
    const events = screen.getByRole("status", "Tool events");
    await create.click();
    await expect(screen.getByText(item.refusal, { exact: true })).toBeVisible();
    await expect(events).toHaveText("[]");
    await expect(create).toBeEnabled();
    await create.click();
    await expect(events).toHaveText(item.success);
    await expect(screen.getByRole("status", "Write attempts")).toHaveText("2");
    await expect(
      screen.getByRole("button", item.decline, { exact: true }),
    ).toBeDisabled();
  });
}

test("Bot instructions can be read to the end before creating a private Bot", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture("bot"));
  const lastLine =
    "Where an invoice is disputed rather than late, say so and stop.";
  const instructions = screen.getByText(
    new RegExp(lastLine.replace(/\.$/, "\\.")),
  );
  await expect(instructions).toBeVisible();
  await expect(
    screen.getByText("Create Renewal Desk", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("Accounts Receivable", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("/find-a-document, /check-a-claim", { exact: true }),
  ).toBeVisible();
  expect(
    await browser.evaluate((ending) => {
      const paragraph = [...document.querySelectorAll("p")].find((element) =>
        element.textContent?.endsWith(ending),
      );
      if (!paragraph) throw new Error("No proposal instructions");
      paragraph.scrollTop = paragraph.scrollHeight;
      return {
        scrolls:
          getComputedStyle(paragraph).overflowY === "auto" &&
          paragraph.scrollTop > 0,
        reachesEnd:
          Math.abs(
            paragraph.scrollHeight -
              paragraph.clientHeight -
              paragraph.scrollTop,
          ) <= 1,
      };
    }, lastLine),
  ).toEqual({ scrolls: true, reachesEnd: true });
  const events = screen.getByRole("status", "Tool events");
  await expect(events).toHaveText("[]");
  await screen.getByRole("button", "Create it", { exact: true }).click();
  await expect(events).toHaveText(cases[0].success);
  await expect(screen.getByRole("status", "Write attempts")).toHaveText("1");
});

test("a Bot proposal names each Skill that could not be granted", async ({
  app,
  screen,
}) => {
  await app.open(fixture("bot", "partial"));
  await screen.getByRole("button", "Create it", { exact: true }).click();
  await expect(screen.getByRole("status", "Tool events")).toHaveText(
    /"type":"answer".*It holds \/find-a-document\. \/check-a-claim could not be put on it/,
  );
});

test("a Bot proposal restored from chat history opens the created Bot's profile", async ({
  app,
  screen,
}) => {
  await app.open(fixture("bot", "history"));
  const profile = screen.getByRole("link", "Open Renewal Desk", {
    exact: true,
  });
  await expect(profile).toHaveAttribute("href", "/bots/agent_1");
  await profile.click();
  await expect(
    screen.getByRole("heading", "Renewal Desk profile", { exact: true }),
  ).toBeVisible();
});

test("a Skill shows the full draft and saves its checked fields before resuming", async ({
  app,
  browser,
  screen,
}) => {
  await app.open(fixture("skill"));
  const values = {
    slug: "weekly-summary",
    title: "Weekly summary",
    summary: "Say what moved this week.",
    instructions: "List what moved this week, newest first. Name each source.",
    tools: ["google-drive/search_files"],
  };
  for (const text of [
    values.instructions,
    `/${values.slug}`,
    values.tools[0],
    "Nothing is saved until you say so.",
  ]) {
    await expect(screen.getByText(text, { exact: true })).toBeVisible();
  }
  const events = screen.getByRole("status", "Tool events");
  await expect(events).toHaveText("[]");
  await screen.getByRole("button", "Create it", { exact: true }).click();
  await expect(events).toHaveText(cases[1].success);
  const recorded = await browser.evaluate(() =>
    JSON.parse(
      document.querySelector('output[aria-label="Tool events"]')?.textContent ??
        "null",
    ),
  );
  expect(recorded).toEqual([
    { type: "save", values },
    {
      type: "answer",
      answer:
        "Saved. /weekly-summary is now in the slash menu. It is on no Bot yet — putting it on one is done from the Skills page, so tell the person that is the remaining step.",
    },
  ]);
});

test("an existing Skill is offered as a replacement", async ({
  app,
  screen,
}) => {
  await app.open(fixture("skill", "replace"));
  await expect(screen.getByText(/This replaces Weekly summary/)).toBeVisible();
  await expect(
    screen.getByRole("button", "Create it", { exact: true }),
  ).toHaveCount(0);
  await screen.getByRole("button", "Replace it", { exact: true }).click();
  await expect(screen.getByRole("status", "Tool events")).toHaveText(
    cases[1].success,
  );
});
