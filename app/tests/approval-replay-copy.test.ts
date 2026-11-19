import { expect, test } from "bun:test";
import {
  backtestHeadline,
  replayWords,
} from "@/components/approvals/describe-rules";
import type { ApprovalBacktest } from "@/lib/approval-rules/queries";

const REPORT: ApprovalBacktest = {
  scanned: 22,
  matched: 4,
  changed: 4,
  removedAsks: 4,
  removedDenied: 1,
  addedAsks: 0,
  fixed: 0,
  changes: [
    {
      id: "audit-1",
      createdAt: "2026-11-09T21:16:20.000Z",
      ownerUserId: "user-ben",
      initiator: { kind: "person", id: null },
      bot: "fixture-sales-bot",
      toolRef: "composio-salesforce/SALESFORCE_UPDATE_OPPORTUNITY",
      effect: "write",
      scope: "composio-salesforce",
      subject: {},
      was: "ask",
      wasSource: "default",
      would: "allow",
      change: "removes_ask",
      person: "deny",
      rule: 1,
      reason: "Rule 1 takes action without asking.",
    },
  ],
};

test("the headline counts what changed and never what a safety requirement decided", () => {
  expect(backtestHeadline(REPORT)).toBe(
    "Would have changed 4 decisions: removes 4 asks, of which 1 a person had denied; adds 0 asks.",
  );
  const none = {
    ...REPORT,
    changed: 0,
    removedAsks: 0,
    removedDenied: 0,
    matched: 2,
    fixed: 2,
  };
  expect(backtestHeadline(none)).toBe("Would have changed no decisions.");
  expect(replayWords(none, true)).toBe(
    "Replayed over the last 22 actions OpenBot checked. These rules are about 2 of them. 2 were decided by a safety requirement, auto-review or a task, which rules don't change. Actions that ran with nothing to check aren't recorded, so a new ask can reach further than this shows.",
  );
});
