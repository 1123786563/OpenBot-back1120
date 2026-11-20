/**
 * Alipay channel timestamps are Beijing wall-clock strings with second
 * precision ("2026-11-19 21:00:05", GMT+8). The billing contract speaks UTC
 * microseconds. This module converts exactly, keeping the source's second
 * precision (the output always ends in 000000) and never inventing a time:
 * a missing channel timestamp stays null rather than becoming "now".
 */

import {
  BillingValueError,
  parseTimestampUs,
} from "../../billing-contract/money-time";

/** Beijing is UTC+8 all year (no DST since 1991; Alipay defines GMT+8). */
const BEIJING_OFFSET_MINUTES = 8 * 60;

/** "2026-11-19 21:00:05" — the format every Alipay gateway API documents. */
const ALIPAY_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * Convert an Alipay Beijing time string to a contract UTC microsecond
 * instant. The calendar is validated for real (2026-02-30 is rejected), not
 * just for shape.
 */
export function alipayBeijingTimeToUs(s: string): string {
  const m = ALIPAY_TIME_RE.exec(s ?? "");
  if (!m) {
    throw new BillingValueError(
      "invalid_integer",
      `not an alipay Beijing time: ${JSON.stringify(String(s))}`,
    );
  }
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  // Build the UTC instant by subtracting the +08:00 offset from the wall
  // clock, then round-trip through Date to reject impossible dates: any
  // component that rolled over (Feb 30, hour 24, ...) comes back different.
  const asUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour - BEIJING_OFFSET_MINUTES / 60,
    minute,
    second,
  );
  const wallClock = new Date(asUtc + BEIJING_OFFSET_MINUTES * 60_000);
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute ||
    wallClock.getUTCSeconds() !== second
  ) {
    throw new BillingValueError(
      "invalid_integer",
      `not a real Beijing calendar time: ${JSON.stringify(s)}`,
    );
  }
  // Date.UTC returns integral milliseconds (second precision in, so no
  // sub-second loss); scale to microseconds inside the safe-integer range.
  return parseTimestampUs((BigInt(asUtc) * 1000n).toString()).toString();
}

/**
 * Like {@link alipayBeijingTimeToUs} but a null/empty/whitespace channel
 * value stays null — "no payment time reported" is a fact to preserve, not a
 * gap to fill with the receiving time.
 */
export function optionalAlipayBeijingTimeToUs(
  s: string | null | undefined,
): string | null {
  if (s === null || s === undefined) return null;
  if (typeof s !== "string" || s.trim() === "") return null;
  return alipayBeijingTimeToUs(s);
}

/** The Beijing wall-clock date (YYYY-MM-DD) of a UTC microsecond instant. */
export function beijingBillDateOf(instantUs: string): string {
  const us = parseTimestampUs(instantUs);
  const shifted = new Date(
    Number(us / 1000n) + BEIJING_OFFSET_MINUTES * 60_000,
  );
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The Beijing wall-clock string ("YYYY-MM-DD HH:mm:ss") of a UTC microsecond
 * instant, at the gateway's second precision. Sub-second parts are floored,
 * so the deadline never moves LATER than the instant it stands for. This is
 * the inverse of {@link alipayBeijingTimeToUs} and is how the order's expiry
 * becomes the cashier's `time_expire`.
 */
export function usToAlipayBeijingTime(instantUs: string): string {
  const us = parseTimestampUs(instantUs);
  const shifted = new Date(
    Number(us / 1000n) + BEIJING_OFFSET_MINUTES * 60_000,
  );
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    ` ${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`
  );
}
