import { expect, test } from "bun:test";
import { summaryOf } from "@/components/setup/setup-checklist";
import type { SetupRow } from "@/lib/setup/queries";

function gap(id: SetupRow["id"], required = false): SetupRow {
  return {
    id,
    scope: "deployment",
    title: id,
    required,
    status: "needs_setup",
    ready: false,
    detail: "",
    fix: null,
  };
}

test("the setup summary counts optional and required gaps with the appropriate grammar", () => {
  expect(summaryOf([gap("chat")])).toBe(
    "OpenBot is ready to use. 1 optional feature isn't set up yet. Each says how to add it.",
  );
  expect(summaryOf([gap("model", true), gap("intelligence", true)])).toBe(
    "2 things need setup, and 2 are required. Set up the required ones first.",
  );
  expect(summaryOf([gap("model", true)])).toBe(
    "1 thing needs setup, and 1 is required. Set up the required one first.",
  );
});
