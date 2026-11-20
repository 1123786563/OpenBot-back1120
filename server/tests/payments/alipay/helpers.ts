/**
 * Test helpers for the alipay protocol suite (#70).
 *
 * Everything cryptographic here is generated per run: no production key
 * material exists in this tree, and the "gateway" is a controlled HTTP
 * service on loopback that records what the real adapter sent. These helpers
 * stand in for the official samples the acceptance criteria name — the RSA2
 * rules they follow were cross-checked against the locked alipay-sdk 4.14.0
 * source (util.js sign, alipay.js checkNotifySign/getSignStr).
 */

import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import {
  type AlipayChannelConfig,
  alipayChannelConfig,
} from "../../../src/payments/alipay/config";
/** A live-shaped channel configuration bound to per-run test key material. */
export function testAlipayConfig(
  material: TestRsaMaterial,
  gatewayUrl: string,
): AlipayChannelConfig {
  return alipayChannelConfig({
    appId: "2021000198765432",
    sellerId: "2088000000000000",
    merchantPrivateKey: material.merchantPrivateKey,
    alipayPublicKey: material.alipayPublicKey,
    gatewayUrl,
    notifyUrl: "https://notify.example.invalid/payment-callbacks/alipay",
    returnUrlWhitelist: ["https://app.example.invalid"],
    statementDownloadHosts: ["download.alipay.com"],
    requestTimeoutMs: 2_000,
  });
}

export interface TestRsaMaterial {
  merchantPrivateKey: string;
  merchantPublicKey: string;
  alipayPrivateKey: string;
  alipayPublicKey: string;
}

/** A fresh RSA-2048 pair per call: merchant signs requests, "Alipay" signs responses. */
export function generateTestRsaMaterial(): TestRsaMaterial {
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const alipay = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    merchantPrivateKey: merchant.privateKey
      .export({
        type: "pkcs8",
        format: "pem",
      })
      .toString(),
    merchantPublicKey: merchant.publicKey
      .export({
        type: "spki",
        format: "pem",
      })
      .toString(),
    alipayPrivateKey: alipay.privateKey
      .export({
        type: "pkcs8",
        format: "pem",
      })
      .toString(),
    alipayPublicKey: alipay.publicKey
      .export({
        type: "spki",
        format: "pem",
      })
      .toString(),
  };
}

/** Official request sign content: sorted keys minus `sign`, empty values dropped. */
export function testSignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

export function testSignRequest(
  params: Record<string, string>,
  privateKey: string,
): string {
  return createSign("RSA-SHA256")
    .update(testSignContent(params), "utf8")
    .sign(privateKey, "base64");
}

export function testVerifyRequest(
  params: Record<string, string>,
  publicKey: string,
): boolean {
  const sign = params.sign;
  if (!sign) return false;
  const content = testSignContent(params);
  try {
    return createVerify("RSA-SHA256")
      .update(content, "utf8")
      .verify(publicKey, sign, "base64");
  } catch {
    return false;
  }
}

/** Verify an async notification per the official rule (sign+sign_type removed). */
export function testVerifyNotification(
  fields: Record<string, string>,
  alipayPublicKey: string,
): boolean {
  const sign = fields.sign;
  if (!sign) return false;
  const content = Object.keys(fields)
    .filter((k) => k !== "sign" && k !== "sign_type" && fields[k] !== "")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("&");
  return createVerify("RSA-SHA256")
    .update(content, "utf8")
    .verify(alipayPublicKey, sign, "base64");
}

/**
 * Build a gateway response exactly as the gateway does: the response node's
 * raw bytes are RSA2-signed and appended as the `sign` member.
 */
export function testSignedGatewayResponse(
  responseKey: string,
  node: Record<string, unknown>,
  alipayPrivateKey: string,
): string {
  // Field order inside the node is the gateway's choice; keep it stable.
  const nodeJson = JSON.stringify(node);
  const sign = createSign("RSA-SHA256")
    .update(nodeJson, "utf8")
    .sign(alipayPrivateKey, "base64");
  return `{"${responseKey}":${nodeJson},"sign":"${sign}"}`;
}

export interface RecordedGatewayRequest {
  path: string;
  form: Record<string, string>;
  rawBody: string;
}

/**
 * A controlled gateway: records every signed request the adapter posts and
 * answers with the scripted responses, in order. Loopback only, per run.
 */
export class ControlledAlipayGateway {
  readonly requests: RecordedGatewayRequest[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private readonly alipayPrivateKey: string) {}

  /** Queue a raw response body for the next request. */
  readonly queued: string[] = [];
  enqueue(responseBody: string): void {
    this.queued.push(responseBody);
  }

  /** Queue a signed, valid response for the next request. */
  enqueueSigned(responseKey: string, node: Record<string, unknown>): void {
    this.enqueue(
      testSignedGatewayResponse(responseKey, node, this.alipayPrivateKey),
    );
  }

  /** Queue a plain business error response, signed. */
  enqueueBusinessError(
    responseKey: string,
    code: string,
    msg: string,
    subCode: string | null,
  ): void {
    const node: Record<string, unknown> = { code, msg };
    if (subCode !== null) node.sub_code = subCode;
    node.sub_msg = "business rule";
    this.enqueueSigned(responseKey, node);
  }

  start(): string {
    const gateway = this;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const rawBody = await request.text();
        const form: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(rawBody)) form[k] = v;
        gateway.requests.push({
          path: new URL(request.url).pathname,
          form,
          rawBody,
        });
        const body = gateway.queued.shift() ?? "";
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
    return `http://127.0.0.1:${this.server.port}/gateway.do`;
  }

  stop(): void {
    this.server?.stop(true);
  }
}

/**
 * A minimal ZIP writer (stored and deflate entries) for bill fixtures:
 * enough to exercise the real central-directory reader end to end.
 */
export function buildTestZip(
  entries: {
    name: string;
    content: Uint8Array;
    /** Deflate the entry (method 8); the default is stored (method 0). */
    deflate?: boolean;
  }[],
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.content);
    // Stored entries carry the content itself; deflate entries carry the
    // raw-deflate stream and declare BOTH sizes (compressed/uncompressed).
    const data = entry.deflate ? Bun.deflateSync(entry.content) : entry.content;
    const method = entry.deflate ? 8 : 0;
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    // version 20, no flags, DOS time/date 0
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed
    lv.setUint32(22, entry.content.length, true); // uncompressed
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const c = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, entry.content.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    c.set(nameBytes, 46);
    central.push(c);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();
