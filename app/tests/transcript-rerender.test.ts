import { expect, test } from "bun:test";
import { sameToolRow } from "@/components/channels/chat-transcript";

const step = (id: string, result?: string) => ({
  kind: "tool" as const,
  id,
  toolCall: {
    id,
    type: "function" as const,
    function: { name: "web_search", arguments: '{"q":"x"}' },
  },
  result,
});

test("a rebuilt but identical tool row is the same row", () => {
  const props = {
    id: "group:a",
    active: false,
    inFlight: false,
    latest: false,
    spokeAfter: false,
  };
  expect(
    sameToolRow(
      { ...props, steps: [step("a", "done")] },
      { ...props, steps: [step("a", "done")] },
    ),
  ).toBe(true);
  expect(
    sameToolRow(
      { ...props, steps: [step("a")] },
      { ...props, steps: [step("a", "done")] },
    ),
  ).toBe(false);
  expect(
    sameToolRow(
      { ...props, steps: [step("a", "done")] },
      { ...props, steps: [step("a", "done"), step("b")] },
    ),
  ).toBe(false);
  expect(
    sameToolRow(
      { ...props, steps: [step("a", "done")] },
      { ...props, active: true, steps: [step("a", "done")] },
    ),
  ).toBe(false);
  expect(
    sameToolRow(
      { ...props, steps: [step("a", "done")] },
      { ...props, spokeAfter: true, steps: [step("a", "done")] },
    ),
  ).toBe(false);
  // A subtask's card stops saying it is working when its turn ends, so the row must redraw then.
  expect(
    sameToolRow(
      { ...props, inFlight: true, steps: [step("a")] },
      { ...props, steps: [step("a")] },
    ),
  ).toBe(false);
});
