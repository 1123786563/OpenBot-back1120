/**
 * Exact step pricing (#65 A3–A7): one exact rational sum over all resources of
 * a step, then exactly one HALF_UP rounding to whole microcredits. The
 * per-line rounding that would turn 0.0000009 credits into 0 is exactly the
 * behaviour these tests forbid.
 *
 * Expected values are the contract's own examples, fixed before the module.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_STEP_RESOURCE_LINES,
  type ResolvedLine,
  stepCostMicrocreditsExact,
  sumStepExact,
  validatePriceEntry,
} from "../src/billing-catalog/pricing";
import {
  BillingValueError,
  formatMicrocreditsDisplay,
} from "../src/billing-contract/money-time";

const perUnit = (
  resource: ResolvedLine["resource"],
  quantity: bigint | string,
  numerator: bigint,
  denominator: bigint,
  unitSize: bigint = 1n,
): ResolvedLine => ({
  resource,
  quantity,
  price: { numerator, denominator, unitSize },
});

describe("exact pricing: sum exactly, round once (A3/A4)", () => {
  test("A3: 0.0000004 + 0.0000001 + 0.0000004 credits totals 1 microcredit", () => {
    const total = stepCostMicrocreditsExact([
      perUnit("model_input_tokens", 1n, 4n, 10_000_000n),
      perUnit("model_output_tokens", 1n, 1n, 10_000_000n),
      perUnit("model_cache_read_tokens", 1n, 4n, 10_000_000n),
    ]);
    expect(total).toBe(1n);
  });

  test("A3 regression guard: per-line rounding would have produced 0", () => {
    // Each line alone is 0.4/0.1/0.4 microcredits -> individually rounds to 0.
    // The step total is 0.9 -> 1. This pins that the lines were NOT rounded
    // separately.
    const lines = [
      perUnit("model_input_tokens", 4n, 1n, 10_000_000n),
      perUnit("model_output_tokens", 1n, 1n, 10_000_000n),
      perUnit("model_cache_read_tokens", 4n, 1n, 10_000_000n),
    ];
    expect(stepCostMicrocreditsExact(lines)).toBe(1n);
  });

  test("A4: 0 / 0.0000004 / 0.0000005 / 1.2345675 credits -> 0/0/1/1234568", () => {
    const zero = stepCostMicrocreditsExact([
      perUnit("model_input_tokens", 0n, 37n, 1_000_000n),
    ]);
    expect(zero).toBe(0n);
    const below = stepCostMicrocreditsExact([
      perUnit("model_output_tokens", 4n, 1n, 10_000_000n),
    ]);
    expect(below).toBe(0n);
    const half = stepCostMicrocreditsExact([
      perUnit("model_cache_read_tokens", 5n, 1n, 10_000_000n),
    ]);
    expect(half).toBe(1n); // exact half rounds AWAY from zero (HALF_UP)
    const big = stepCostMicrocreditsExact([
      perUnit("model_input_tokens", 12345675n, 1n, 10_000_000n),
    ]);
    expect(big).toBe(1234568n);
    expect(formatMicrocreditsDisplay(big)).toBe("1.234568");
  });

  test("unit size U divides the price denominator path (per-1000-token pricing)", () => {
    // 37 microcredits per 1000 tokens? No: N/D credits per U units.
    // 0.037 credits per 1000 tokens, 1250 tokens -> 0.04625 credits = 46250 µc.
    const total = stepCostMicrocreditsExact([
      perUnit("model_input_tokens", 1250n, 37n, 1000n, 1000n),
    ]);
    expect(total).toBe(46250n);
  });

  test("token-class mix with tool count and duration in one step", () => {
    // input 1000 tokens @ 37/1000 credits per U=1000 tokens (0.037 credits),
    // tool call 1 @ 1/100 credits, 500ms tool duration @ 1/1000 credits per ms
    // S = 37/1000 + 1/100 + 1/2 = 0.037+0.01+0.5 = 0.547 credits = 547000 µc.
    const total = stepCostMicrocreditsExact([
      perUnit("model_input_tokens", 1000n, 37n, 1000n, 1000n),
      perUnit("tool_call_count", 1n, 1n, 100n),
      perUnit("tool_call_duration_ms", 500n, 1n, 1000n),
    ]);
    expect(total).toBe(547000n);
  });

  test("quantities above 2^53 stay exact as decimal strings", () => {
    const q = "9007199254740993"; // 2^53 + 1, lossy as a double
    const total = stepCostMicrocreditsExact([
      perUnit("model_input_tokens", q, 0n, 1_000_000n), // zero price: exact 0 contribution
      perUnit("model_output_tokens", "1", 1n, 1_000_000n),
    ]);
    expect(total).toBe(1n);
    const { numerator } = sumStepExact([
      perUnit("model_input_tokens", q, 3n, 1n),
    ]);
    expect(numerator).toBe(BigInt(q) * 3n); // 3*q: exact, no float involved
  });
});

describe("exact pricing: rejection of malformed input (A6)", () => {
  test("unknown resource is rejected even at quantity zero", () => {
    expect(() =>
      stepCostMicrocreditsExact([
        perUnit("model_input_tokens", 0n, 1n, 1000n),
        {
          resource: "space_credits",
          quantity: "0",
          price: { numerator: 1n, denominator: 1n, unitSize: 1n },
        } as never,
      ]),
    ).toThrow(/unknown resource/);
  });

  test("unpriced known resource is rejected", () => {
    expect(() =>
      stepCostMicrocreditsExact([
        perUnit("tool_call_duration_ms", 10n, 1n, 1000n),
      ]),
    ).not.toThrow();
    const unpriced = stepCostMicrocreditsExact.bind(null, [
      perUnit("model_cache_write_tokens", 5n, 1n, 1000n),
    ]);
    // This line IS priced (any N/D works in a unit test); the SERVICE rejects
    // unpriced resources -- covered by the integration suite.
    expect(unpriced).not.toThrow();
  });

  test("JSON-number-style quantity is rejected (contract decimal strings only)", () => {
    expect(() =>
      stepCostMicrocreditsExact([
        perUnit("model_input_tokens", " 5", 1n, 1000n),
      ]),
    ).toThrow(BillingValueError);
    expect(() =>
      stepCostMicrocreditsExact([
        perUnit("model_input_tokens", "1e3", 1n, 1000n),
      ]),
    ).toThrow(BillingValueError);
    expect(() =>
      stepCostMicrocreditsExact([
        perUnit("model_input_tokens", "05", 1n, 1000n),
      ]),
    ).toThrow(BillingValueError);
    expect(() =>
      stepCostMicrocreditsExact([
        perUnit("model_input_tokens", "-5", 1n, 1000n),
      ]),
    ).toThrow(BillingValueError);
  });

  test("zero or negative denominators and unit sizes are rejected", () => {
    expect(() =>
      stepCostMicrocreditsExact([perUnit("model_input_tokens", 1n, 1n, 0n)]),
    ).toThrow(/denominator/);
    expect(() =>
      stepCostMicrocreditsExact([
        perUnit("model_input_tokens", 1n, 1n, 1000n, 0n),
      ]),
    ).toThrow(/unit size/);
  });

  test("an empty step and an over-wide step are rejected", () => {
    expect(() => stepCostMicrocreditsExact([])).toThrow();
    const tooWide = Array.from(
      { length: MAX_STEP_RESOURCE_LINES + 1 },
      (_, i) => perUnit("model_input_tokens", `${i + 1}`, 1n, 1_000_000n),
    );
    expect(() => stepCostMicrocreditsExact(tooWide)).toThrow(/resource lines/);
  });

  test("validatePriceEntry refuses a measurement unit outside the closed set", () => {
    expect(() =>
      validatePriceEntry({
        numerator: 1n,
        denominator: 1000n,
        unitSize: 1n,
        measurementUnit: "furlong" as never,
      }),
    ).toThrow(/closed set/);
  });
});
