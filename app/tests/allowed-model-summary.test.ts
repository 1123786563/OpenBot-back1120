import { expect, test } from "bun:test";
import { allowedSummary } from "@/components/admin/controls/model-sections";

test("the allowed-models row names the first few models", () => {
  expect(allowedSummary([])).toBe("None listed");
  expect(allowedSummary(["openai/a", "openai/b"])).toBe("openai/a, openai/b");
  expect(
    allowedSummary(["openai/a", "openai/b", "openai/c", "openai/d", "x/e"]),
  ).toBe("openai/a, openai/b, openai/c and 2 more");
});
