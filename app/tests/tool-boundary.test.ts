import { expect, test } from "bun:test";
import { toolCallFinal } from "@/components/channels/tool-boundary";

test("a call is final once its arguments are complete, before any result", () => {
  expect(toolCallFinal('{"options": "a, b"}', undefined)).toBe(true);
  expect(toolCallFinal('{"options": ["a", "b"', undefined)).toBe(false);
  expect(toolCallFinal("", undefined)).toBe(false);
  expect(toolCallFinal('{"options": [', "answered")).toBe(true);
});
