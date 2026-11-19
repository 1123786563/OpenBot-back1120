/**
 * Controlled configuration for the WeChat Pay adapter (#69).
 *
 * The channel is OFF unless explicitly enabled AND fully configured. Secrets
 * are read from the environment (or PEM files referenced by path) and are
 * NEVER logged or persisted here. Any misconfiguration — missing material,
 * wrong key lengths, mode mismatch, wrong environment — disables the CHANNEL
 * (returns null); it never crashes the server and never leaves a half-wired
 * adapter that could answer 200 to an unverified notification.
 *
 * Platform verification material (official public-key migration):
 *  - public key mode:  PLATFORM_PUBLIC_KEY_ID + PLATFORM_PUBLIC_KEY_PATH;
 *    unknown ids are rejected and never fetched;
 *  - certificate mode: PLATFORM_CERTIFICATES_PATH names a JSON bootstrap file
 *    ({ serial -> PEM }) of TRUSTED startup material; later material arrives
 *    only through the signed /v3/certificates refresh.
 */

import { readFileSync } from "node:fs";
import { WechatPayAdapter } from "./adapter.js";
import { WechatApiClient, type WechatTransport } from "./client.js";
import {
  type WechatPlatformMaterial,
  WechatTrustStore,
} from "./trust-store.js";
import { type MerchantIdentity, WECHAT_API_BASE } from "./types.js";

export interface WechatPayConfig {
  readonly identity: MerchantIdentity;
  readonly apiv3Key: string;
  readonly privateKeyPem: string;
  readonly notifyUrl: string;
  readonly trustStore: WechatTrustStore;
}

export interface WechatPayWiring {
  readonly client: WechatApiClient;
  readonly adapter: WechatPayAdapter;
  readonly config: WechatPayConfig;
}

/**
 * Build the adapter wiring from the environment, or null when the channel is
 * disabled. `alarm` receives a redacted reason (never a secret value) when an
 * explicit enablement could not be honoured.
 */
export function loadWechatPayWiring(
  env: NodeJS.ProcessEnv = process.env,
  options: { alarm?: (message: string) => void } = {},
): WechatPayWiring | null {
  const alarm =
    options.alarm ??
    ((message: string) =>
      console.error(JSON.stringify({ alarm: "wechat_pay_config", message })));
  if ((env.OPENBOT_WECHAT_PAY_ENABLED ?? "").trim() !== "1") return null;

  const mchid = (env.WECHAT_PAY_MCHID ?? "").trim();
  const appid = (env.WECHAT_PAY_APPID ?? "").trim();
  const merchantSerial = (env.WECHAT_PAY_MERCHANT_SERIAL ?? "").trim();
  const apiv3Key = env.WECHAT_PAY_APIV3_KEY ?? "";
  const notifyUrl = (env.WECHAT_PAY_NOTIFY_URL ?? "").trim();
  const privateKeyRef = (
    env.WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH ??
    env.WECHAT_PAY_MERCHANT_PRIVATE_KEY_PEM ??
    ""
  ).trim();

  const problems: string[] = [];
  if (mchid === "") problems.push("WECHAT_PAY_MCHID is missing");
  if (appid === "") problems.push("WECHAT_PAY_APPID is missing");
  if (!/^[0-9A-Z]{16}$/.test(merchantSerial))
    problems.push("WECHAT_PAY_MERCHANT_SERIAL is not a 40-hex/serial format");
  if (apiv3Key.length !== 32)
    problems.push("WECHAT_PAY_APIV3_KEY is not exactly 32 characters");
  if (notifyUrl === "" || !/^https:\/\//.test(notifyUrl))
    problems.push("WECHAT_PAY_NOTIFY_URL must be an https URL");
  if (privateKeyRef === "")
    problems.push("merchant API private key material is missing");
  let privateKeyPem = "";
  if (privateKeyRef !== "") {
    try {
      privateKeyPem = privateKeyRef.includes("BEGIN")
        ? privateKeyRef
        : readFileSync(privateKeyRef, "utf8");
    } catch {
      problems.push("merchant API private key file is unreadable");
    }
  }

  const mode = (env.WECHAT_PAY_PLATFORM_MODE ?? "").trim();
  let materials: WechatPlatformMaterial[] = [];
  if (mode === "public_key") {
    const keyId = (env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID ?? "").trim();
    const keyRef = (
      env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH ??
      env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM ??
      ""
    ).trim();
    if (!keyId.startsWith("PUB_KEY_ID_"))
      problems.push(
        "WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID must start with PUB_KEY_ID_",
      );
    let pem = "";
    if (keyRef !== "") {
      try {
        pem = keyRef.includes("BEGIN") ? keyRef : readFileSync(keyRef, "utf8");
      } catch {
        problems.push("platform public key file is unreadable");
      }
    } else {
      problems.push("WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH is missing");
    }
    if (pem !== "") {
      materials = [
        { id: keyId, publicKeyPem: pem, notBeforeSec: null, notAfterSec: null },
      ];
    }
  } else if (mode === "certificate") {
    const bootstrapPath = (
      env.WECHAT_PAY_PLATFORM_CERTIFICATES_PATH ?? ""
    ).trim();
    if (bootstrapPath === "") {
      problems.push(
        "WECHAT_PAY_PLATFORM_CERTIFICATES_PATH is missing in certificate mode",
      );
    } else {
      try {
        const parsed: unknown = JSON.parse(readFileSync(bootstrapPath, "utf8"));
        if (typeof parsed !== "object" || parsed === null)
          throw new Error("not an object");
        materials = Object.entries(parsed as Record<string, unknown>).map(
          ([serial, pem]) => ({
            id: serial,
            publicKeyPem: String(pem),
            notBeforeSec: null,
            notAfterSec: null,
          }),
        );
      } catch {
        problems.push(
          "platform certificate bootstrap file is unreadable or malformed",
        );
      }
    }
  } else {
    problems.push("WECHAT_PAY_PLATFORM_MODE must be public_key or certificate");
  }

  if (problems.length > 0 || materials.length === 0) {
    alarm(
      `wechat pay channel disabled: ${problems.join("; ") || "no trusted platform material"}`,
    );
    return null;
  }

  const config: WechatPayConfig = {
    identity: { mchid, appid, merchantSerial },
    apiv3Key,
    privateKeyPem,
    notifyUrl,
    trustStore: new WechatTrustStore(materials),
  };
  const client = new WechatApiClient({
    identity: config.identity,
    apiv3Key: config.apiv3Key,
    privateKeyPem: config.privateKeyPem,
    trustStore: config.trustStore,
    transport: defaultTransport,
  });
  const adapter = new WechatPayAdapter({ client });
  return { client, adapter, config };
}

/** Production transport: the official API v3 base, redirects never followed. */
const defaultTransport: WechatTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body ?? undefined,
    redirect: "manual",
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return {
    status: response.status,
    headers,
    bodyBytes: new Uint8Array(await response.arrayBuffer()),
  };
};

export { WECHAT_API_BASE };
