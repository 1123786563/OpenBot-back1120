import { describe, expect, test } from "bun:test";
import {
  alipayNotificationIdentity,
  alipayNotificationView,
  matchNotificationAgainstSnapshot,
  parseAlipayNotifyForm,
  verifyAlipayNotificationFields,
} from "../../../src/payments/alipay/notification";
import {
  generateTestRsaMaterial,
  type TestRsaMaterial,
  testAlipayConfig,
} from "./helpers";

const material: TestRsaMaterial = generateTestRsaMaterial();
const config = testAlipayConfig(material, "http://127.0.0.1/gateway.do");

/** Sign notification fields the way the gateway does. */
function signFields(
  fields: Record<string, string>,
  privateKey: string,
): string {
  const { createSign } = require("node:crypto");
  const content = Object.keys(fields)
    .filter((k) => k !== "sign" && k !== "sign_type" && fields[k] !== "")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("&");
  return createSign("RSA-SHA256")
    .update(content, "utf8")
    .sign(privateKey, "base64");
}

function validFields(): Record<string, string> {
  return {
    app_id: config.appId,
    seller_id: config.sellerId,
    trade_no: "2026111922001400001",
    out_trade_no: "order-2026-1119-0001",
    trade_status: "TRADE_SUCCESS",
    total_amount: "10.10",
    gmt_payment: "2026-11-19 21:00:05",
    notify_id: "2026111922001400009",
    notify_type: "trade_status_sync",
    sign_type: "RSA2",
  };
}

describe("notify form decoding (A3)", () => {
  test("decodes exactly once: encoded characters survive as sent", () => {
    // The gateway sends subject "积分包%2BA" percent-encoded; one decode
    // yields "积分包+A". Decoding twice would yield "积分包+A" mangled
    // further — the verifier must see the single-decoded value.
    const fields = parseAlipayNotifyForm(
      "app_id=x&subject=%E7%A7%AF%E5%88%86%E5%8C%85%2BA&memo=50%25",
    );
    expect(fields.subject).toBe("积分包+A");
    expect(fields.memo).toBe("50%");
  });

  test("repeated keys are refused outright", () => {
    expect(() => parseAlipayNotifyForm("app_id=a&app_id=b&trade_no=t")).toThrow(
      /duplicate/,
    );
  });

  test("an empty body is not a notification", () => {
    expect(() => parseAlipayNotifyForm("")).toThrow();
  });
});

describe("notify verification (A3)", () => {
  test("a correctly signed notification verifies and keeps its facts", () => {
    const fields = validFields();
    fields.sign = signFields(fields, material.alipayPrivateKey);
    const verdict = verifyAlipayNotificationFields(fields, config);
    expect(verdict.kind).toBe("verified");
    if (verdict.kind === "verified") {
      expect(verdict.view.status).toBe("succeeded");
      expect(verdict.view.raw_trade_status).toBe("TRADE_SUCCESS");
      expect(verdict.view.provider_transaction_id).toBe("2026111922001400001");
      expect(verdict.view.total_amount_fen).toBe("1010");
      expect(verdict.view.paid_at_us).toBe(
        String(Date.UTC(2026, 10, 19, 13, 0, 5) * 1000),
      );
      expect(verdict.view.notify_id).toBe("2026111922001400009");
    }
  });

  test("a forged signature (signed by a foreign key) is rejected", () => {
    const fields = validFields();
    fields.sign = signFields(fields, material.merchantPrivateKey);
    const verdict = verifyAlipayNotificationFields(fields, config);
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected")
      expect(verdict.reason).toBe("signature_verification_failed");
  });

  test("a field flipped after signing is rejected", () => {
    const fields = validFields();
    fields.sign = signFields(fields, material.alipayPrivateKey);
    const flipped = { ...fields, total_amount: "0.01" };
    const verdict = verifyAlipayNotificationFields(flipped, config);
    expect(verdict.kind).toBe("rejected");
  });

  test("a notification naming another application is rejected even with a valid signature", () => {
    const fields = validFields();
    fields.app_id = "2021009999999999";
    fields.sign = signFields(fields, material.alipayPrivateKey);
    const verdict = verifyAlipayNotificationFields(fields, config);
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected")
      expect(verdict.reason).toBe("app_id_mismatch");
  });

  test("a foreign seller_id is rejected; an absent one is acceptable", () => {
    const foreign = validFields();
    foreign.seller_id = "2088999900000000";
    foreign.sign = signFields(foreign, material.alipayPrivateKey);
    expect(verifyAlipayNotificationFields(foreign, config).kind).toBe(
      "rejected",
    );

    const absent = validFields();
    delete absent.seller_id;
    absent.sign = signFields(absent, material.alipayPrivateKey);
    expect(verifyAlipayNotificationFields(absent, config).kind).toBe(
      "verified",
    );
  });

  test("an explicit non-CNY currency is rejected; the domestic default is accepted", () => {
    const usd = validFields();
    usd.currency = "USD";
    usd.sign = signFields(usd, material.alipayPrivateKey);
    const verdict = verifyAlipayNotificationFields(usd, config);
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected")
      expect(verdict.reason).toBe("currency_mismatch");

    const cny = validFields();
    cny.currency = "CNY";
    cny.sign = signFields(cny, material.alipayPrivateKey);
    expect(verifyAlipayNotificationFields(cny, config).kind).toBe("verified");
  });

  test("a missing gmt_payment keeps paid_at null — no receiving-time substitution", () => {
    const fields = validFields();
    delete fields.gmt_payment;
    fields.sign = signFields(fields, material.alipayPrivateKey);
    const verdict = verifyAlipayNotificationFields(fields, config);
    if (verdict.kind === "verified") {
      expect(verdict.view.paid_at_us).toBe(null);
    } else {
      throw new Error("expected verified");
    }
  });

  test("a malformed total_amount is a rejection, not a guessed amount", () => {
    const fields = validFields();
    fields.total_amount = "10.101";
    fields.sign = signFields(fields, material.alipayPrivateKey);
    const verdict = verifyAlipayNotificationFields(fields, config);
    expect(verdict.kind).toBe("rejected");
  });

  test("WAIT_BUYER_PAY maps to pending, TRADE_CLOSED to closed", () => {
    expect(
      alipayNotificationView({
        ...validFields(),
        trade_status: "WAIT_BUYER_PAY",
      }).status,
    ).toBe("pending");
    expect(
      alipayNotificationView({ ...validFields(), trade_status: "TRADE_CLOSED" })
        .status,
    ).toBe("closed");
    expect(
      alipayNotificationView({
        ...validFields(),
        trade_status: "TRADE_FINISHED",
      }).status,
    ).toBe("succeeded");
  });
});

describe("business matching for the async consumer (A3)", () => {
  const view = {
    status: "succeeded" as const,
    raw_trade_status: "TRADE_SUCCESS",
    provider_transaction_id: "2026111922001400001",
    merchant_reference: "order-2026-1119-0001",
    total_amount_fen: "1010",
    paid_at_us: "1775000000000000",
    app_id: config.appId,
    seller_id: config.sellerId,
    notify_id: "n-1",
    notify_type: "trade_status_sync",
    notify_time: "2026-11-19 21:00:05",
  };
  const snapshot = {
    merchant_reference: "order-2026-1119-0001",
    amount_fen: "1010",
    currency: "CNY" as const,
    expires_at_us: "1775000000000000",
  };

  test("matching reference and exact amount match", () => {
    expect(matchNotificationAgainstSnapshot(view, snapshot).kind).toBe(
      "matched",
    );
  });

  test("another merchant reference is isolated", () => {
    const result = matchNotificationAgainstSnapshot(
      { ...view, merchant_reference: "other-order" },
      snapshot,
    );
    expect(result).toEqual({
      kind: "mismatched",
      reason: "merchant_reference",
    });
  });

  test("a differing amount is isolated, never forgiven", () => {
    const result = matchNotificationAgainstSnapshot(
      { ...view, total_amount_fen: "1009" },
      snapshot,
    );
    expect(result).toEqual({ kind: "mismatched", reason: "amount" });
  });

  test("an amount-less notification cannot match", () => {
    const result = matchNotificationAgainstSnapshot(
      { ...view, total_amount_fen: null },
      snapshot,
    );
    expect(result).toEqual({ kind: "mismatched", reason: "amount" });
  });
});

describe("notification identity (duplicate / out-of-order, A4)", () => {
  test("notify_id is the primary identity", () => {
    const identity = alipayNotificationIdentity(
      { ...validFields(), notify_id: "n-77" },
      "digest",
    );
    expect(identity.notify_id).toBe("n-77");
    expect(identity.fallback_key).toBe("");
  });

  test("without notify_id the fallback still separates later statuses", () => {
    const paid = alipayNotificationIdentity(
      {
        app_id: "a",
        trade_no: "t",
        trade_status: "TRADE_SUCCESS",
        gmt_payment: "2026-11-19 21:00:05",
      },
      "digest1",
    );
    const closed = alipayNotificationIdentity(
      {
        app_id: "a",
        trade_no: "t",
        trade_status: "TRADE_CLOSED",
        gmt_payment: "2026-11-19 21:05:00",
      },
      "digest2",
    );
    expect(paid.notify_id).toBe(null);
    expect(closed.notify_id).toBe(null);
    expect(paid.fallback_key).not.toBe(closed.fallback_key);
    expect(paid.fallback_key).toContain("TRADE_SUCCESS");
  });

  test("the same message replayed under the fallback keeps one identity", () => {
    const fields = {
      app_id: "a",
      trade_no: "t",
      trade_status: "TRADE_SUCCESS",
      gmt_payment: "2026-11-19 21:00:05",
    };
    expect(alipayNotificationIdentity(fields, "digest").fallback_key).toBe(
      alipayNotificationIdentity(fields, "digest").fallback_key,
    );
  });
});
