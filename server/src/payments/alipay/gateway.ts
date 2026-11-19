/**
 * The alipay openapi gateway boundary (#70): one signed form POST per server
 * operation, one verified raw response back.
 *
 * The gateway is reached ONLY through the injectable {@link AlipayTransport},
 * so protocol tests drive a controlled HTTP service instead of the real
 * gateway while the production code path (fetch with a hard timeout) stays
 * identical. Every response is signature-verified over its ORIGINAL bytes
 * before anything is read out of it; a response that fails verification, that
 * times out, or that carries a business error becomes an explicit failure
 * result — HTTP 200 alone never means business success, and no code path here
 * can ever manufacture a payment or refund fact.
 */

import type { AlipayChannelConfig } from "./config";
import { signAlipayRequest, verifyAlipayResponse } from "./signature";

export interface AlipayTransportResponse {
  status: number;
  /** The exact response body bytes, decoded as UTF-8. Never re-serialized. */
  text: string;
}

export interface AlipayTransport {
  /** POST the form to the gateway URL and return the raw response. */
  postForm(
    url: string,
    form: URLSearchParams,
  ): Promise<AlipayTransportResponse>;
}

export class AlipayTransportTimeoutError extends Error {
  constructor() {
    super("alipay gateway call timed out");
    this.name = "AlipayTransportTimeoutError";
  }
}

/** Production transport: fetch with the configured hard timeout. */
export function createFetchAlipayTransport(timeoutMs: number): AlipayTransport {
  return {
    async postForm(url, form) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: controller.signal,
        });
        return { status: response.status, text: await response.text() };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new AlipayTransportTimeoutError();
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type AlipayGatewayFailure =
  | { kind: "verify_failed" }
  | { kind: "timeout" }
  | { kind: "http_error"; status: number }
  | {
      kind: "business_error";
      code: string;
      subCode: string | null;
      msg: string;
    }
  | { kind: "malformed"; detail: string };

export type AlipayGatewayResult<T> =
  | { ok: true; value: T; rawResponse: string }
  | { ok: false; failure: AlipayGatewayFailure; rawResponse: string | null };

export interface AlipayGatewayRequest {
  method: string;
  bizContent: Record<string, unknown>;
  /** Extra spparams (app_auth_token etc.); none for this ticket's scope. */
  extraParams?: Record<string, string>;
}

/** Common gateway envelope fields, identical for every server operation. */
function commonParams(
  config: AlipayChannelConfig,
  request: AlipayGatewayRequest,
): Record<string, string> {
  return {
    app_id: config.appId,
    method: request.method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: alipayGatewayTimestamp(),
    version: "1.0",
    biz_content: JSON.stringify(request.bizContent),
    ...request.extraParams,
  };
}

/** The gateway's `timestamp` format is Beijing wall-clock with seconds. */
function alipayGatewayTimestamp(): string {
  // Shift the UTC instant into Beijing wall clock, then format the fields.
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    ` ${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`
  );
}

export interface AlipayGateway {
  /** Execute one signed gateway request and verify the raw response. */
  execute<T>(
    request: AlipayGatewayRequest,
    parse: (responseNode: Record<string, unknown>) => T,
  ): Promise<AlipayGatewayResult<T>>;
  /** The URL the gateway answers on. */
  readonly gatewayUrl: string;
}

export function createAlipayGateway(
  config: AlipayChannelConfig,
  transport: AlipayTransport,
): AlipayGateway {
  return {
    gatewayUrl: config.gatewayUrl,
    async execute(request, parse) {
      const params = commonParams(config, request);
      const sign = signAlipayRequest(params, config.merchantPrivateKey);
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) form.set(k, v);
      form.set("sign", sign);

      let response: AlipayTransportResponse;
      try {
        response = await transport.postForm(config.gatewayUrl, form);
      } catch (error) {
        if (
          error instanceof AlipayTransportTimeoutError ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return { ok: false, failure: { kind: "timeout" }, rawResponse: null };
        }
        throw error;
      }
      if (response.status !== 200) {
        return {
          ok: false,
          failure: { kind: "http_error", status: response.status },
          rawResponse: response.text,
        };
      }
      if (
        !verifyAlipayResponse(
          response.text,
          gatewayResponseKey(request.method),
          config.alipayPublicKey,
        )
      ) {
        return {
          ok: false,
          failure: { kind: "verify_failed" },
          rawResponse: response.text,
        };
      }
      const rawNode = extractResponseNode(
        response.text,
        gatewayResponseKey(request.method),
      );
      if (rawNode === null) {
        return {
          ok: false,
          failure: { kind: "malformed", detail: "response node missing" },
          rawResponse: response.text,
        };
      }
      const code = typeof rawNode.code === "string" ? rawNode.code : null;
      if (code !== null && code !== "10000") {
        return {
          ok: false,
          failure: {
            kind: "business_error",
            code,
            subCode:
              typeof rawNode.sub_code === "string" ? rawNode.sub_code : null,
            msg: typeof rawNode.msg === "string" ? rawNode.msg : "",
          },
          rawResponse: response.text,
        };
      }
      if (code === null) {
        return {
          ok: false,
          failure: {
            kind: "malformed",
            detail: "response node carries no code",
          },
          rawResponse: response.text,
        };
      }
      return { ok: true, value: parse(rawNode), rawResponse: response.text };
    },
  };
}

/** The response key the gateway names a result node by. */
function gatewayResponseKey(method: string): string {
  return `${method.replaceAll(".", "_")}_response`;
}

/**
 * Pull the `<method>_response` object out of the verified raw text WITHOUT
 * re-serializing: the same substring that was signature-verified is what gets
 * JSON-parsed here.
 */
function extractResponseNode(
  raw: string,
  responseKey: string,
): Record<string, unknown> | null {
  const key = `"${responseKey}"`;
  const keyIndex = raw.indexOf(key);
  if (keyIndex === -1) return null;
  const braceStart = raw.indexOf("{", keyIndex + key.length);
  if (braceStart === -1) return null;
  // Walk to the matching close brace of the response object.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStart; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(braceStart, i + 1)) as Record<
            string,
            unknown
          >;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
