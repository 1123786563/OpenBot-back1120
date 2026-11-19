/**
 * Beijing-time monthly billing periods (#65).
 *
 * All boundaries are computed from the ORIGINAL activation anchor's
 * Asia/Shanghai local date-time, never accumulated from a previously clamped
 * month: B(n) clamps the original day number to the target month's length and
 * keeps the original time-of-day, so 2024-01-31 09:30:15.123456 anchors
 * 2024-02-29 09:30:15.123456 and 2024-03-31 09:30:15.123456. A period is the
 * half-open interval [B(n), B(n+1)) in integer UTC microseconds; an event at
 * exactly the end boundary belongs to the NEXT period and the boundary is
 * never rewritten by subtracting a second or a microsecond.
 *
 * The timezone authority is the IANA Asia/Shanghai rules of the platform
 * (through Intl/ECMA-402), never a constant UTC+8 offset: China observed DST
 * 1986–1991, and a fixed offset would silently shift historical anchors. A
 * local wall time that does not exist (spring-forward gap) or occurs twice
 * (fall-back overlap) is REJECTED rather than resolved silently by the
 * runtime. tzdata therefore participates in these results; the consuming
 * release notes must pin the runtime and tzdata version and re-run the
 * historical boundary cases when it changes.
 */

import {
  BillingValueError,
  MAX_TIMESTAMP_US,
  parseTimestampUs,
  timestampUsToIso,
} from "../billing-contract/money-time.js";

export const PERIOD_TIMEZONE = "Asia/Shanghai";

/** The largest period index this module will compute. B(n) and B(n+1) must still be in range. */
export const MAX_PERIOD_INDEX = 100_000n;

export interface LocalWallTime {
  /** Gregorian year, e.g. 2024. */
  year: number;
  /** 1..12. */
  month: number;
  /** 1..daysInMonth(year, month). */
  day: number;
  /** 0..23. */
  hour: number;
  /** 0..59. */
  minute: number;
  /** 0..59. */
  second: number;
  /** 0..999999, kept separately from the millisecond-resolution formatter. */
  microsecond: number;
}

export interface MonthPeriod {
  /** Period index n: the period is [B(n), B(n+1)). B(0) is the anchor itself. */
  index: bigint;
  /** Half-open UTC boundaries in integer microseconds. */
  startUs: bigint;
  endUs: bigint;
  /** B(n) as Asia/Shanghai local wall time (the boundary before conversion). */
  startLocal: LocalWallTime;
  endLocal: LocalWallTime;
  /** ISO-8601 rendering of the UTC boundaries, six fractional digits. */
  startIso: string;
  endIso: string;
}

function assertIntBounded(
  name: string,
  v: number,
  min: number,
  max: number,
): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new BillingValueError(
      "out_of_range",
      `${name} ${v} outside ${min}..${max}`,
    );
  }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      throw new BillingValueError(
        "out_of_range",
        `month ${month} is not 1..12`,
      );
  }
}

function requireLocal(t: LocalWallTime): LocalWallTime {
  assertIntBounded("year", t.year, 1970, 9999);
  assertIntBounded("month", t.month, 1, 12);
  assertIntBounded("day", t.day, 1, daysInMonth(t.year, t.month));
  assertIntBounded("hour", t.hour, 0, 23);
  assertIntBounded("minute", t.minute, 0, 59);
  assertIntBounded("second", t.second, 0, 59);
  assertIntBounded("microsecond", t.microsecond, 0, 999999);
  return t;
}

// ---------------------------------------------------------------------------
// IANA conversion. The formatter resolves one concrete tzdata; tests pin the
// historical boundary expectations so a tzdata change cannot pass silently.
// ---------------------------------------------------------------------------

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: PERIOD_TIMEZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Format an instant (ms precision) into Asia/Shanghai wall-time fields. */
function formatLocal(utcMs: number): LocalWallTime {
  const parts = partsFormatter.formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const raw = parts.find((p) => p.type === type)?.value ?? "";
    // "24" hour values can appear with hourCycle h24 in some runtimes; hour12:false
    // with en-CA yields 00..23, but normalise defensively.
    return Number(raw);
  };
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
    microsecond: 0, // ms precision only; callers carry sub-ms separately
  };
}

/**
 * The tz offset in effect at `utcMs`: local-as-if-UTC minus the UTC instant.
 * Positive east of Greenwich (Asia/Shanghai is +8h = 28_800_000 today).
 */
function tzOffsetMs(utcMs: number): number {
  const local = formatLocal(utcMs);
  return (
    Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    ) - utcMs
  );
}

const HOUR_MS = 3_600_000;

/**
 * Convert Asia/Shanghai wall time to a UTC instant.
 *
 * Fixed-point iteration over the offset, then STRICT verification: the found
 * instant must format back to exactly the requested fields, and no adjacent
 * instant (within one hour) may format to the same fields. A spring-forward
 * gap (no such instant) and a fall-back overlap (two instants) are both
 * rejected as BillingValueError/out_of_range instead of being silently
 * shifted.
 */
export function localToUtcUs(t: LocalWallTime): bigint {
  requireLocal(t);
  const baseMs = Date.UTC(
    t.year,
    t.month - 1,
    t.day,
    t.hour,
    t.minute,
    t.second,
  );
  let utcMs = baseMs - 28_800_000; // first guess: today's +8 offset
  for (let i = 0; i < 8; i++) {
    const next = baseMs - tzOffsetMs(utcMs);
    if (next === utcMs) break;
    utcMs = next;
  }
  const resolved = formatLocal(utcMs);
  const matches =
    resolved.year === t.year &&
    resolved.month === t.month &&
    resolved.day === t.day &&
    resolved.hour === t.hour &&
    resolved.minute === t.minute &&
    resolved.second === t.second;
  if (!matches) {
    throw new BillingValueError(
      "out_of_range",
      `local time ${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}:${t.second} ${PERIOD_TIMEZONE} does not exist (spring-forward gap)`,
    );
  }
  // Overlap check: with a fall-back the earlier instant (one hour back, where
  // the pre-transition offset applies) formats to the same wall time.
  const earlier = utcMs - HOUR_MS;
  if (earlier >= 0) {
    const earlierLocal = formatLocal(earlier);
    const duplicate =
      earlierLocal.year === t.year &&
      earlierLocal.month === t.month &&
      earlierLocal.day === t.day &&
      earlierLocal.hour === t.hour &&
      earlierLocal.minute === t.minute &&
      earlierLocal.second === t.second &&
      tzOffsetMs(earlier) !== tzOffsetMs(utcMs);
    if (duplicate) {
      throw new BillingValueError(
        "out_of_range",
        `local time ${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}:${t.second} ${PERIOD_TIMEZONE} is ambiguous (fall-back overlap)`,
      );
    }
  }
  const microUs = BigInt(t.microsecond);
  const us = BigInt(utcMs) * 1000n + microUs;
  if (us > MAX_TIMESTAMP_US) {
    throw new BillingValueError(
      "out_of_range",
      "converted instant exceeds the contract timestamp range",
    );
  }
  return us;
}

/** UTC microseconds -> Asia/Shanghai wall time, microsecond exact. */
export function utcUsToLocal(us: bigint): LocalWallTime {
  parseTimestampUs(us.toString());
  // Split so the formatter never sees a truncated value: the whole-microsecond
  // remainder is carried outside the millisecond-resolution conversion.
  const microsecond = Number(us % 1_000_000n);
  const msWhole = (us - BigInt(microsecond)) / 1000n;
  const local = formatLocal(Number(msWhole));
  return { ...local, microsecond };
}

/** ISO-8601 with six fractional digits, from the contract's integer-only helper. */
export function periodBoundIso(us: bigint): string {
  return timestampUsToIso(us);
}

// ---------------------------------------------------------------------------
// B(n): month arithmetic from the ORIGINAL anchor, never chained from clamps.
// ---------------------------------------------------------------------------

function addMonths(
  year: number,
  month: number,
  n: bigint,
): { year: number; month: number } {
  const total = BigInt(year) * 12n + BigInt(month - 1) + n;
  const newYear = total / 12n;
  const newMonth = Number(total % 12n) + 1;
  const y = Number(newYear);
  assertIntBounded("year", y, 1, 275760); // JS Date.UTC range guard; range-checked again below
  return { year: y, month: newMonth };
}

/**
 * The n-th period boundary from the original anchor: original year/month + n
 * calendar months, day clamped to the target month's length, original
 * time-of-day preserved. Throws out_of_range for n < 0 or when the boundary
 * leaves the contract timestamp range.
 */
export function periodBoundary(anchor: LocalWallTime, n: bigint): bigint {
  if (n < 0n) {
    throw new BillingValueError("out_of_range", "period index must be >= 0");
  }
  if (n > MAX_PERIOD_INDEX) {
    throw new BillingValueError(
      "out_of_range",
      "period index beyond supported range",
    );
  }
  requireLocal(anchor);
  const { year, month } = addMonths(anchor.year, anchor.month, n);
  const day = Math.min(anchor.day, daysInMonth(year, month));
  return localToUtcUs({
    year,
    month,
    day,
    hour: anchor.hour,
    minute: anchor.minute,
    second: anchor.second,
    microsecond: anchor.microsecond,
  });
}

/**
 * Locate the half-open period [B(n), B(n+1)) containing `occurrenceUs`.
 *
 * Candidate n comes from the local year/month difference, then is corrected by
 * comparing actual boundaries — a clamped short-month anchor never leaks into
 * the estimate (2024-01-31 09:30 belongs to the Feb period, and the Feb period
 * ends on the restored 2024-03-31 boundary, not on a chained Mar 29).
 */
export function periodOf(
  anchor: LocalWallTime,
  occurrenceUs: bigint,
): MonthPeriod {
  requireLocal(anchor);
  const occurrence = parseTimestampUs(occurrenceUs.toString());
  const local = utcUsToLocal(occurrence);
  const rawDiff =
    (BigInt(local.year) - BigInt(anchor.year)) * 12n +
    BigInt(local.month - anchor.month);
  let n = rawDiff < 0n ? 0n : rawDiff;
  if (n > MAX_PERIOD_INDEX) n = MAX_PERIOD_INDEX;
  // Walk to the owning period: at most a couple of corrections from the estimate.
  for (;;) {
    const start = periodBoundary(anchor, n);
    if (occurrence < start) {
      if (n === 0n) {
        throw new BillingValueError(
          "out_of_range",
          "occurrence precedes the original anchor; no period exists before B(0)",
        );
      }
      n -= 1n;
      continue;
    }
    const end = periodBoundary(anchor, n + 1n);
    if (occurrence >= end) {
      n += 1n;
      continue;
    }
    const startLocal = utcUsToLocal(start);
    const endLocal = utcUsToLocal(end);
    return {
      index: n,
      startUs: start,
      endUs: end,
      startLocal,
      endLocal,
      startIso: periodBoundIso(start),
      endIso: periodBoundIso(end),
    };
  }
}

/**
 * Explicit nth-period query used by the period-queries API: builds the full
 [B(n), B(n+1)) descriptor including both local wall times.
 */
export function periodByIndex(anchor: LocalWallTime, n: bigint): MonthPeriod {
  const start = periodBoundary(anchor, n);
  const end = periodBoundary(anchor, n + 1n);
  const startLocal = utcUsToLocal(start);
  const endLocal = utcUsToLocal(end);
  return {
    index: n,
    startUs: start,
    endUs: end,
    startLocal,
    endLocal,
    startIso: periodBoundIso(start),
    endIso: periodBoundIso(end),
  };
}

/**
 * Anchor fields from the confirmed activation instant. The caller (#68) passes
 * the server-confirmed activation microsecond; payment or order times never
 * become anchors. The anchor keeps BOTH the UTC instant and the Asia/Shanghai
 * wall time (original day number and time-of-day).
 */
export function anchorFromActivation(activationUs: bigint): {
  utcUs: bigint;
  utcIso: string;
  local: LocalWallTime;
} {
  const utc = parseTimestampUs(activationUs.toString());
  return {
    utcUs: utc,
    utcIso: periodBoundIso(utc),
    local: utcUsToLocal(utc),
  };
}
