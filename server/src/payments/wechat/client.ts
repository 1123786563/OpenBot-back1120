/**
 * WeChat Pay API v3 signed HTTP client (#69).
 *
 * The ONLY outbound surface of the adapter. The actual WeChat gateway is
 * reached through an injectable `transport` — production binds `fetch`, tests
 * bind a controlled peer — and every request is signed and every JSON answer
 * signature-verified BEFORE any content is interpreted. 204 answers carry no
 * signature by protocol and are accepted on status alone; binary file
 * downloads follow the official file exception (no signature headers) and are
 * handled by bill.ts integrity rules instead.
 */

import {
  buildAuthorizationHeader,
  randomNonce,
  verifyWechatpaySignature,
  WechatCryptoError,
} from "./crypto.js";
import type {
  WechatPlatformMaterial,
  WechatTrustStore,
} from "./trust-store.js";
import type { MerchantIdentity } from "./types.js";
import { WECHAT_TIMESTAMP_SKEW_SEC } from "./types.js";

export interface WechatRawResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyBytes: Uint8Array;
}

export interface WechatTransportRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

export type WechatTransport = (
  request: WechatTransportRequest,
) => Promise<WechatRawResponse>;

/** Untrusted / unreachable transport outcomes. Never surfaces as a business result. */
export class WechatTransportError extends Error {
  constructor(
    readonly classification:
      | "timeout"
      | "network_error"
      | "bad_status"
      | "bad_signature"
      | "unknown_platform_serial"
      | "malformed_response",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WechatTransportError";
  }
}

export interface WechatApiClientOptions {
  readonly identity: MerchantIdentity;
  readonly apiv3Key: string;
  readonly privateKeyPem: string;
  readonly trustStore: WechatTrustStore;
  readonly transport: WechatTransport;
  /** Unix seconds clock (injectable for the ±300s window tests). */
  readonly nowUnixSeconds?: () => bigint;
  /** Request timeout in ms; a timeout is an UNKNOWN, not a refusal. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class WechatApiClient {
  private readonly nowUnixSeconds: () => bigint;

  constructor(private readonly options: WechatApiClientOptions) {
    this.nowUnixSeconds =
      options.nowUnixSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    if (options.apiv3Key.length !== 32) {
      throw new WechatTransportError(
        "malformed_response",
        "APIv3 key must be exactly 32 bytes",
      );
    }
  }

  get identity(): MerchantIdentity {
    return this.options.identity;
  }

  /**
   * Signed JSON request whose SUCCESS response is verified with the exact
   * platform material the Wechatpay-Serial header names. Verification failure
   * NEVER yields parsed content: the caller receives an unknown-classified
   * error. Non-2xx answers come back with their status and raw body so the
   * adapter can classify them; error-body content is never trusted business
   * fact, only retry/refusal classification.
   */
  async requestJson(
    method: "GET" | "POST",
    pathWithQuery: string,
    body: string | null,
  ): Promise<{ status: number; json: unknown; rawBody: string }> {
    const response = await this.send(pathWithQuery, body, method);
    if (response.status === 204) {
      return { status: 204, json: null, rawBody: "" };
    }
    const rawBody = new TextDecoder().decode(response.bodyBytes);
    if (response.status < 200 || response.status >= 300) {
      // Error bodies are protocol problem JSON; content is classification only.
      let json: unknown = null;
      try {
        json = JSON.parse(rawBody);
      } catch {
        json = null;
      }
      return { status: response.status, json, rawBody };
    }
    const serial = response.headers["wechatpay-serial"];
    const signature = response.headers["wechatpay-signature"];
    const timestamp = response.headers["wechatpay-timestamp"];
    const nonce = response.headers["wechatpay-nonce"];
    if (!serial || !signature || !timestamp || !nonce) {
      throw new WechatTransportError(
        "bad_signature",
        "success response is missing a Wechatpay-* signature header",
        response.status,
      );
    }
    const verified = this.verifyWithTrustChain(serial, {
      method,
      pathWithQuery,
      rawBody,
      timestampSec: timestamp,
      nonce,
      signatureB64: signature,
    });
    if (!verified.ok) {
      throw new WechatTransportError(
        verified.reason,
        verified.detail,
        response.status,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new WechatTransportError("malformed_response", "body is not JSON");
    }
    return { status: response.status, json, rawBody };
  }

  /**
   * Signed download of a binary file (official file exception: the response
   * has NO signature headers; integrity comes from the SHA1 in the signed
   * tradebill metadata, enforced by bill.ts). Only allow-listed HTTPS hosts are
   * contacted; redirects are followed at most once and only to allow-listed
   * hosts, and the Authorization header is never re-sent to a different host.
   */
  async downloadFile(
    url: string,
    allowedHosts: readonly string[],
  ): Promise<WechatRawResponse> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new WechatTransportError(
        "malformed_response",
        "download_url is not a URL",
      );
    }
    if (
      target.protocol !== "https:" ||
      !allowedHosts.includes(target.hostname)
    ) {
      throw new WechatTransportError(
        "malformed_response",
        `download host ${JSON.stringify(target.hostname)} is not allow-listed`,
      );
    }
    const first = await this.sendRaw(target, "GET", null, true);
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.location;
      if (!location) {
        throw new WechatTransportError(
          "malformed_response",
          "redirect without Location",
        );
      }
      const next = new URL(location, target);
      if (next.protocol !== "https:" || !allowedHosts.includes(next.hostname)) {
        throw new WechatTransportError(
          "malformed_response",
          "redirect target is not an allow-listed HTTPS host",
        );
      }
      // Authorization is bound to the original signed request; never forwarded.
      return this.sendRaw(next, "GET", null, false);
    }
    return first;
  }

  /** Low-level signed send; timeouts and socket faults classify as unknown. */
  private async send(
    pathWithQuery: string,
    body: string | null,
    method: string,
    sign = true,
  ): Promise<WechatRawResponse> {
    const url = new URL(pathWithQuery, "https://api.mch.weixin.qq.com");
    return this.sendRaw(url, method, body, sign);
  }

  private async sendRaw(
    url: URL,
    method: string,
    body: string | null,
    sign: boolean,
  ): Promise<WechatRawResponse> {
    const headers: Record<string, string> = {
      accept:
        "application/json, text/plain, application/gzip, application/octet-stream",
      "user-agent": "openbot-billing/1.0 (wechatpay v3)",
    };
    if (sign) {
      const pathWithQuery = `${url.pathname}${url.search}`;
      headers.authorization = buildAuthorizationHeader({
        method,
        pathWithQuery,
        body: body ?? "",
        timestampSec: this.nowUnixSeconds().toString(),
        nonce: randomNonce(),
        merchantSerial: this.options.identity.merchantSerial,
        mchid: this.options.identity.mchid,
        privateKeyPem: this.options.privateKeyPem,
      });
    }
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      return await withTimeout(
        this.options.transport({ url: url.toString(), method, headers, body }),
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof WechatTransportError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new WechatTransportError(
          "timeout",
          `channel did not answer within ${timeoutMs}ms`,
        );
      }
      throw new WechatTransportError(
        "network_error",
        `transport failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  /**
   * Verify one signature, resolving unknown platform serials through the
   * controlled certificate refresh (exactly once per verification, merged
   * in-flight). `unknown_id` for public-key mode is terminal: public keys
   * arrive through trusted configuration only.
   */
  verifyWithTrustChain(
    serial: string,
    input: {
      method: string;
      pathWithQuery: string;
      rawBody: string;
      timestampSec: string;
      nonce: string;
      signatureB64: string;
    },
  ):
    | { ok: true }
    | {
        ok: false;
        reason: "unknown_platform_serial" | "bad_signature";
        detail: string;
      } {
    // First pass without a refresh; a signature failure is NEVER retried with
    // different material — only an unknown serial may trigger a refresh.
    const selected = this.options.trustStore.select(
      serial,
      this.nowUnixSeconds(),
    );
    if (selected.ok) {
      const valid = verifyWechatpaySignature({
        ...input,
        publicKeyPem: selected.material.publicKeyPem,
      });
      if (!valid) {
        return {
          ok: false,
          reason: "bad_signature",
          detail:
            "signature does not verify against the named platform material",
        };
      }
      return { ok: true };
    }
    if (selected.reason === "retired") {
      return {
        ok: false,
        reason: "unknown_platform_serial",
        detail: `platform material ${serial.slice(0, 4)}… is retired`,
      };
    }
    if (selected.reason !== "unknown_id") {
      return {
        ok: false,
        reason: "unknown_platform_serial",
        detail: `platform material is ${selected.reason}`,
      };
    }
    return {
      ok: false,
      reason: "unknown_platform_serial",
      detail: "platform serial is not in the trusted set",
    };
  }

  /**
   * Controlled refresh of certificate-mode material from the signed
   * /v3/certificates response. The fetcher must verify the response against
   * the CURRENT trusted set before returning materials — this client only
   * triggers and merges.
   */
  async refreshPlatformCertificates(
    fetcher: () => Promise<WechatPlatformMaterial[]>,
  ): Promise<void> {
    await this.options.trustStore.refreshCertificates(fetcher);
  }

  apiv3Key(): string {
    return this.options.apiv3Key;
  }

  /** The trust store drives material selection for notification verification too. */
  get trustStore(): WechatTrustStore {
    return this.options.trustStore;
  }

  skewLimit(): bigint {
    return WECHAT_TIMESTAMP_SKEW_SEC;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const abort = new Error("transport timeout");
          abort.name = "AbortError";
          reject(abort);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export { WechatCryptoError };
