import { expect, test } from "bun:test";
import type {
  LearningRunSummary,
  PersonalReview,
} from "@openbot/shared/learning";
import { QueryClient } from "@tanstack/react-query";
import { personalReviewQueryOptions } from "@/lib/learning/queries";

test("the review polls every ten seconds while a Learning run is active", () => {
  const client = new QueryClient();
  const options = personalReviewQueryOptions();
  const interval = options.refetchInterval;
  if (typeof interval !== "function")
    throw new Error("Expected a dynamic review interval");
  const queryKey: Parameters<typeof interval>[0]["queryKey"] = options.queryKey;
  const query = client
    .getQueryCache()
    .build<PersonalReview, Error, PersonalReview, typeof queryKey>(client, {
      queryKey,
    });

  for (const [status, expected] of [
    ["batching", 10_000],
    ["queued", 10_000],
    ["succeeded", false],
    ["failed", false],
    [null, false],
  ] satisfies [LearningRunSummary["status"] | null, number | false][]) {
    client.setQueryData<PersonalReview>(options.queryKey, {
      canReview: true,
      autoApprove: false,
      sources: [
        {
          containerId: "user-1",
          kind: "recordings",
          label: "From your recordings",
          proposals: [],
          latestRun:
            status === null
              ? null
              : {
                  id: "run-1",
                  status,
                  trigger: "manual",
                  proposals: null,
                  insights: null,
                  failureCode: null,
                  createdAt: "2026-11-01T00:00:00Z",
                  startedAt: null,
                  completedAt: null,
                },
        },
      ],
    });
    expect(interval(query)).toBe(expected);
  }
  client.clear();
});
