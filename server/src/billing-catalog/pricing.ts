/**
 * Exact step pricing (#65).
 *
 * One step's cost is S = Σ(q_i × N_i / (D_i × U_i)) computed as ONE exact
 * rational (BigInt numerator/denominator, reduced with gcd as it grows), then
 * rounded exactly once: HALF_UP(S × 1,000,000) -> whole microcredits, then
 * range-checked as int64. No floating point anywhere; no per-token, per-line
 * or per-stream-fragment rounding. 0.0000004 + 0.0000001 + 0.0000004 credits
 * therefore totals exactly 1 microcredit — the per-line rounding that would
 * produce 0 is exactly the behaviour this module exists to forbid.
 *
 * The caller passes an already-merged final resource vector for the step
 * (adapter duties — non-overlapping token classes, deduplicated stream
 * fragments, microsecond duration totals converted to whole milliseconds once
 * per resource — live in the trusted adapter boundary, not here). Unknown
 * resources are rejected even at quantity zero; a zero-quantity known line is
 * legal and contributes exactly nothing.
 */

import {
  BillingValueError,
  MAX_I64,
  MICROUNITS_PER_CREDIT,
  parseUnsigned,
  roundHalfUpDiv,
} from "../billing-contract/money-time.js";

/** Closed measurement units a price may be expressed per. */
export const MEASUREMENT_UNITS = [
  "token",
  "request",
  "call",
  "millisecond",
] as const;
export type MeasurementUnit = (typeof MEASUREMENT_UNITS)[number];

/** The metered resource keys priced by a version (closed; contract mirrors this). */
export const PRICED_RESOURCES = [
  "model_input_tokens",
  "model_output_tokens",
  "model_cache_read_tokens",
  "model_cache_write_tokens",
  "model_web_search_requests",
  "model_request_count",
  "tool_call_count",
  "tool_call_duration_ms",
] as const;
export type PricedResource = (typeof PRICED_RESOURCES)[number];

/**
 * The ONE measurement unit each resource may be priced per. Tokens are priced
 * per token units (U scales to 1000 where a catalog wants per-1000 pricing);
 * request counts per request, call counts per call, durations per whole
 * millisecond. A version that prices a resource in any other unit is a
 * configuration error, not an alternative reading of the same price.
 */
export const RESOURCE_UNITS: Record<PricedResource, MeasurementUnit> = {
  model_input_tokens: "token",
  model_output_tokens: "token",
  model_cache_read_tokens: "token",
  model_cache_write_tokens: "token",
  model_web_search_requests: "request",
  model_request_count: "request",
  tool_call_count: "call",
  tool_call_duration_ms: "millisecond",
};

/** Hard cap on distinct resource lines per step: bounds denominator growth. */
export const MAX_STEP_RESOURCE_LINES = 64;

/**
 * Denominator ceiling for the exact running fraction. With ≤64 lines whose
 * N/D/U are each < 2^63 the unreduced product could reach 2^63^64 ≈ 2^4032;
 * gcd reduction keeps real catalog fractions far below this, and crossing the
 * ceiling is rejected as out_of_range instead of silently degrading.
 */
const MAX_DENOMINATOR_BITS = 4096n;

export interface PriceEntry {
  /** Rational price: N/D credits per U measurement units, N ≥ 0, D ≥ 1, U ≥ 1. */
  numerator: bigint;
  denominator: bigint;
  unitSize: bigint;
}

export interface ResolvedLine {
  resource: PricedResource;
  /** Non-negative integer quantity in the resource's measurement unit (contract decimal string or bigint). */
  quantity: string | bigint;
  price: PriceEntry;
}

/** Accept a contract decimal string (or a bigint already parsed) as a quantity. */
function requireAmount(value: string | bigint, what: string): bigint {
  const v = typeof value === "bigint" ? value : parseUnsigned(value, MAX_I64);
  if (v < 0n) {
    throw new BillingValueError("out_of_range", `${what} must be non-negative`);
  }
  return v;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function bitLength(v: bigint): bigint {
  return BigInt(v.toString(2).length);
}

/**
 * Sum every line exactly into one fraction, reducing with gcd at each step.
 * All input validation happens here: quantities, numerators, denominators and
 * unit sizes are checked even for zero-quantity lines, so a malformed price
 * can never hide behind an unused line.
 */
export function sumStepExact(lines: ResolvedLine[]): {
  numerator: bigint;
  denominator: bigint;
} {
  if (lines.length === 0) {
    throw new BillingValueError(
      "out_of_range",
      "a step must carry at least one line",
    );
  }
  if (lines.length > MAX_STEP_RESOURCE_LINES) {
    throw new BillingValueError(
      "out_of_range",
      `a step may carry at most ${MAX_STEP_RESOURCE_LINES} resource lines`,
    );
  }
  let num = 0n;
  let den = 1n;
  for (const line of lines) {
    if (!PRICED_RESOURCES.includes(line.resource)) {
      throw new BillingValueError(
        "out_of_range",
        `unknown resource ${String(line.resource)} (quantity zero does not excuse an unpriced resource)`,
      );
    }
    const q = requireAmount(line.quantity, `quantity of ${line.resource}`);
    const { numerator, denominator, unitSize } = line.price;
    requireAmount(numerator, "price numerator");
    requireAmount(denominator, "price denominator");
    requireAmount(unitSize, "price unit size");
    if (denominator === 0n) {
      throw new BillingValueError(
        "invalid_integer",
        "price denominator must be positive",
      );
    }
    if (denominator < 0n || unitSize <= 0n) {
      throw new BillingValueError(
        "invalid_integer",
        "price denominator and unit size must be positive",
      );
    }
    const lineDen = denominator * unitSize;
    // num/den += q * numerator / lineDen
    const newNum = num * lineDen + q * numerator * den;
    const newDen = den * lineDen;
    const g = gcd(newNum, newDen) || 1n;
    num = newNum / g;
    den = newDen / g;
    if (bitLength(den) > MAX_DENOMINATOR_BITS) {
      throw new BillingValueError(
        "out_of_range",
        "exact fraction denominator grew beyond the catalog bound",
      );
    }
  }
  if (den <= 0n) {
    throw new BillingValueError(
      "invalid_integer",
      "fraction denominator must stay positive",
    );
  }
  return { numerator: num, denominator: den };
}

/**
 * Whole microcredits for the step: one HALF_UP rounding of the exact sum,
 * scaled to microcredits, then the int64 ceiling. Exact 0.0000005 credits
 * rounds to 1 microcredit; exact 0.0000004 rounds to 0.
 */
export function stepCostMicrocreditsExact(lines: ResolvedLine[]): bigint {
  const { numerator, denominator } = sumStepExact(lines);
  const scaled = numerator * MICROUNITS_PER_CREDIT;
  const cost = roundHalfUpDiv(scaled, denominator);
  if (cost > MAX_I64) {
    throw new BillingValueError(
      "out_of_range",
      "step cost exceeds the int64 maximum",
    );
  }
  return cost;
}

/**
 * Validation helper for a configured price entry; used at publish time so a
 * broken price never reaches a quote. measurementUnit must be a closed unit.
 */
export function validatePriceEntry(
  entry: PriceEntry & { measurementUnit: MeasurementUnit },
): void {
  if (!MEASUREMENT_UNITS.includes(entry.measurementUnit)) {
    throw new BillingValueError(
      "out_of_range",
      `measurement unit ${String(entry.measurementUnit)} is outside the closed set`,
    );
  }
  requireAmount(entry.numerator, "price numerator");
  requireAmount(entry.denominator, "price denominator");
  requireAmount(entry.unitSize, "price unit size");
  if (entry.denominator === 0n || entry.denominator < 0n) {
    throw new BillingValueError(
      "invalid_integer",
      "price denominator must be positive",
    );
  }
  if (entry.unitSize <= 0n) {
    throw new BillingValueError(
      "invalid_integer",
      "price unit size must be positive",
    );
  }
  if (
    entry.numerator > MAX_I64 ||
    entry.denominator > MAX_I64 ||
    entry.unitSize > MAX_I64
  ) {
    throw new BillingValueError(
      "out_of_range",
      "price fields exceed the int64 maximum",
    );
  }
}
