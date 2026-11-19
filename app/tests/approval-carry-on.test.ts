import { expect, test } from "bun:test";
import {
  type ApprovalInboxData,
  carryingOnAfterApproval,
} from "@/lib/approvals";

test("carried-on approvals expire and only count in their own conversation", () => {
  const now = Date.parse("2026-11-08T10:00:00.000Z");
  const threadId = "maps-thread";
  const decided = (minutesAgo: number): ApprovalInboxData => ({
    enabled: true,
    rules: [],
    teamRules: [],
    questions: [],
    requests: [
      {
        id: "approval-1",
        status: "approved",
        createdAt: "2026-11-08T09:00:00.000Z",
        decidedAt: new Date(now - minutesAgo * 60_000).toISOString(),
        action: {
          botId: "maps-bot",
          toolRef: "google-maps/maps_search_places",
          effect: "read",
          scope: "google-maps",
          threadId,
          args: {},
          target: {},
        },
      },
    ],
  });

  expect(carryingOnAfterApproval(decided(1), threadId, now)).toBe(true);
  expect(carryingOnAfterApproval(decided(9), threadId, now)).toBe(true);
  expect(carryingOnAfterApproval(decided(11), threadId, now)).toBe(false);
  expect(carryingOnAfterApproval(decided(1), "another-thread", now)).toBe(
    false,
  );
});
