import { expect, test } from "bun:test";
import { activitySummary } from "@/components/bot-profile/activity";
import type { ActivityItem } from "@/lib/bot-lifecycle/queries";

const routine: ActivityItem = {
  id: "check-releases",
  kind: "routine",
  title: "Check releases",
  detail: null,
  status: "running",
  at: "2026-10-09T10:00:00Z",
  channelId: null,
  needsYou: false,
  stoppable: false,
  cancellable: false,
};

const scheduled = [{ ...routine, status: "scheduled" }];
const onDemand: ActivityItem[] = [
  {
    ...routine,
    id: "watch-releases",
    kind: "responsibility",
    title: "Watch OpenBot releases",
    detail: "Runs when asked",
    status: "active",
  },
];
const empty = { inProgress: [], scheduled: [], completed: [] };

test("the activity summary counts running, scheduled and on-demand work", () => {
  expect(
    activitySummary({
      inProgress: [routine, routine],
      scheduled: [routine, routine, routine],
      completed: [routine],
    }),
  ).toBe("2 in progress · 3 scheduled");
  expect(activitySummary({ ...empty, scheduled })).toBe("1 scheduled");
  expect(activitySummary({ ...empty, scheduled, onDemand })).toBe(
    "1 scheduled · 1 on demand",
  );
  expect(activitySummary({ ...empty, onDemand })).toBe("1 on demand");
});

test("the activity summary distinguishes completed work from an empty history", () => {
  expect(activitySummary({ ...empty, completed: [routine] })).toBe(
    "Nothing running or scheduled",
  );
  expect(activitySummary(empty)).toBe("No tasks, routines or goals yet");
});
