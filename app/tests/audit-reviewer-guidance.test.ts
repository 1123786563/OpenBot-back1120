import { expect, test } from "bun:test";
import { auditEventWords } from "@openbot/shared/audit-words";
import {
  type AuditEvent,
  decisionDetails,
  decisionText,
} from "@/components/audit/audit-cells";

const DEALS =
  "Any change to a deal worth more than $100,000 needs a person to approve it.";
const READING = {
  summary: "Asks before any Bot changes a deal worth over $100,000.",
  explanation:
    "The reviewer will ask before a Bot changes a deal worth more than $100,000. It can only apply this when the request or action identifies the deal's value; built-in rules already decide actions such as deleting, sending, sharing, publishing, payments, and security changes.",
  check: { ok: true },
};

test("a guidance save reads on Audit as what was saved and how it was read, and a removal as what went", () => {
  // The payloads the store writes, as server/tests/reviewer-guidance.integration.test.ts reads them back.
  const saveRow: AuditEvent = {
    id: "audit-1",
    actorUserId: "user-admin",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "approval.guidance_changed",
    targetType: "approval_settings",
    targetId: "team",
    createdAt: "2026-11-09T21:16:20.000Z",
    payload: {
      actor: "admin@openbot.test",
      change: "saved",
      before: null,
      after: DEALS,
      reading: { summary: READING.summary, explanation: READING.explanation },
    },
  };
  expect(auditEventWords("approval.guidance_changed")).toBe(
    "Change guidance for auto-review",
  );
  expect(decisionText(saveRow)).toBe("Guidance saved");
  expect(decisionDetails(saveRow)).toEqual([
    `Guidance: “${DEALS}”`,
    `Read as: ${READING.summary}`,
  ]);
  const removal: AuditEvent = {
    ...saveRow,
    id: "audit-2",
    payload: {
      actor: "admin@openbot.test",
      change: "removed",
      before: DEALS,
      after: null,
    },
  };
  expect(decisionText(removal)).toBe("Guidance removed");
  expect(decisionDetails(removal)).toEqual([`Removed: “${DEALS}”`]);
});
