import { expect, test } from "bun:test";
import { previewHeadline } from "@/components/admin/controls/describe-capabilities";
import { decisionText, subjectText } from "@/components/audit/audit-cells";

test("each saved switch reads on Audit as which permission, for whom, and what it was set to", () => {
  const row = (payload: Record<string, unknown>) => ({
    id: "1",
    actorUserId: "admin-1",
    initiatorKind: "person",
    initiatorId: "admin-1",
    eventType: "capability.changed",
    targetType: "capability",
    targetId: "localComputer",
    createdAt: "2026-11-09T17:26:34.000Z",
    payload: { capability: "localComputer", ...payload },
  });
  // One sentence saved three of these, and each read "Change a permission · Allowed".
  const everybody = row({
    title: "Local computer access",
    scopeKind: "organization",
    scopeId: "",
    allowed: false,
  });
  const sales = row({
    title: "Local computer access",
    scopeKind: "group",
    scopeId: "Sales",
    allowed: true,
  });
  expect(subjectText(everybody)).toBe("Local computer access · Everybody");
  expect(decisionText(everybody)).toBe("Turned off");
  expect(subjectText(sales)).toBe("Local computer access · Group: Sales");
  expect(decisionText(sales)).toBe("Granted");
  // A row from before the title was kept names the permission by its key.
  expect(
    subjectText(row({ scopeKind: "role", scopeId: "admin", allowed: true })),
  ).toBe("localComputer · Admins");
});

test("the headline names only what changes", () => {
  expect(
    previewHeadline({
      people: 7,
      losing: 1,
      gaining: 0,
      keeping: 0,
      unchanged: 6,
    }),
  ).toBe("1 person loses access.");
  expect(
    previewHeadline({
      people: 7,
      losing: 0,
      gaining: 2,
      keeping: 1,
      unchanged: 4,
    }),
  ).toBe(
    "2 people gain access and 1 person keeps it through a different switch.",
  );
  expect(
    previewHeadline({
      people: 7,
      losing: 0,
      gaining: 0,
      keeping: 0,
      unchanged: 7,
    }),
  ).toBe("Nobody's access changes.");
});
