import { expect, test } from "bun:test";
import type { LearningRunSummary } from "@openbot/shared/learning";
import { runPollInterval } from "@/routes/_authed/admin/learning";

test("runs are polled while one is queued or running", () => {
  const run = (status: LearningRunSummary["status"]): LearningRunSummary => ({
    id: status,
    status,
    trigger: "manual",
    proposals: null,
    insights: null,
    failureCode: null,
    createdAt: "2026-11-05T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
  });
  expect(runPollInterval([run("succeeded"), run("queued")])).toBe(10_000);
  expect(runPollInterval([run("batching")])).toBe(10_000);
  expect(runPollInterval([run("succeeded"), run("failed")])).toBe(false);
  expect(runPollInterval([])).toBe(false);
  expect(runPollInterval(undefined)).toBe(false);
});
