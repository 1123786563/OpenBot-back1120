import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { latestView } from "@/lib/computers/panel-view";

function call(name: string, id: string): Message {
  return {
    id: `m-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  };
}

test("the view a conversation's last computer call worked in is the one the panel follows", () => {
  expect(latestView([])).toBeUndefined();
  expect(latestView([call("computer_navigate", "a")])?.view).toBe("screen");
  expect(
    latestView([
      call("computer_navigate", "a"),
      call("computer_run_command", "b"),
    ]),
  ).toEqual({ view: "terminal", callId: "b" });
  // Reading or saving a file shows on neither, so the last view stands.
  expect(
    latestView([
      call("computer_run_command", "b"),
      call("computer_read_file", "c"),
    ])?.view,
  ).toBe("terminal");
});
