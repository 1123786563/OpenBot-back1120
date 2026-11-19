import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type {
  LearnedSkillDetail,
  PersonalLearningSharing,
  PersonalReview,
} from "../../shared/learning";

const name = "example-domain-learnmore-navigation";
const title = "Example domain learn more navigation";
const description =
  "Use when the user asks to visit the Example Domain site and follow its Learn more link.";
const recordingTitle = "Open example.com and follow Learn more";
const skill: LearnedSkillDetail = {
  name,
  description,
  files: [
    {
      path: "SKILL.md",
      text: [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        "---",
        "",
        "# Navigate example.com",
        "",
        "1. Navigate to https://example.com/",
        "2. On the homepage, click the 'Learn more' link (tag=a)",
      ].join("\n"),
    },
    { path: "steps.md", text: "one two" },
    { path: "logo.png", text: null },
  ],
  recordings: [
    {
      id: "0198a012-a20f-77c0-9e33-8992f18e74b0",
      title: recordingTitle,
      available: true,
    },
  ],
};

const listing: PersonalLearningSharing = {
  mode: "closed",
  sharingAllowed: false,
  skills: [
    { name, description, open: false, approvedBy: "person", sharing: "none" },
    {
      name: "binary-skill",
      description: "A skill with a binary file.",
      open: false,
      approvedBy: "person",
      sharing: "none",
    },
    {
      name: "withdrawn-skill",
      description: "A skill no longer available.",
      open: false,
      approvedBy: "person",
      sharing: "none",
    },
  ],
};
const emptyReview: PersonalReview = {
  canReview: false,
  autoApprove: true,
  sources: [],
};

test("personal Learning displays readable skill files and links to the source recording", async ({
  app,
  browser,
  screen,
}) => {
  const reads: string[] = [];
  const skills = "/api/settings/learning/skills/";
  await browser.route(/\/api\/settings\/learning$/, (route) =>
    route.fulfill({ json: listing }),
  );
  await browser.route(/\/api\/settings\/learning\/review$/, (route) =>
    route.fulfill({ json: emptyReview }),
  );
  await browser.route(
    /\/api\/settings\/learning\/skills\/[^/?#]+$/,
    (route) => {
      const path = new URL(route.request.url).pathname;
      reads.push(path);
      if (path === `${skills}${name}`)
        return route.fulfill({ json: { skill } });
      if (path === `${skills}binary-skill`) {
        return route.fulfill({
          json: {
            skill: {
              name: "binary-skill",
              description: "A skill with a binary file.",
              files: [{ path: "SKILL.md", text: null }],
            },
          },
        });
      }
      return route.fulfill({
        status: 404,
        json: { error: "That skill is no longer there." },
      });
    },
  );

  await app.open("/settings/learning");
  const row = screen.getByRole(
    "button",
    /^Example domain learn more navigation/,
  );
  const dialog = screen.getByRole("dialog");
  await expect(row).toContainText(description);
  await expect(screen.getByText(name, { exact: true })).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  expect(reads).toEqual([]);

  await row.tap();
  await expect(
    dialog.getByRole("heading", title, { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(description, { exact: true })).toBeVisible();
  await expect(dialog.getByText(/click the 'Learn more' link/)).toBeVisible();
  await expect(dialog).toContainText("Navigate to");
  await expect(dialog).not.toContainText("(tag=");
  await expect(dialog).not.toContainText(name);
  await expect(dialog.getByText("SKILL.md", { exact: true })).toHaveCount(0);
  expect(reads).toEqual([`${skills}${name}`]);
  await expect(dialog.getByText("logo.png", { exact: true })).toBeVisible();
  const sourceText = browser.locator('[role="dialog"] pre');
  await expect(sourceText).toHaveCount(1);
  await expect(sourceText).toBeHidden();
  await dialog.getByText("steps.md", { exact: true }).tap();
  await expect(sourceText).toBeVisible();
  await expect(sourceText).toHaveText("one two");

  await dialog.getByRole("button", "Done", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);

  await screen.getByRole("button", /^Binary skill/).tap();
  await expect(dialog.getByText("SKILL.md", { exact: true })).toBeVisible();
  await expect(sourceText).toHaveCount(0);
  await dialog.getByRole("button", "Done", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);

  await screen.getByRole("button", /^Withdrawn skill/).tap();
  const error = dialog.getByRole("alert");
  await expect(error).toContainText("This item is no longer available.");
  await error.getByRole("button", "Details", { exact: true }).tap();
  await expect(error).toContainText("That skill is no longer there.");
  expect(reads).toEqual([
    `${skills}${name}`,
    `${skills}binary-skill`,
    `${skills}withdrawn-skill`,
  ]);
  await dialog.getByRole("button", "Done", { exact: true }).tap();
  await expect(dialog).toHaveCount(0);

  await row.tap();
  await expect(
    dialog.getByRole("heading", "Learned from", { exact: true }),
  ).toBeVisible();
  const recording = dialog.getByRole("link", recordingTitle, { exact: true });
  await expect(recording).toHaveAttribute("href", "/browser?recordings=1");
  await recording.tap();
  await expect(browser).toHaveURL("/browser?recordings=1");
});
