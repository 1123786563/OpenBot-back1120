import { describe, expect, test } from "bun:test";
import { BillingValueError } from "../../../src/billing-contract/money-time";
import {
  alipayBeijingTimeToUs,
  beijingBillDateOf,
  optionalAlipayBeijingTimeToUs,
} from "../../../src/payments/alipay/time";

describe("alipay Beijing time conversion", () => {
  test("converts GMT+8 wall clock to UTC microseconds, keeping second precision", () => {
    // 2026-11-19 08:00:00 Beijing = 2026-11-19T00:00:00Z
    expect(alipayBeijingTimeToUs("2026-11-19 08:00:00")).toBe(
      String(Date.UTC(2026, 10, 19, 0, 0, 0) * 1000),
    );
    // The Beijing day boundary: 2026-11-19 23:59:59 Beijing is 15:59:59 UTC.
    expect(alipayBeijingTimeToUs("2026-11-19 23:59:59")).toBe(
      String(Date.UTC(2026, 10, 19, 15, 59, 59) * 1000),
    );
    // Midnight Beijing is the previous UTC day.
    expect(alipayBeijingTimeToUs("2026-11-19 00:00:00")).toBe(
      String(Date.UTC(2026, 10, 18, 16, 0, 0) * 1000),
    );
  });

  test("outputs always carry a zero microsecond tail (source precision)", () => {
    const us = alipayBeijingTimeToUs("2026-01-01 12:30:05");
    expect(us.endsWith("000000")).toBe(true);
  });

  test("rejects impossible calendars, not just wrong shapes", () => {
    expect(() => alipayBeijingTimeToUs("2026-02-30 12:00:00")).toThrow(
      BillingValueError,
    );
    expect(() => alipayBeijingTimeToUs("2026-13-01 12:00:00")).toThrow(
      BillingValueError,
    );
    expect(() => alipayBeijingTimeToUs("2026-11-19 24:00:00")).toThrow(
      BillingValueError,
    );
    expect(() => alipayBeijingTimeToUs("2026-11-19T12:00:00")).toThrow(
      BillingValueError,
    );
    expect(() => alipayBeijingTimeToUs("2026-11-19 12:00")).toThrow(
      BillingValueError,
    );
  });

  test("a missing channel time stays null — never replaced by receiving time", () => {
    expect(optionalAlipayBeijingTimeToUs(null)).toBe(null);
    expect(optionalAlipayBeijingTimeToUs(undefined)).toBe(null);
    expect(optionalAlipayBeijingTimeToUs("")).toBe(null);
    expect(optionalAlipayBeijingTimeToUs("   ")).toBe(null);
    expect(optionalAlipayBeijingTimeToUs("2026-11-19 08:00:00")).toBe(
      String(Date.UTC(2026, 10, 19, 0, 0, 0) * 1000),
    );
  });

  test("bill dates follow the Beijing calendar day", () => {
    // 2026-11-19T16:00:00Z is already 2026-11-20 in Beijing.
    expect(
      beijingBillDateOf(String(Date.UTC(2026, 10, 19, 16, 0, 0) * 1000)),
    ).toBe("2026-11-20");
    expect(
      beijingBillDateOf(String(Date.UTC(2026, 10, 19, 15, 59, 59) * 1000)),
    ).toBe("2026-11-19");
  });
});
