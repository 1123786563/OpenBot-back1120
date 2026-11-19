import { expect, test } from "bun:test";
import { sharedSectionSentence } from "@/components/plugins/shared-approval-fields";

test("the shared-account explanation distinguishes reads and changes", () => {
  expect(sharedSectionSentence("write", true)).toBe(
    "Anyone who can use this Bot can do this as the shared account.",
  );
  expect(sharedSectionSentence("read", true)).toBe(
    "Anyone who can use this Bot can read what this account can read.",
  );
  expect(sharedSectionSentence("write", false)).toBeNull();
});
