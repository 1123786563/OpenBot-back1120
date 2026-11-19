/**
 * Alipay channel configuration binding (#70).
 *
 * One environment, one gateway, one merchant application: the app id, seller
 * id, key material, notify URL and return-URL whitelist are bound together at
 * boot or not at all. A deployment that names some but not every piece must
 * refuse to start rather than run with a half-bound channel — a missing
 * public key would turn every notification into either a false accept or a
 * permanent failure, and neither is discoverable from the outside.
 *
 * Configuration values are never logged; the redacted summary is the only
 * printable shape of a live config.
 */

/** Official production gateway of the traditional (non-v3) protocol family. */
export const ALIPAY_PRODUCTION_GATEWAY =
  "https://openapi.alipay.com/gateway.do";

/** Hosts the statement downloader may fetch bill archives from by default. */
export const ALIPAY_STATEMENT_HOSTS = ["download.alipay.com"];

export interface AlipayChannelConfig {
  appId: string;
  /** 2088-partner id the merchant application belongs to. */
  sellerId: string;
  /** PKCS8 PEM of the merchant application private key. */
  merchantPrivateKey: string;
  /** PEM of Alipay's platform public key (public-key verification mode). */
  alipayPublicKey: string;
  gatewayUrl: string;
  /** Absolute HTTPS URL the gateway posts async notifications to. */
  notifyUrl: string;
  /** Exact origins a browser may be redirected back to after payment. */
  returnUrlWhitelist: readonly string[];
  /** HTTPS hosts a bill archive may be downloaded from. */
  statementDownloadHosts: readonly string[];
  /** Per-HTTP-call timeout in milliseconds. */
  requestTimeoutMs: number;
}

export type AlipayChannelConfigInput = Partial<
  Omit<
    AlipayChannelConfig,
    "gatewayUrl" | "statementDownloadHosts" | "requestTimeoutMs"
  >
> & {
  gatewayUrl?: string;
  statementDownloadHosts?: readonly string[];
  requestTimeoutMs?: number;
};

const ALIPAY_APP_ID_RE = /^2\d{15}$/;
const ALIPAY_SELLER_ID_RE = /^2088\d{12}$/;

export class AlipayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlipayConfigError";
  }
}

function requireString(value: string | undefined, what: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new AlipayConfigError(`alipay ${what} is missing`);
  return trimmed;
}

function requireHttpsUrl(value: string, what: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AlipayConfigError(`alipay ${what} is not a URL`);
  }
  if (parsed.protocol !== "https:") {
    // The one exception is a loopback gateway, which exists only for the
    // controlled protocol-test boundary; a production gateway is HTTPS.
    const loopback =
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "[::1]");
    if (!loopback) {
      throw new AlipayConfigError(`alipay ${what} must be HTTPS`);
    }
  }
  return parsed.toString().replace(/\/$/, "");
}

/** Validate and freeze a channel configuration; throws on any missing piece. */
export function alipayChannelConfig(
  input: AlipayChannelConfigInput,
): AlipayChannelConfig {
  const appId = requireString(input.appId, "app_id");
  if (!ALIPAY_APP_ID_RE.test(appId)) {
    throw new AlipayConfigError(
      "alipay app_id must be a 16-digit application id",
    );
  }
  const sellerId = requireString(input.sellerId, "seller_id");
  if (!ALIPAY_SELLER_ID_RE.test(sellerId)) {
    throw new AlipayConfigError("alipay seller_id must be a 2088-partner id");
  }
  const merchantPrivateKey = input.merchantPrivateKey?.trim();
  if (!merchantPrivateKey?.includes("-----BEGIN")) {
    throw new AlipayConfigError(
      "alipay merchant private key must be PEM (PKCS8) material",
    );
  }
  const alipayPublicKey = input.alipayPublicKey?.trim();
  if (!alipayPublicKey?.includes("-----BEGIN")) {
    throw new AlipayConfigError(
      "alipay platform public key must be PEM material",
    );
  }
  const notifyUrl = requireHttpsUrl(
    requireString(input.notifyUrl, "notify_url"),
    "notify_url",
  );
  const whitelist = (input.returnUrlWhitelist ?? []).map((origin) =>
    requireHttpsUrl(origin.trim(), "return_url whitelist entry"),
  );
  if (whitelist.length === 0) {
    throw new AlipayConfigError(
      "alipay return_url whitelist must name at least one HTTPS origin",
    );
  }
  const statementDownloadHosts =
    input.statementDownloadHosts ?? ALIPAY_STATEMENT_HOSTS;
  if (statementDownloadHosts.length === 0) {
    throw new AlipayConfigError(
      "alipay statement download host whitelist must not be empty",
    );
  }
  const requestTimeoutMs = input.requestTimeoutMs ?? 10_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new AlipayConfigError("alipay request timeout must be positive ms");
  }
  return {
    appId,
    sellerId,
    merchantPrivateKey,
    alipayPublicKey,
    gatewayUrl: requireHttpsUrl(
      input.gatewayUrl?.trim() || ALIPAY_PRODUCTION_GATEWAY,
      "gateway",
    ),
    notifyUrl,
    returnUrlWhitelist: whitelist,
    statementDownloadHosts,
    requestTimeoutMs,
  };
}

/**
 * Read the channel from raw environment entries. Undefined (channel not
 * deployed) only when NOTHING is named; any partial binding is a startup
 * failure, because the missing piece is exactly the one that decides whether
 * a notification is real.
 */
export function alipayConfigFromEnvironment(
  env: Record<string, string | undefined>,
): AlipayChannelConfig | undefined {
  const named = [
    "ALIPAY_APP_ID",
    "ALIPAY_SELLER_ID",
    "ALIPAY_MERCHANT_PRIVATE_KEY",
    "ALIPAY_PUBLIC_KEY",
    "ALIPAY_NOTIFY_URL",
    "ALIPAY_RETURN_URL_WHITELIST",
  ].some((k) => env[k]?.trim());
  if (!named) return undefined;
  const whitelist = (env.ALIPAY_RETURN_URL_WHITELIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return alipayChannelConfig({
    appId: env.ALIPAY_APP_ID,
    sellerId: env.ALIPAY_SELLER_ID,
    merchantPrivateKey: env.ALIPAY_MERCHANT_PRIVATE_KEY,
    alipayPublicKey: env.ALIPAY_PUBLIC_KEY,
    gatewayUrl: env.ALIPAY_GATEWAY_URL,
    notifyUrl: env.ALIPAY_NOTIFY_URL,
    returnUrlWhitelist: whitelist,
    requestTimeoutMs: env.ALIPAY_REQUEST_TIMEOUT_MS
      ? Number(env.ALIPAY_REQUEST_TIMEOUT_MS)
      : undefined,
  });
}

/** Log-safe shape: identity and limits, never key material or URLs. */
export function alipayConfigSummary(
  config: AlipayChannelConfig,
): Record<string, unknown> {
  return {
    app_id: config.appId,
    seller_id: config.sellerId,
    gateway_host: new URL(config.gatewayUrl).host,
    notify_url_configured: true,
    return_url_whitelist_size: config.returnUrlWhitelist.length,
    statement_download_hosts: [...config.statementDownloadHosts],
    request_timeout_ms: config.requestTimeoutMs,
    verification_mode: "public_key",
  };
}

/** Is `url` exactly one of the whitelisted return origins (any path)? */
export function returnUrlWhitelisted(
  config: AlipayChannelConfig,
  url: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return config.returnUrlWhitelist.some(
    (origin) => parsed.origin === origin && parsed.protocol === "https:",
  );
}
