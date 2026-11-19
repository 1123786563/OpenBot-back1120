import { expect, spyOn, test } from "bun:test";
import type { RecordingRow } from "@openbot/shared/recorder-api";
import { QueryClient } from "@tanstack/react-query";
import {
  recordHereMutationOptions,
  stopHereMutationOptions,
} from "@/lib/recorder/mutations";
import {
  RECORDINGS_POLL_MS,
  recorderKeys,
  recordingsQueryOptions,
} from "@/lib/recorder/queries";

const row = (overrides: Partial<RecordingRow>): RecordingRow => ({
  id: "r1",
  title: "Refund an order",
  recordedAt: "2026-11-02T14:30:00.000Z",
  ended: "succeeded",
  reason: null,
  ...overrides,
});

test("the list asks again every few seconds while a recording is still sending, and not otherwise", () => {
  const interval = (ended: RecordingRow["ended"]) => {
    const refetchInterval = recordingsQueryOptions().refetchInterval as (
      query: unknown,
    ) => number | false;
    return refetchInterval({
      state: {
        data: { pages: [{ recordings: [row({ ended })], nextCursor: null }] },
      },
    });
  };
  expect(interval("sending")).toBe(RECORDINGS_POLL_MS);
  expect(interval("succeeded")).toBe(false);
});

test("the list asks again every few seconds while a stopped recording has not reached the backend yet", () => {
  // A recording the Recorder holds and sends later has no row until it lands (OpenBot Desktop, 2026-11-07).
  const refetchInterval = recordingsQueryOptions({ waiting: true })
    .refetchInterval as (query: unknown) => number | false;
  expect(
    refetchInterval({
      state: {
        data: { pages: [{ recordings: [row({})], nextCursor: null }] },
      },
    }),
  ).toBe(RECORDINGS_POLL_MS);
});

test("starting or stopping a recording from OpenBot refreshes the list", async () => {
  const queryClient = new QueryClient();
  const invalidate = spyOn(queryClient, "invalidateQueries");
  for (const options of [
    recordHereMutationOptions(queryClient),
    stopHereMutationOptions(queryClient),
  ]) {
    invalidate.mockClear();
    await options.onSuccess?.(
      undefined as never,
      undefined as never,
      undefined,
      undefined as never,
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: recorderKeys.recordings(),
    });
  }
});
