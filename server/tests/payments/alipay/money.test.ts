import { describe, expect, test } from "bun:test";
import { BillingValueError } from "../../../src/billing-contract/money-time";
import {
  fenToYuan,
  positiveFen,
  yuanMatchesFen,
  yuanToFen,
} from "../../../src/payments/alipay/money";

describe("alipay yuan/fen exact conversion", () => {
  test("the acceptance examples convert exactly", () => {
    expect(yuanToFen("0.01")).toBe(1n);
    expect(yuanToFen("10.10")).toBe(1010n);
    expect(fenToYuan("1")).toBe("0.01");
    expect(fenToYuan("1010")).toBe("10.10");
  });

  test("a yuan string never touches a float", () => {
    // 0.29 * 100 in IEEE doubles is 28.999999999999996 — the exact path disagrees.
    expect(Number("0.29") * 100).not.toBe(29);
    expect(yuanToFen("10.10")).toBe(1010n);
    expect(yuanToFen("0.29")).toBe(29n);
    expect(yuanToFen("100")).toBe(10000n);
  });

  test("formatting is always two decimals", () => {
    expect(fenToYuan("100")).toBe("1.00");
    expect(fenToYuan("1")).toBe("0.01");
    expect(fenToYuan("1234567")).toBe("12345.67");
  });

  test("rejects exponent, sign, whitespace, separators and extra precision", () => {
    for (const bad of [
      "1e2",
      "-1",
      "+1",
      " 1",
      "1 ",
      "1,000",
      "1.234",
      ".5",
      "1.",
      "",
      "01",
    ]) {
      expect(() => yuanToFen(bad)).toThrow(BillingValueError);
    }
  });

  test("rejects out-of-contract-range amounts", () => {
    expect(() => yuanToFen("99999999999999999999999999")).toThrow(
      BillingValueError,
    );
  });

  test("create/refund amounts must be strictly positive", () => {
    expect(positiveFen("1")).toBe(1n);
    expect(() => positiveFen("0")).toThrow(BillingValueError);
  });

  test("channel amount vs order amount compares exactly", () => {
    expect(yuanMatchesFen("10.10", "1010")).toBe(true);
    expect(yuanMatchesFen("10.1", "1010")).toBe(true);
    expect(yuanMatchesFen("10.11", "1010")).toBe(false);
    expect(yuanMatchesFen("not-a-number", "1010")).toBe(false);
    expect(yuanMatchesFen(null, "1010")).toBe(false);
  });
});
