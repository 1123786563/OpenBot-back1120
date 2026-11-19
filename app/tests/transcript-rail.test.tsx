import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { Tooltip } from "@base-ui/react/tooltip";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { TranscriptRail } from "@/components/channels/transcript-rail";
import type { Turn } from "@/components/channels/transcript-turns";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const TURNS: Turn[] = [
  { id: "u1", index: 0, prompt: "What changed?", reply: "Two things." },
  { id: "u2", index: 2, prompt: "Why?", reply: "Because." },
  { id: "u3", index: 4, prompt: "And now?", reply: "" },
];

/*
 * The transcript re-renders on every streamed chunk and rebuilds its turns each time. The rail
 * must not redraw a mark per turn for it: only what a mark shows changing redraws it.
 */
test("the rail does not redraw for turns that are rebuilt but the same", () => {
  const marksDrawn = spyOn(Tooltip, "Root");
  const copy = () => TURNS.map((turn) => ({ ...turn }));
  const onJump = () => {};
  const view = render(
    <TranscriptRail active="u3" onJump={onJump} turns={copy()} />,
  );
  const before = marksDrawn.mock.calls.length;
  expect(before).toBe(TURNS.length);

  view.rerender(<TranscriptRail active="u3" onJump={onJump} turns={copy()} />);
  expect(marksDrawn.mock.calls.length).toBe(before);

  const grown = copy();
  grown[2] = { ...TURNS[2], reply: "Now this." } as Turn;
  view.rerender(<TranscriptRail active="u3" onJump={onJump} turns={grown} />);
  expect(marksDrawn.mock.calls.length).toBe(before + 1);
  marksDrawn.mockRestore();
});
