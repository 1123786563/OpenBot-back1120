import { describe, expect, test } from "bun:test";
import {
  signAlipayRequest,
  verifyAlipayNotification,
  verifyAlipayResponse,
} from "../../../src/payments/alipay/signature";
import {
  generateTestRsaMaterial,
  type TestRsaMaterial,
  testSignContent,
  testVerifyNotification,
  testVerifyRequest,
} from "./helpers";

describe("alipay RSA2 rules (per-run test material, no production keys)", () => {
  const material: TestRsaMaterial = generateTestRsaMaterial();

  test("request signature verifies at the boundary over the official content", () => {
    const params: Record<string, string> = {
      app_id: "2021000198765432",
      method: "alipay.trade.query",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: "2026-11-19 21:00:05",
      version: "1.0",
      biz_content: '{"out_trade_no":"order-1"}',
    };
    const sign = signAlipayRequest(params, material.merchantPrivateKey);
    const verified = testVerifyRequest(
      { ...params, sign },
      material.merchantPublicKey,
    );
    expect(verified).toBe(true);
  });

  test("empty values are excluded from the sign content per the official rule", () => {
    const withEmpty = { a: "1", b: "", c: "3" };
    const without = { a: "1", c: "3" };
    expect(testSignContent(withEmpty)).toBe(testSignContent(without));
    const sign = signAlipayRequest(
      { ...withEmpty, app_id: "x", method: "m" },
      material.merchantPrivateKey,
    );
    expect(
      testVerifyRequest(
        { ...withEmpty, app_id: "x", method: "m", sign },
        material.merchantPublicKey,
      ),
    ).toBe(true);
  });

  test("a field flipped after signing fails verification", () => {
    const params: Record<string, string> = {
      app_id: "2021000198765432",
      method: "alipay.trade.query",
      biz_content: '{"out_trade_no":"order-1"}',
    };
    const sign = signAlipayRequest(params, material.merchantPrivateKey);
    const tampered = {
      ...params,
      biz_content: '{"out_trade_no":"order-2"}',
      sign,
    };
    expect(testVerifyRequest(tampered, material.merchantPublicKey)).toBe(false);
  });

  test("non-PEM material is refused outright", () => {
    expect(() => signAlipayRequest({ a: "1" }, "raw-secret-not-pem")).toThrow();
  });

  test("notification verification follows the official exclude-sign-and-sign_type rule", () => {
    const fields: Record<string, string> = {
      app_id: "2021000198765432",
      trade_no: "2026111922001400001",
      out_trade_no: "order-1",
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.10",
      gmt_payment: "2026-11-19 21:00:05",
      notify_id: "2026111922001400002",
      sign_type: "RSA2",
    };
    const content = Object.keys(fields)
      .filter((k) => k !== "sign" && k !== "sign_type")
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("&");
    const { createSign } = require("node:crypto");
    const sign = createSign("RSA-SHA256")
      .update(content, "utf8")
      .sign(material.alipayPrivateKey, "base64");
    const signed = { ...fields, sign };
    expect(testVerifyNotification(signed, material.alipayPublicKey)).toBe(true);
    // And the adapter's own verifier agrees — including the sign_type-kept
    // gateway variant the locked SDK also accepts.
    expect(verifyAlipayNotification(signed, material.alipayPublicKey)).toBe(
      true,
    );
    const changed = { ...signed, total_amount: "0.01" };
    expect(verifyAlipayNotification(changed, material.alipayPublicKey)).toBe(
      false,
    );
  });

  test("response verification uses the SDK's cut rule on the ORIGINAL bytes", () => {
    const node = {
      code: "10000",
      msg: "Success",
      trade_status: "TRADE_SUCCESS",
      out_trade_no: "order-1",
      // A value that itself contains `"sign"`-like text must not confuse the cut.
      memo: 'says "hello"',
    };
    const { createSign } = require("node:crypto");
    const nodeJson = JSON.stringify(node);
    const sign = createSign("RSA-SHA256")
      .update(nodeJson, "utf8")
      .sign(material.alipayPrivateKey, "base64");
    const raw = `{"alipay_trade_query_response":${nodeJson},"sign":"${sign}"}`;
    expect(
      verifyAlipayResponse(
        raw,
        "alipay_trade_query_response",
        material.alipayPublicKey,
      ),
    ).toBe(true);
    // One byte of the response node flipped: no verification.
    const tamperedNode = { ...node, trade_status: "TRADE_FINISHED" };
    const tamperedRaw = `{"alipay_trade_query_response":${JSON.stringify(tamperedNode)},"sign":"${sign}"}`;
    expect(
      verifyAlipayResponse(
        tamperedRaw,
        "alipay_trade_query_response",
        material.alipayPublicKey,
      ),
    ).toBe(false);
    // Re-serializing (different key order) breaks the signature: verification
    // must run on raw bytes, never on a round-tripped object.
    const reordered = `{"alipay_trade_query_response":{"msg":"Success","code":"10000"},"sign":"${sign}"}`;
    expect(
      verifyAlipayResponse(
        reordered,
        "alipay_trade_query_response",
        material.alipayPublicKey,
      ),
    ).toBe(false);
  });
});
