/**
 * Exact yuan/fen conversion for the alipay channel (#70).
 *
 * Alipay speaks decimal yuan strings ("0.01", "10.10"); the billing contract
 * speaks integer fen strings. The conversion is BigInt string arithmetic — a
 * floating-point multiply by 100 loses precision (10.10 * 100 === 1009.99…)
 * and is forbidden here, as everywhere money moves.
 */

import { BillingValueError, parseFen } from "../../billing-contract/money-time";

/**
 * Plain decimal yuan amount: optional integer part without leading zeros,
 * optional fractional part of at most two digits. At least one digit overall.
 * Exponent notation, signs, whitespace, thousands separators and extra
 * precision are all rejected — the channel never sends them and a value that
 * does not round-trip cannot be audited.
 */
const YUAN_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/;

/** "10.10" -> 1010n, "0.01" -> 1n, "100" -> 10000n. Exact, no floats. */
export function yuanToFen(yuan: string): bigint {
  if (typeof yuan !== "string" || !YUAN_RE.test(yuan)) {
    throw new BillingValueError(
      "invalid_integer",
      `not an alipay decimal yuan amount: ${JSON.stringify(String(yuan))}`,
    );
  }
  const point = yuan.indexOf(".");
  const whole = point === -1 ? yuan : yuan.slice(0, point);
  const fracRaw = point === -1 ? "" : yuan.slice(point + 1);
  const fen = BigInt(whole) * 100n + BigInt(fracRaw.padEnd(2, "0"));
  // Range-check through the contract parser: fen is an i64-bounded unsigned
  // decimal, and a value Alipay could not represent must not pass silently.
  return parseFen(fen.toString());
}

/** 1010n -> "10.10", 1n -> "0.01", 100n -> "1.00". Always two decimals. */
export function fenToYuan(fen: string): string {
  const v = parseFen(fen);
  const whole = v / 100n;
  const frac = (v % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}

/** A create/refund amount must be strictly positive — zero moves nothing. */
export function positiveFen(fen: string): bigint {
  const v = parseFen(fen);
  if (v === 0n) {
    throw new BillingValueError(
      "out_of_range",
      "alipay amount must be strictly positive",
    );
  }
  return v;
}

/**
 * Compare a channel-reported yuan amount against an expected fen string.
 * Both sides go through the exact parsers, so "10.1", "10.10" and "1010"
 * all match each other; anything unparseable on either side is a mismatch,
 * never an error thrown into the comparison path.
 */
export function yuanMatchesFen(yuan: string | null, fen: string): boolean {
  if (yuan === null) return false;
  try {
    return yuanToFen(yuan) === parseFen(fen);
  } catch {
    return false;
  }
}
