/**
 * WeChat Pay API v3 signature and resource-decryption primitives (#69).
 *
 * Implements the official algorithm exactly (verified 2026-11-19):
 *  - Request Authorization: RSA-SHA256 over
 *      `HTTP方法\nURL路径(含查询串)\n时间戳\n随机串\n请求正文\n`
 *    with a trailing newline, presented as
 *    `WECHATPAY2-SHA256-RSA2048 mchid="...",nonce_str="...",timestamp="...",serial_no="...",signature="..."`.
 *  - Response / notification verification: same message shape built from the
 *    ACTUAL bytes received (never re-serialized), verified with the platform
 *    material selected by the exact `Wechatpay-Serial` header.
 *  - Notification resource decryption: AES-256-GCM (AEAD_AES_256_GCM) with the
 *    APIv3 key, the 12-byte nonce and associated data; the tag is the final 16
 *    bytes of the base64 ciphertext. Authentication failure here must reject
 *    the event — a bad tag is indistinguishable from a forged payload.
 */

import {
  createDecipheriv,
  createSign,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export class WechatCryptoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WechatCryptoError";
  }
}

export interface RequestSignatureInput {
  readonly method: string;
  /** Path WITH query string, exactly as sent. */
  readonly pathWithQuery: string;
  /** Exact request body bytes as sent ("" for GET). */
  readonly body: string;
  readonly timestampSec: string;
  readonly nonce: string;
  readonly merchantSerial: string;
  readonly mchid: string;
  /** PEM-encoded merchant API private key. */
  readonly privateKeyPem: string;
}

/** Build the complete Authorization header value for one API v3 request. */
export function buildAuthorizationHeader(input: RequestSignatureInput): string {
  const message = signatureMessage(
    input.method,
    input.pathWithQuery,
    input.timestampSec,
    input.nonce,
    input.body,
  );
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  const signature = signer.sign(input.privateKeyPem).toString("base64");
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${input.mchid}",` +
    `nonce_str="${input.nonce}",timestamp="${input.timestampSec}",` +
    `serial_no="${input.merchantSerial}",signature="${signature}"`
  );
}

/** The exact signed message (documented shape, trailing newline included). */
export function signatureMessage(
  method: string,
  pathWithQuery: string,
  timestampSec: string,
  nonce: string,
  body: string,
): string {
  return `${method}\n${pathWithQuery}\n${timestampSec}\n${nonce}\n${body}\n`;
}

export function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

export interface VerifyMessageInput {
  readonly method: string;
  readonly pathWithQuery: string;
  readonly rawBody: string;
  readonly timestampSec: string;
  readonly nonce: string;
  /** Base64 `Wechatpay-Signature` header value. */
  readonly signatureB64: string;
  /** PEM public key of the platform material the Serial header names. */
  readonly publicKeyPem: string;
}

/** Verify a response/notification signature over the exact received bytes. */
export function verifyWechatpaySignature(input: VerifyMessageInput): boolean {
  const message = signatureMessage(
    input.method,
    input.pathWithQuery,
    input.timestampSec,
    input.nonce,
    input.rawBody,
  );
  const verifier = createVerify("RSA-SHA256");
  verifier.update(message);
  try {
    return verifier.verify(input.publicKeyPem, input.signatureB64, "base64");
  } catch {
    return false;
  }
}

/** |now - ts| <= skew, integer seconds; rejects non-numeric timestamps. */
export function timestampWithinWindow(
  nowSec: bigint,
  timestampSec: string,
  skewSec: bigint,
): boolean {
  if (!/^\d{1,12}$/.test(timestampSec)) return false;
  const ts = BigInt(timestampSec);
  const delta = ts > nowSec ? ts - nowSec : nowSec - ts;
  return delta <= skewSec;
}

/** Constant-time comparison of base64 signatures (length-guarded). */
export function signaturesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface EncryptedResourceInput {
  readonly algorithm: string;
  readonly nonce: string;
  readonly associatedData: string | null;
  /** Base64 ciphertext; the final 16 bytes are the GCM tag. */
  readonly ciphertext: string;
  readonly apiv3Key: string;
}

/** Authenticated decryption of a notification resource. Throws on ANY failure. */
export function decryptResource(input: EncryptedResourceInput): Buffer {
  if (input.algorithm !== "AEAD_AES_256_GCM") {
    throw new WechatCryptoError(
      "unknown_algorithm",
      `resource algorithm ${JSON.stringify(input.algorithm)} is not supported`,
    );
  }
  if (!/^[0-9A-Za-z]{12}$/.test(input.nonce)) {
    throw new WechatCryptoError("bad_gcm", "nonce is not 12 ASCII characters");
  }
  if (input.apiv3Key.length !== 32) {
    throw new WechatCryptoError(
      "bad_gcm",
      "APIv3 key must be exactly 32 bytes",
    );
  }
  const data = Buffer.from(input.ciphertext, "base64");
  if (data.length <= 16) {
    throw new WechatCryptoError(
      "bad_gcm",
      "ciphertext too short to carry a GCM tag",
    );
  }
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(input.apiv3Key, "utf8"),
    Buffer.from(input.nonce, "utf8"),
  );
  if (input.associatedData !== null)
    decipher.setAAD(Buffer.from(input.associatedData, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new WechatCryptoError(
      "bad_gcm",
      "authenticated decryption failed (wrong key, tag or associated data)",
    );
  }
}
