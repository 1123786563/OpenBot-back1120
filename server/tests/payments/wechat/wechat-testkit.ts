/**
 * Controlled WeChat gateway peer for the #69 protocol tests.
 *
 * The ONLY external surface replaced is the WeChat HTTP gateway and the
 * inbound notification POST. Verification, decryption, state mapping, expiry
 * and refund discipline run in the PRODUCTION modules — nothing here is
 * imported by them. The peer generates fresh RSA material per run, signs
 * answers exactly like the official gateway (RSA-SHA256 over
 * `METHOD\nPATH\nTS\nNONCE\nBODY\n`), encrypts notification resources with
 * AES-256-GCM, and records every request so assertions can check method,
 * path, query, signature and body.
 */

import { createCipheriv, generateKeyPairSync, createSign } from "node:crypto";
import type { WechatRawResponse, WechatTransportRequest } from "../../../src/payments/wechat/client.js";
import { signatureMessage } from "../../../src/payments/wechat/crypto.js";

export interface RsaMaterial {
  readonly privatePem: string;
  readonly publicPem: string;
  readonly serial: string;
}

/** Fresh RSA material for the merchant or the platform. */
export function generateRsa(serial: string): RsaMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privatePem: privateKey, publicPem: publicKey, serial };
}

export const TEST_APIV3_KEY = "0123456789abcdef0123456789abcdef"; // exactly 32 bytes, test-only

/** AES-256-GCM encrypt per the official resource rule (peer side only). */
export function encryptResource(
  plaintext: string,
  apiv3Key: string,
  nonce: string,
  associatedData: string | null,
): string {
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiv3Key, "utf8"), Buffer.from(nonce, "utf8"));
  if (associatedData !== null) cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]).toString("base64");
}

export interface RecordedRequest extends WechatTransportRequest {
  readonly authorization: string;
}

export interface PeerAnswer {
  readonly status: number;
  /** JSON body to send; signed when status is 2xx unless `skipSignature`. */
  readonly json?: unknown;
  /** Raw bytes for file downloads (no signature headers per official exception). */
  readonly bytes?: Uint8Array;
  readonly headers?: Record<string, string>;
  /** Fault injection: resolve with an error instead of an answer. */
  readonly fault?: "timeout" | "network_error";
}

export interface ControlledPeerOptions {
  readonly platform: RsaMaterial;
  readonly apiv3Key: string;
  readonly nowUnixSeconds?: () => bigint;
  readonly script?: (request: WechatTransportRequest, authorization: string) => PeerAnswer | Promise<PeerAnswer>;
}

export interface ControlledPeer {
  readonly transport: (request: WechatTransportRequest) => Promise<WechatRawResponse>;
  readonly requests: RecordedRequest[];
  /** Sign one notification payload exactly like the gateway (for inbound POSTs). */
  readonly signNotification: (
    rawBody: string,
    options?: { timestampSec?: string; serial?: string; signatureB64?: string; platform?: RsaMaterial },
  ) => Record<string, string>;
}

export function createControlledPeer(options: ControlledPeerOptions): ControlledPeer {
  const requests: RecordedRequest[] = [];
  const transport = async (request: WechatTransportRequest): Promise<WechatRawResponse> => {
    const authorization = request.headers.authorization ?? "";
    requests.push({ ...request, authorization });
    if (options.script) {
      const answer = await options.script(request, authorization);
      if (answer.fault === "timeout") {
        return new Promise(() => {}); // caller timeout policy resolves it
      }
      if (answer.fault === "network_error") {
        throw new Error("ECONNRESET (peer injected)");
      }
      const url = new URL(request.url);
      const rawBody =
        answer.bytes !== undefined
          ? ""
          : answer.json === undefined
            ? ""
            : JSON.stringify(answer.json);
      if (answer.bytes !== undefined) {
        return {
          status: answer.status,
          headers: answer.headers ?? {},
          bodyBytes: answer.bytes,
        };
      }
      if (answer.status < 200 || answer.status >= 300) {
        return {
          status: answer.status,
          headers: answer.headers ?? {},
          bodyBytes: new TextEncoder().encode(JSON.stringify(answer.json ?? { code: "ERROR" })),
        };
      }
      const now = (options.nowUnixSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000))))();
      const timestampSec = (BigInt(now)).toString();
      const nonce = "peer-nonce-0001";
      const signature = createSign("RSA-SHA256")
        .update(signatureMessage(request.method, `${url.pathname}${url.search}`, timestampSec, nonce, rawBody))
        .sign(options.platform.privatePem)
        .toString("base64");
      return {
        status: answer.status,
        headers: {
          "wechatpay-serial": options.platform.serial,
          "wechatpay-signature": signature,
          "wechatpay-timestamp": timestampSec,
          "wechatpay-nonce": nonce,
          ...(answer.headers ?? {}),
        },
        bodyBytes: new TextEncoder().encode(rawBody),
      };
    }
    return { status: 500, headers: {}, bodyBytes: new TextEncoder().encode("{}") };
  };

  const signNotification: ControlledPeer["signNotification"] = (rawBody, opts = {}) => {
    const platform = opts.platform ?? options.platform;
    const timestampSec = opts.timestampSec ?? "1700000460";
    const nonce = "notification-nonce-01";
    const signature =
      opts.signatureB64 ??
      createSign("RSA-SHA256")
        .update(signatureMessage("POST", "/payment-callbacks/wechat", timestampSec, nonce, rawBody))
        .sign(platform.privatePem)
        .toString("base64");
    return {
      "wechatpay-serial": opts.serial ?? platform.serial,
      "wechatpay-signature": signature,
      "wechatpay-timestamp": timestampSec,
      "wechatpay-nonce": nonce,
    };
  };

  return { transport, requests, signNotification };
}

/** Build a verified-style TRANSACTION.SUCCESS notification envelope + resource. */
export function buildSuccessNotification(
  decryptedPayload: Record<string, unknown>,
  options: {
    apiv3Key?: string;
    eventId?: string;
    eventType?: string;
    associatedData?: string | null;
  } = {},
): { envelope: Record<string, unknown>; resource: Record<string, unknown> } {
  const apiv3Key = options.apiv3Key ?? TEST_APIV3_KEY;
  const resource = {
    algorithm: "AEAD_AES_256_GCM",
    ciphertext: encryptResource(
      JSON.stringify(decryptedPayload),
      apiv3Key,
      "nonce12bytes",
      options.associatedData === undefined ? "transaction" : options.associatedData,
    ),
    associated_data: options.associatedData === undefined ? "transaction" : options.associatedData,
    nonce: "nonce12bytes",
    original_type: "transaction",
  };
  const envelope = {
    id: options.eventId ?? "EV-0001",
    event_type: options.eventType ?? "TRANSACTION.SUCCESS",
    event_time: "2023-11-14T21:41:00+08:00",
    resource_type: "encrypt-resource",
    summary: "支付成功",
    resource,
  };
  return { envelope, resource };
}

/** Fixed test clock: 2023-11-14T13:41:00Z in microseconds. */
export const FIXED_NOW_US = 1_700_000_000_000_000n;
