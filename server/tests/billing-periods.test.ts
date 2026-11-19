/**
 * Beijing-time monthly period rules (#65 A8–A10): month-end clamping that
 * always returns to the ORIGINAL day number, half-open boundaries in integer
 * UTC microseconds, microsecond boundary attribution, cross-year anchors,
 * DST-ambiguous wall times, and range rejection.
 *
 * The expected values below are the contract's own examples
 * (docs/design/billing-timezone-mapping.md and clarify A8–A10), NOT outputs of
 * this module: they were fixed first and the module must meet them.
 */
import { describe, expect, test } from "bun:test";
import {
  anchorFromActivation,
  type LocalWallTime,
  localToUtcUs,
  periodBoundary,
  periodByIndex,
  periodOf,
  utcUsToLocal,
} from "../src/billing-catalog/periods";
import { BillingValueError } from "../src/billing-contract/money-time";

const JAN31_2024: LocalWallTime = {
  year: 2024,
  month: 1,
  day: 31,
  hour: 9,
  minute: 30,
  second: 15,
  microsecond: 123456,
};

describe("billing periods: leap-year month-end clamp keeps the original day", () => {
  test("A8: 2024-01-31 09:30:15.123456 anchors 02-29 then 03-31 at the same wall time", () => {
    expect(periodBoundary(JAN31_2024, 0n)).toBe(
      localToUtcUs({
        year: 2024,
        month: 1,
        day: 31,
        hour: 9,
        minute: 30,
        second: 15,
        microsecond: 123456,
      }),
    );
    // B(1) is 2024-02-29 09:30:15.123456 +08 = 2024-02-29T01:30:15.123456Z
    expect(periodBoundary(JAN31_2024, 1n).toString()).toBe("1709170215123456");
    // B(2) restores the original day 31: 2024-03-31T01:30:15.123456Z
    expect(periodBoundary(JAN31_2024, 2n).toString()).toBe("1711848615123456");
    const first = periodByIndex(JAN31_2024, 0n);
    expect(first.startIso).toBe("2024-01-31T01:30:15.123456Z");
    expect(first.endIso).toBe("2024-02-29T01:30:15.123456Z");
  });

  test("A9: common year 2025-01-31 clamps to 02-28 then restores 03-31", () => {
    const anchor: LocalWallTime = {
      year: 2025,
      month: 1,
      day: 31,
      hour: 0,
      minute: 0,
      second: 0,
      microsecond: 0,
    };
    const b1 = periodByIndex(anchor, 1n);
    const b2 = periodByIndex(anchor, 2n);
    expect(b1.startLocal).toEqual({
      year: 2025,
      month: 2,
      day: 28,
      hour: 0,
      minute: 0,
      second: 0,
      microsecond: 0,
    });
    expect(b2.startLocal.day).toBe(31);
    expect(b2.startLocal.month).toBe(3);
    // The clamp never leaks: B(2) comes from the original 31, so the clamped
    // period runs exactly 31 days (Feb 28 00:00 +08 -> Mar 31 00:00 +08),
    // not the 28 days a chained Mar-28 anchor would produce.
    expect(periodBoundary(anchor, 2n) - periodBoundary(anchor, 1n)).toBe(
      BigInt(31 * 86400) * 1_000_000n,
    );
  });

  test("A9: August (31 days) -> September (30) -> October (31), non-zero time kept", () => {
    const anchor: LocalWallTime = {
      year: 2024,
      month: 8,
      day: 31,
      hour: 9,
      minute: 30,
      second: 0,
      microsecond: 1,
    };
    const b1 = periodByIndex(anchor, 1n);
    expect(b1.startLocal).toEqual({
      year: 2024,
      month: 9,
      day: 30,
      hour: 9,
      minute: 30,
      second: 0,
      microsecond: 1,
    });
    expect(periodByIndex(anchor, 2n).startLocal.day).toBe(31);
    expect(periodByIndex(anchor, 2n).startLocal.month).toBe(10);
    // Microsecond fidelity survives every conversion.
    expect(b1.startUs % 1_000_000n).toBe(1n);
  });

  test("A9: cross-year 2024-12-31 -> 2025-01-31 -> 2025-02-28, end boundary restores", () => {
    const anchor: LocalWallTime = {
      year: 2024,
      month: 12,
      day: 31,
      hour: 23,
      minute: 59,
      second: 59,
      microsecond: 999999,
    };
    const b1 = periodByIndex(anchor, 1n);
    const b2 = periodByIndex(anchor, 2n);
    expect(b1.startLocal).toEqual({
      year: 2025,
      month: 1,
      day: 31,
      hour: 23,
      minute: 59,
      second: 59,
      microsecond: 999999,
    });
    expect(b2.startLocal.month).toBe(2);
    expect(b2.startLocal.day).toBe(28);
    // The second period ENDS on the restored 2025-03-31 23:59:59.999999 +08.
    expect(b2.endLocal.month).toBe(3);
    expect(b2.endLocal.day).toBe(31);
    expect(b2.endIso).toBe("2025-03-31T15:59:59.999999Z");
  });
});

describe("billing periods: half-open boundary attribution (A10)", () => {
  const b0 = periodByIndex(JAN31_2024, 0n);
  const b1 = periodByIndex(JAN31_2024, 1n);

  test("occurrence exactly at the end boundary belongs to the NEXT period", () => {
    expect(periodOf(JAN31_2024, b1.startUs).index).toBe(1n);
  });

  test("one microsecond before the boundary stays in the earlier period", () => {
    expect(periodOf(JAN31_2024, b1.startUs - 1n).index).toBe(0n);
  });

  test("one microsecond after the boundary is in the later period", () => {
    expect(periodOf(JAN31_2024, b1.startUs + 1n).index).toBe(1n);
  });

  test("the anchor instant itself opens period 0", () => {
    expect(periodOf(JAN31_2024, b0.startUs).index).toBe(0n);
  });

  test("an occurrence inside the clamped February period is located correctly", () => {
    const mar15 = localToUtcUs({
      year: 2024,
      month: 3,
      day: 15,
      hour: 0,
      minute: 0,
      second: 0,
      microsecond: 0,
    });
    const p = periodOf(JAN31_2024, mar15);
    expect(p.index).toBe(1n);
    expect(p.startIso).toBe("2024-02-29T01:30:15.123456Z");
    expect(p.endIso).toBe("2024-03-31T01:30:15.123456Z");
  });

  test("a long-lived subscription reaches period 100 with the same wall time", () => {
    const p100 = periodByIndex(JAN31_2024, 100n);
    expect(p100.startLocal.year).toBe(2032);
    expect(p100.startLocal.month).toBe(5);
    expect(p100.startLocal.day).toBe(31);
    expect(p100.startLocal.microsecond).toBe(123456);
  });
});

describe("billing periods: rejection and conversion guarantees", () => {
  test("negative period index is rejected", () => {
    expect(() => periodBoundary(JAN31_2024, -1n)).toThrow(BillingValueError);
  });

  test("an absurd period index is rejected instead of silently overflowing", () => {
    expect(() => periodBoundary(JAN31_2024, 100_001n)).toThrow(
      BillingValueError,
    );
  });

  test("an invalid wall time (Feb 30) is rejected", () => {
    expect(() =>
      localToUtcUs({
        year: 2024,
        month: 2,
        day: 30,
        hour: 0,
        minute: 0,
        second: 0,
        microsecond: 0,
      }),
    ).toThrow(BillingValueError);
  });

  test("a nonexistent wall time in the DST spring-forward gap is rejected, not shifted", () => {
    // China DST 1988: 1988-04-17 02:00 -> 03:00; 02:30 never happened.
    expect(() =>
      localToUtcUs({
        year: 1988,
        month: 4,
        day: 17,
        hour: 2,
        minute: 30,
        second: 0,
        microsecond: 0,
      }),
    ).toThrow(/does not exist/);
  });

  test("an ambiguous wall time in the DST fall-back overlap is rejected, not resolved silently", () => {
    // China DST 1988: 1988-09-11 clocks went back; 01:30 happened twice.
    expect(() =>
      localToUtcUs({
        year: 1988,
        month: 9,
        day: 11,
        hour: 1,
        minute: 30,
        second: 0,
        microsecond: 0,
      }),
    ).toThrow(/ambiguous/);
  });

  test("round trip local -> UTC -> local preserves the microsecond", () => {
    const local: LocalWallTime = {
      year: 2024,
      month: 1,
      day: 31,
      hour: 9,
      minute: 30,
      second: 15,
      microsecond: 123456,
    };
    expect(utcUsToLocal(localToUtcUs(local))).toEqual(local);
  });

  test("anchorFromActivation keeps the UTC instant and the Beijing wall time", () => {
    const us = localToUtcUs(JAN31_2024);
    const anchor = anchorFromActivation(us);
    expect(anchor.utcUs).toBe(us);
    expect(anchor.utcIso).toBe("2024-01-31T01:30:15.123456Z");
    expect(anchor.local).toEqual(JAN31_2024);
  });

  test("out-of-range instants are refused by the contract scalar range", () => {
    expect(() => anchorFromActivation(25_340_230_080_000_000_0n)).toThrow(
      BillingValueError,
    );
  });
});
