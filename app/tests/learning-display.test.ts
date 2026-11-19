import { expect, test } from "bun:test";
import {
  readableSkillBody,
  skillBody,
  skillTitle,
} from "@/lib/learning/display";

const NAME = "example-domain-learnmore-navigation";
const DESCRIPTION =
  "Use when the user asks to visit the Example Domain site and follow its Learn more link. Do not use when the task targets a different website or link.";
const SKILL_MD = `---
name: ${NAME}
description: ${DESCRIPTION}
---

# Navigate example.com and follow Learn more link

## Instructions

1. Navigate to https://example.com/
2. On the homepage, click the 'Learn more' link (tag=a)
3. Confirm the page navigates to https://www.iana.org/help/example-domains; no retries or fallback handling are needed since this path has been reliable across 5 independent sessions
`;

test("readable titles split and case a slug from the skill's own words", () => {
  expect(skillTitle(NAME, DESCRIPTION)).toBe(
    "Example domain learn more navigation",
  );
  expect(skillTitle("export-pdf-invoices", "Saves invoices as a PDF.")).toBe(
    "Export PDF invoices",
  );
  expect(skillTitle("github-issue-triage", "Sorts GitHub issues.")).toBe(
    "GitHub issue triage",
  );
  // A name that is already words stays as it is.
  expect(skillTitle("Refund triage", "Sorts refunds.")).toBe("Refund triage");
  expect(skillTitle("invoices")).toBe("Invoices");
});

test("selector notes are taken out of what a person reads, and only those", () => {
  const body = readableSkillBody(
    [
      "1. Click the 'Learn more' link (tag=a)",
      "2. Press Save [tag=button, id=save-button]",
      '3. Type the name (tag=input, name="customer name")',
      "4. Choose the plan `tag=select`",
      "5. Read the total (about $20) and keep it",
      "6. See [the docs](https://example.com) and (step 2)",
    ].join("\n"),
  );
  expect(body).toBe(
    [
      "1. Click the 'Learn more' link",
      "2. Press Save",
      "3. Type the name",
      "4. Choose the plan",
      "5. Read the total (about $20) and keep it",
      "6. See [the docs](https://example.com) and (step 2)",
    ].join("\n"),
  );
  // The stored text the Bot loads is not touched.
  expect(SKILL_MD).toContain("(tag=a)");
});

const skill =
  "---\nname: refunds\ndescription: Issue a refund\n---\n\nCheck the order first.\n";

test("skillBody drops the front matter", () => {
  expect(skillBody(skill)).toBe("Check the order first.");
});

test("front matter with Windows line endings is dropped too", () => {
  const crlf = skill.replace(/\n/g, "\r\n");
  expect(skillBody(crlf)).toBe("Check the order first.");
});
