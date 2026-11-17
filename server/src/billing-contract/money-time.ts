/**
 * Exact money/time primitives for the billing contract (#62).
 *
 * These are the ONLY sanctioned ways to parse, range-check, round and format
 * billing amounts and microsecond instants. Everything is integer/BigInt math:
 * JavaScript `number` (IEEE-754 double) must never touch a billing amount or
 * timestamp, because int64 magnitudes (> 2^53) and six-decimal displays lose
 * precision in doubles.
 *
 * Lexical contract (mirrors contracts/billing/schemas/scalars.yaml):
 *   - non-negative integers: "0" or digits without leading zeros
 *   - signed deltas: a single leading "-" for negative, no "-0", no "+"
 *   - no exponent, no fraction, no whitespace, no JSON numbers
 *   - inclusive ranges 0..2^63-1 (signed: -2^63+1..2^63-1),
 *     timestamps 0..9999-12-31T23:59:59.999999Z in microseconds
 */

export const MAX_I64 = 9223372036854775807n; // 2^63 - 1
export const MIN_SIGNED_I64 = -9223372036854775807n; // contract floor (NOT -2^63)
export const MAX_TIMESTAMP_US = 253402300799999999n; // 9999-12-31T23:59:59.999999Z
export const MICROUNITS_PER_CREDIT = 1_000_000n;
export const UNKNOWN_USAGE_TTL_US = 24n * 60n * 60n * 1_000_000n; // 24h, never extended

export class BillingValueError extends Error {
  readonly code: "invalid_integer" | "out_of_range";
  constructor(code: "invalid_integer" | "out_of_range", message: string) {
    super(message);
    this.name = "BillingValueError";
    this.code = code;
  }
}

const UNSIGNED_RE = /^(0|[1-9][0-9]{0,18})$/;
const SIGNED_RE = /^(0|[1-9][0-9]{0,18}|-([1-9][0-9]{0,18}))$/;

/** Parse a non-negative integer decimal string ("0"..MAX_I64). */
export function parseUnsigned(s: string, max: bigint = MAX_I64): bigint {
  if (typeof s !== "string" || !UNSIGNED_RE.test(s)) {
    throw new BillingValueError(
      "invalid_integer",
      `not a contract decimal string: ${JSON.stringify(String(s))}`,
    );
  }
  const v = BigInt(s);
  if (v > max) {
    throw new BillingValueError(
      "out_of_range",
      `value ${s} exceeds inclusive maximum ${max}`,
    );
  }
  return v;
}

/** Parse a signed delta string in [-2^63+1, 2^63-1]. Rejects "-0". */
export function parseSigned(s: string): bigint {
  if (typeof s !== "string" || !SIGNED_RE.test(s)) {
    throw new BillingValueError(
      "invalid_integer",
      `not a contract signed decimal string: ${JSON.stringify(String(s))}`,
    );
  }
  const v = BigInt(s);
  if (v < MIN_SIGNED_I64 || v > MAX_I64) {
    throw new BillingValueError(
      "out_of_range",
      `value ${s} outside signed inclusive range`,
    );
  }
  return v;
}

export function parseMicrocredits(s: string): bigint {
  return parseUnsigned(s, MAX_I64);
}

export function parsePositiveMicrocredits(s: string): bigint {
  const v = parseUnsigned(s, MAX_I64);
  if (v === 0n)
    throw new BillingValueError(
      "out_of_range",
      "amount must be strictly positive",
    );
  return v;
}

export function parseFen(s: string): bigint {
  return parseUnsigned(s, MAX_I64);
}

/** Parse a UTC microsecond instant string. */
export function parseTimestampUs(s: string): bigint {
  const v = parseUnsigned(s, MAX_TIMESTAMP_US);
  return v;
}

/** Serialize a bigint back to the contract decimal string (round-trip safe). */
export function formatUnsigned(v: bigint, max: bigint = MAX_I64): string {
  if (v < 0n)
    throw new BillingValueError(
      "out_of_range",
      "negative value is not a valid unsigned decimal",
    );
  if (v > max)
    throw new BillingValueError(
      "out_of_range",
      `value ${v} exceeds inclusive maximum ${max}`,
    );
  return v.toString();
}

/**
 * Display microcredits as the contract's exact six-decimal credit string.
 * "1000123" -> "1.000123"; "1" -> "0.000001"; "0" -> "0.000000".
 * Pure string/BigInt transformation: no floating point anywhere.
 */
export function formatMicrocreditsDisplay(microcredits: bigint): string {
  if (microcredits < 0n)
    throw new BillingValueError(
      "out_of_range",
      "negative balance cannot be displayed",
    );
  const whole = microcredits / MICROUNITS_PER_CREDIT;
  const frac = microcredits % MICROUNITS_PER_CREDIT;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

/**
 * HALF_UP division of an exact rational: round(num/den) to the nearest
 * integer, ties away from zero toward +infinity for positives (contract rule:
 * exact 0.5 microcredit rounds to 1, 0.4 rounds to 0). Applied ONLY after all
 * resources of a step have been summed exactly — never per token.
 */
export function roundHalfUpDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n)
    throw new BillingValueError(
      "invalid_integer",
      "denominator must be positive",
    );
  if (num >= 0n) return (2n * num + den) / (2n * den);
  // negatives (only reachable for theoretical negative deltas): symmetric HALF_UP
  return -((2n * -num + den) / (2n * den));
}

export interface RationalPrice {
  numerator: bigint;
  denominator: bigint;
}

/**
 * Cost of ONE resource line: quantity * (numerator / denominator) microcredits,
 * exact rational (no intermediate rounding).
 */
export function lineCostExact(quantity: bigint, price: RationalPrice): bigint {
  if (price.denominator <= 0n)
    throw new BillingValueError(
      "invalid_integer",
      "price denominator must be positive",
    );
  if (price.numerator < 0n)
    throw new BillingValueError(
      "invalid_integer",
      "price numerator must be non-negative",
    );
  if (quantity < 0n)
    throw new BillingValueError(
      "invalid_integer",
      "usage quantity must be non-negative",
    );
  return quantity * price.numerator; // exact; division deferred to the step sum
}

/**
 * Step cost: sum ALL resource lines exactly, THEN round HALF_UP to whole
 * microcredits. Example (contract fixtures): exact 0.0000005 credit -> 1
 * microcredit; exact 0.0000004 credit -> 0 microcredits.
 */
export function stepCostMicrocredits(
  lines: { quantity: bigint; price: RationalPrice }[],
): bigint {
  const den = lines.reduce((acc, l) => acc * l.price.denominator, 1n);
  const num = lines.reduce(
    (acc, l) =>
      acc + l.quantity * l.price.numerator * (den / l.price.denominator),
    0n,
  );
  return roundHalfUpDiv(num, den);
}

/** unknown_usage_deadline_us = reserved_at_us + 24h at most. */
export function unknownUsageDeadlineUs(reservedAtUs: bigint): bigint {
  const d = reservedAtUs + UNKNOWN_USAGE_TTL_US;
  if (d > MAX_TIMESTAMP_US)
    throw new BillingValueError(
      "out_of_range",
      "deadline out of representable range",
    );
  return d;
}

/**
 * Derive an ISO-8601 string from a microsecond integer ONLY (six fractional
 * digits). Never accepts or produces floating point values.
 */
export function timestampUsToIso(us: bigint): string {
  if (us < 0n || us > MAX_TIMESTAMP_US) {
    throw new BillingValueError(
      "out_of_range",
      `timestamp ${us} outside 1970..9999 range`,
    );
  }
  const millis = us / 1000n;
  const microRemainder = (us % 1000n).toString().padStart(3, "0");
  const msDate = new Date(Number(millis)); // integer milliseconds only, < 2^53
  if (!Number.isSafeInteger(Number(millis))) {
    throw new BillingValueError("out_of_range", "timestamp not representable");
  }
  return `${msDate.toISOString().replace("Z", "")}${microRemainder}Z`;
}

/** Parse-free comparison: is `a` strictly before `b` (both contract strings)? */
export function isBefore(a: string, b: string): boolean {
  return parseTimestampUs(a) < parseTimestampUs(b);
}

export interface LotSplit {
  granted_microcredits: bigint;
  available_microcredits: bigint;
  reserved_microcredits: bigint;
  refund_frozen_microcredits: bigint;
  consumed_microcredits: bigint;
  expired_microcredits: bigint;
  revoked_microcredits: bigint;
}

/**
 * Credit-lot conservation invariant:
 * granted = available + reserved + refund_frozen + consumed + expired + revoked,
 * every term non-negative.
 */
export function lotConserves(split: LotSplit): boolean {
  const terms = [
    split.available_microcredits,
    split.reserved_microcredits,
    split.refund_frozen_microcredits,
    split.consumed_microcredits,
    split.expired_microcredits,
    split.revoked_microcredits,
  ];
  if (terms.some((t) => t < 0n)) return false;
  return terms.reduce((a, b) => a + b, 0n) === split.granted_microcredits;
}
