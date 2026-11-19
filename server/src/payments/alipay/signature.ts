/**
 * RSA2 (RSA-SHA256, base64) signature rules of the Alipay openapi gateway,
 * implemented over node:crypto per the official signing/verification docs.
 *
 * Three distinct rules live here and must never be mixed:
 *  1. Gateway REQUEST signing — every parameter except `sign` and EMPTY
 *     values, keys sorted ascending, joined `k=v&k=v`, signed RSA2.
 *  2. Async NOTIFICATION verification — the same construction but with BOTH
 *     `sign` and `sign_type` removed (the two keys the gateway adds to a
 *     notify POST).
 *  3. Synchronous RESPONSE verification — the raw response text is cut at the
 *     outermost `"sign"` member and the ORIGINAL bytes are verified. The
 *     response object is never re-serialized for verification: JSON round-
 *     tripping is not byte-stable and a re-serialization would break the
 *     signature of responses Alipay really signed.
 */

import { createSign, createVerify } from "node:crypto";

const RSA2 = "RSA-SHA256";

/** The gateway adds these to signed payloads; they are never themselves signed. */
const REQUEST_SIGN_EXCLUDED = new Set(["sign"]);
const NOTIFY_SIGN_EXCLUDED = new Set(["sign", "sign_type"]);

/**
 * Official sign content: drop excluded keys and empty values, sort remaining
 * keys ascending (byte order), join `key=value` with `&`. No URL encoding —
 * the signature is over the decoded values.
 */
export function alipaySignContent(
  params: Record<string, string>,
  excluded: ReadonlySet<string>,
): string {
  return Object.keys(params)
    .filter((k) => !excluded.has(k) && params[k] !== "" && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

function assertPem(key: string, what: string): void {
  if (!key.includes("-----BEGIN")) {
    throw new Error(
      `alipay ${what} must be PEM material (-----BEGIN...); refusing to sign or verify with it`,
    );
  }
}

/** RSA2-sign gateway request parameters; returns the base64 `sign` value. */
export function signAlipayRequest(
  params: Record<string, string>,
  merchantPrivateKey: string,
): string {
  assertPem(merchantPrivateKey, "merchant private key");
  const content = alipaySignContent(params, REQUEST_SIGN_EXCLUDED);
  return createSign(RSA2)
    .update(content, "utf8")
    .sign(merchantPrivateKey, "base64");
}

/** Verify an async notification's `sign` over its remaining fields. */
export function verifyAlipayNotification(
  params: Record<string, string>,
  alipayPublicKey: string,
): boolean {
  assertPem(alipayPublicKey, "alipay public key");
  const sign = params.sign;
  if (!sign) return false;
  // Official rule: verify with both `sign` and `sign_type` removed. The
  // locked SDK additionally retries keeping `sign_type` for gateways that
  // signed it; we mirror that second attempt so a gateway-signed sign_type
  // does not read as a forged notification.
  const attempts: ReadonlySet<string>[] = [
    NOTIFY_SIGN_EXCLUDED,
    REQUEST_SIGN_EXCLUDED,
  ];
  for (const excluded of attempts) {
    const content = alipaySignContent(params, excluded);
    try {
      if (
        createVerify(RSA2)
          .update(content, "utf8")
          .verify(alipayPublicKey, sign, "base64")
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

export interface SplitAlipayResponse {
  /** The raw response-node bytes, as cut per the official rule. */
  responseData: string;
  sign: string;
}

/**
 * Cut a synchronous gateway response into the exact string its `sign` covers,
 * WITHOUT re-serializing anything.
 *
 * The rule mirrors alipay-sdk 4.14.0 `AlipaySDK#getSignStr` (verified against
 * the locked source): everything before the `<method>_response` node is
 * dropped, the trailing `,"sign":"..."` member is dropped, and what remains —
 * the response node's ORIGINAL bytes, including its whitespace — is the
 * signed string. The base64 sign value never contains `}`, so cutting at the
 * last `}` never eats signature bytes.
 */
export function splitAlipayResponse(
  raw: string,
  responseKey: string,
): SplitAlipayResponse {
  const trimmed = raw.trim();
  const signMemberIndex = trimmed.lastIndexOf('"sign"');
  if (signMemberIndex === -1) {
    throw new Error("alipay response carries no sign member");
  }
  const parsed = JSON.parse(trimmed) as { sign?: unknown };
  if (typeof parsed.sign !== "string" || parsed.sign === "") {
    throw new Error("alipay response sign member is not a base64 string");
  }
  let validateStr = trimmed;
  const startIndex = trimmed.indexOf(`${responseKey}"`);
  if (startIndex === -1) {
    throw new Error(`alipay response carries no ${responseKey} node`);
  }
  validateStr = validateStr.substring(startIndex + responseKey.length + 1);
  validateStr = validateStr.substring(0, signMemberIndex);
  // Delete everything before the first `{` and after the last `}`.
  validateStr = validateStr.replace(/^[^{]*{/g, "{");
  validateStr = validateStr.replace(/\}([^}]*)$/g, "}");
  return { responseData: validateStr, sign: parsed.sign };
}

/** Verify a synchronous gateway response over its ORIGINAL bytes. */
export function verifyAlipayResponse(
  raw: string,
  responseKey: string,
  alipayPublicKey: string,
): boolean {
  assertPem(alipayPublicKey, "alipay public key");
  let split: SplitAlipayResponse;
  try {
    split = splitAlipayResponse(raw, responseKey);
  } catch {
    return false;
  }
  try {
    return createVerify(RSA2)
      .update(split.responseData, "utf8")
      .verify(alipayPublicKey, split.sign, "base64");
  } catch {
    return false;
  }
}
