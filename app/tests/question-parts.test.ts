import { expect, test } from "bun:test";
import { partsAnswer } from "@/components/approvals/question-notice";

const parts = [
  {
    header: "Tier name",
    question: "Which paid-tier name?",
    options: ["Pro", "Plus"],
  },
  { header: "Thursday", question: "What is Thursday for?" },
];

test("the whole answer is a line per decision: the option, the words, or both", () => {
  const form = new FormData();
  form.append("part-0", "Pro");
  form.append("part-0", " but only for teams ");
  form.append("part-1", "OpenBot 1.0 only");
  expect(partsAnswer(parts, form)).toBe(
    "Tier name: Pro, but only for teams\nThursday: OpenBot 1.0 only",
  );
});
