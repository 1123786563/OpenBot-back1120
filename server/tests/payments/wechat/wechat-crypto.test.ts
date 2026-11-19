/**
 * Signature / verification / decryption primitives against the official
 * algorithm (#69 AC2). RSA material is generated fresh per run; the message
 * shape, trailing newline, base64 encoding, AES-256-GCM tag handling and the
 * ±300 s window follow the official API v3 specification (verified
 * 2026-11-19; Go SDK v0.2.21 used as the behavioural reference).
 */

import { describe, expect, test } from "bun:test";
import { createSign } from "node:crypto";
import {
  buildAuthorizationHeader,
  decryptResource,
  signatureMessage,
  timestampWithinWindow,
  verifyWechatpaySignature,
  WechatCryptoError,
} from "../../../src/payments/wechat/crypto.js";
import { TEST_APIV3_KEY, encryptResource, generateRsa } from "./wechat-testkit.js";

const merchant = generateRsa("MCHSERIAL00000001");
const platform = generateRsa("PLATSERIAL0000001");

describe("official signature generation", () => {
  test("Authorization header carries the documented fields in order", () => {
    const auth = buildAuthorizationHeader({
      method: "POST",
      pathWithQuery: "/v3/pay/transactions/native",
      body: '{"appid":"wx123"}',
      timestampSec: "1700000460",
      nonce: "nonce-1",
      merchantSerial: merchant.serial,
      mchid: "1900000001",
      privateKeyPem: merchant.privatePem,
    });
    expect(auth.startsWith("WECHATPAY2-SHA256-RSA2048 ")).toBe(true);
    expect(auth).toContain(`mchid="1900000001"`);
    expect(auth).toContain(`nonce_str="nonce-1"`);
    expect(auth).toContain(`timestamp="1700000460"`);
    expect(auth).toContain(`serial_no="${merchant.serial}"`);
    const signature = auth.split(`signature="`)[1]!.replace(/"$/, "");
    expect(signature.length).toBeGreaterThan(300); // RSA-2048 base64
  });

  test("signature covers method, path, timestamp, nonce, body and the trailing newline", () => {
    const message = signatureMessage("POST", "/v3/x?a=b", "1700000460", "n", "body");
    expect(message.endsWith("body\n")).toBe(true);
    const expected = createSign("RSA-SHA256").update(message).sign(merchant.privatePem).toString("base64");
    const auth = buildAuthorizationHeader({
      method: "POST",
      pathWithQuery: "/v3/x?a=b",
      body: "body",
      timestampSec: "1700000460",
      nonce: "n",
      merchantSerial: merchant.serial,
      mchid: "1900000001",
      privateKeyPem: merchant.privatePem,
    });
    expect(auth).toContain(`signature="${expected}"`);
  });
});

describe("official response/notification verification", () => {
  const base = {
    method: "POST",
    pathWithQuery: "/payment-callbacks/wechat",
    rawBody: '{"id":"EV-1"}',
    timestampSec: "1700000460",
    nonce: "n-verify",
  };
  const sign = (message: string, key = platform.privatePem) =>
    createSign("RSA-SHA256").update(message).sign(key).toString("base64");

  test("a correctly signed payload verifies", () => {
    const signature = sign(signatureMessage(base.method, base.pathWithQuery, base.timestampSec, base.nonce, base.rawBody));
    expect(
      verifyWechatpaySignature({ ...base, signatureB64: signature, publicKeyPem: platform.publicPem }),
    ).toBe(true);
  });

  test("one flipped byte in the body breaks verification (AC2 tamper)", () => {
    const signature = sign(signatureMessage(base.method, base.pathWithQuery, base.timestampSec, base.nonce, base.rawBody));
    const tampered = { ...base, rawBody: '{"id":"EV-2"}' };
    expect(
      verifyWechatpaySignature({ ...tampered, signatureB64: signature, publicKeyPem: platform.publicPem }),
    ).toBe(false);
  });

  test("a signature made by a DIFFERENT key fails (probe / forged callback)", () => {
    const signature = sign(signatureMessage(base.method, base.pathWithQuery, base.timestampSec, base.nonce, base.rawBody), merchant.privatePem);
    expect(
      verifyWechatpaySignature({ ...base, signatureB64: signature, publicKeyPem: platform.publicPem }),
    ).toBe(false);
  });

  test("a malformed signature value never throws, only fails", () => {
    expect(
      verifyWechatpaySignature({ ...base, signatureB64: "not-base64!!!", publicKeyPem: platform.publicPem }),
    ).toBe(false);
  });
});

describe("timestamp window (±300 s, inclusive)", () => {
  const now = 1_700_000_460n;
  test.each([
    ["-300", true],
    ["+300", true],
    ["-301", false],
    ["+301", false],
  ])("offset %s seconds is %s", (offset, accepted) => {
    const delta = BigInt(offset);
    expect(timestampWithinWindow(now, (now + delta).toString(), 300n)).toBe(accepted);
  });
  test("non-numeric and empty timestamps are rejected", () => {
    expect(timestampWithinWindow(now, "", 300n)).toBe(false);
    expect(timestampWithinWindow(now, "abc", 300n)).toBe(false);
    expect(timestampWithinWindow(now, "1.5", 300n)).toBe(false);
  });
  test("far-future timestamps are rejected (replay padding)", () => {
    expect(timestampWithinWindow(now, (now + 86_400n).toString(), 300n)).toBe(false);
  });
});

describe("AES-256-GCM resource decryption", () => {
  const plaintext = JSON.stringify({ out_trade_no: "order-1", mchid: "1900000001" });

  test("decrypts an honestly encrypted resource", () => {
    const ciphertext = encryptResource(plaintext, TEST_APIV3_KEY, "nonce12bytes", "transaction");
    const out = decryptResource({
      algorithm: "AEAD_AES_256_GCM",
      nonce: "nonce12bytes",
      associatedData: "transaction",
      ciphertext,
      apiv3Key: TEST_APIV3_KEY,
    });
    expect(out.toString("utf8")).toBe(plaintext);
  });

  test("a wrong GCM tag (bit flip in ciphertext) fails authentication", () => {
    const ciphertext = encryptResource(plaintext, TEST_APIV3_KEY, "nonce12bytes", "transaction");
    const raw = Buffer.from(ciphertext, "base64");
    raw[0] ^= 0x01;
    expect(() =>
      decryptResource({
        algorithm: "AEAD_AES_256_GCM",
        nonce: "nonce12bytes",
        associatedData: "transaction",
        ciphertext: raw.toString("base64"),
        apiv3Key: TEST_APIV3_KEY,
      }),
    ).toThrow(WechatCryptoError);
  });

  test("wrong associated data fails authentication", () => {
    const ciphertext = encryptResource(plaintext, TEST_APIV3_KEY, "nonce12bytes", "transaction");
    expect(() =>
      decryptResource({
        algorithm: "AEAD_AES_256_GCM",
        nonce: "nonce12bytes",
        associatedData: "refund",
        ciphertext,
        apiv3Key: TEST_APIV3_KEY,
      }),
    ).toThrow(WechatCryptoError);
  });

  test("wrong APIv3 key fails authentication", () => {
    const ciphertext = encryptResource(plaintext, TEST_APIV3_KEY, "nonce12bytes", "transaction");
    expect(() =>
      decryptResource({
        algorithm: "AEAD_AES_256_GCM",
        nonce: "nonce12bytes",
        associatedData: "transaction",
        ciphertext,
        apiv3Key: "ffffffffffffffffffffffffffffffff",
      }),
    ).toThrow(WechatCryptoError);
  });

  test("unknown algorithms are refused outright", () => {
    expect(() =>
      decryptResource({
        algorithm: "AEAD_AES_256_GCM_SOMETHING_NEW",
        nonce: "nonce12bytes",
        associatedData: "transaction",
        ciphertext: "AAAA",
        apiv3Key: TEST_APIV3_KEY,
      }),
    ).toThrow(/not supported/);
  });

  test("malformed nonce and short ciphertext are refused", () => {
    expect(() =>
      decryptResource({
        algorithm: "AEAD_AES_256_GCM",
        nonce: "short",
        associatedData: null,
        ciphertext: "AAAA",
        apiv3Key: TEST_APIV3_KEY,
      }),
    ).toThrow(WechatCryptoError);
  });
});
