import { describe, expect, test } from "bun:test";
import {
  ScriptedPaymentStub,
  verifyNotification,
  type CreatePaymentInput,
  type RawNotification,
} from "./payment-adapter-stub.js";

const KEY = "billing62-test-key-do-not-use-in-production";

function input(merchantReference: string): CreatePaymentInput {
  return {
    order_id: "8d9e0f10-a1b2-4c3d-9e4f-6a7b8c9d0e1f",
    merchant_reference: merchantReference,
    amount_fen: "9900",
    currency: "CNY",
    scenario: "h5",
    return_url: "https://app.openbot.invalid/billing/return",
  };
}

describe("ScriptedPaymentStub boundary (#62 requirement §7)", () => {
  test("succeed script emits a correctly signed notification", async () => {
    const stub = new ScriptedPaymentStub(KEY, new Map([["m1", "succeed"]]));
    await stub.create(input("m1"));
    expect(stub.notifications.length).toBe(1);
    expect(
      verifyNotification(stub.notifications[0] as RawNotification, KEY),
    ).toBe("valid");
    const state = await stub.query("m1");
    expect(state.status).toBe("succeeded");
    expect(state.provider_transaction_id).not.toBeNull();
  });

  test("forged callback fails REAL signature verification", () => {
    const stub = new ScriptedPaymentStub(
      KEY,
      new Map([["m2", "bad_signature"]]),
    );
    stub.pushNotification(input("m2"), "bad_signature");
    expect(
      verifyNotification(stub.notifications[0] as RawNotification, KEY),
    ).toBe("bad_signature");
  });

  test("merchant/amount mismatch notifications carry tampered payloads", async () => {
    const stub = new ScriptedPaymentStub(
      KEY,
      new Map([
        ["m3", "merchant_mismatch"],
        ["m4", "amount_mismatch"],
      ]),
    );
    await stub.create(input("m3"));
    await stub.create(input("m4"));
    const body3 = JSON.parse(
      Buffer.from(
        (stub.notifications[0] as RawNotification).raw_payload_b64,
        "base64",
      ).toString(),
    );
    const body4 = JSON.parse(
      Buffer.from(
        (stub.notifications[1] as RawNotification).raw_payload_b64,
        "base64",
      ).toString(),
    );
    expect(body3.merchant_reference).toBe("other_order_reference");
    expect(body4.amount_fen).toBe("1");
  });

  test("lost notification: only query reveals the paid state", async () => {
    const stub = new ScriptedPaymentStub(
      KEY,
      new Map([["m5", "lost_notification"]]),
    );
    await stub.create(input("m5"));
    expect(stub.notifications.length).toBe(0);
    expect((await stub.query("m5")).status).toBe("succeeded");
  });

  test("unknown state stays unknown until the adapter resolves it", async () => {
    const stub = new ScriptedPaymentStub(KEY, new Map([["m6", "unknown"]]));
    await stub.create(input("m6"));
    expect((await stub.query("m6")).status).toBe("unknown");
  });

  test("close race: channel refuses to close an already-paid order", async () => {
    const stub = new ScriptedPaymentStub(KEY, new Map([["m7", "succeed"]]));
    await stub.create(input("m7"));
    const closed = await stub.close("m7");
    expect(closed.status).toBe("succeeded");
  });

  test("refund scripts succeed/fail/unknown through the single adapter surface", async () => {
    const stub = new ScriptedPaymentStub(
      KEY,
      new Map([
        ["r1", "succeed"],
        ["r2", "succeed"],
        ["r3", "succeed"],
        ["r1:refund", "succeed"],
        ["r2:refund", "fail"],
        ["r3:refund", "unknown"],
      ]),
    );
    await stub.create(input("r1"));
    await stub.create(input("r2"));
    await stub.create(input("r3"));
    expect((await stub.refund("r1", "9900")).status).toBe("succeeded");
    expect((await stub.refund("r2", "9900")).status).toBe("failed");
    expect((await stub.refund("r3", "9900")).status).toBe("unknown");
    expect((await stub.queryRefund("ref_00000001")).status).toBe("succeeded");
    expect((await stub.queryRefund("ref_00000003")).status).toBe("unknown");
  });
});
