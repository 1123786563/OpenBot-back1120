import { expect, test } from "bun:test";
import { BROKERED_PROBE_OUTCOMES } from "../../server/src/plugins/store";
import { brokeredProbeCases } from "../../tests/e2e/fixtures/brokered-probe-outcomes";

test("the browser fixture covers every server probe outcome", () => {
  expect(brokeredProbeCases.map(({ outcome }) => outcome)).toEqual([
    ...BROKERED_PROBE_OUTCOMES,
  ]);
});

test("only unreachable and nothing share the same account description", () => {
  const descriptions = new Map<string, string[]>();
  for (const { outcome, description } of brokeredProbeCases) {
    descriptions.set(description, [
      ...(descriptions.get(description) ?? []),
      outcome,
    ]);
  }
  expect(
    [...descriptions.values()].filter((outcomes) => outcomes.length > 1),
  ).toEqual([["nothing", "unreachable"]]);
});
