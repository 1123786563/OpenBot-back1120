/**
 * WeChat Pay platform verification-material trust store (#69).
 *
 * Two coexisting material families (official public-key migration):
 *  - public key mode:  { PUBLIC_KEY_ID -> PEM } updated ONLY through trusted
 *    configuration (an unknown id is never fetched, only rejected);
 *  - certificate mode: { SERIAL -> PEM } bootstrapped from trusted startup
 *    material and refreshed from the signed /v3/certificates response.
 *
 * Selection is by EXACT id/serial — never "try every key and see if one
 * verifies" (that would let an unknown response certify itself). Expired,
 * not-yet-valid or retired material is refused. Refresh is rate-limited and
 * concurrent calls share one in-flight fetch.
 */

export interface WechatPlatformMaterial {
  /** Public-key id ("PUB_KEY_ID_...") or certificate serial in this store. */
  readonly id: string;
  readonly publicKeyPem: string;
  /** Inclusive validity window (unix seconds); null = unbounded. */
  readonly notBeforeSec: bigint | null;
  readonly notAfterSec: bigint | null;
}

export interface TrustStoreOptions {
  /** Minimum interval between unknown-serial refresh attempts (ms). */
  readonly refreshMinIntervalMs?: number;
  readonly nowMs?: () => number;
}

export type MaterialRejection =
  | "unknown_id"
  | "not_yet_valid"
  | "expired"
  | "retired";

export interface RefreshOutcome {
  /** Materials merged during this refresh (already signature-verified upstream). */
  readonly added: string[];
  /** Whether this call actually performed the fetch (false = shared in-flight or rate-limited). */
  readonly fetched: boolean;
}

export class WechatTrustStore {
  private readonly byId = new Map<string, WechatPlatformMaterial>();
  private readonly retired = new Set<string>();
  private readonly refreshMinIntervalMs: number;
  private readonly nowMs: () => number;
  private lastRefreshMs = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<RefreshOutcome> | null = null;

  constructor(
    materials: WechatPlatformMaterial[],
    options: TrustStoreOptions = {},
  ) {
    this.refreshMinIntervalMs = options.refreshMinIntervalMs ?? 30_000;
    this.nowMs = options.nowMs ?? (() => Date.now());
    for (const material of materials) this.byId.set(material.id, material);
  }

  /**
   * Exact selection. Returns the material or the precise refusal reason;
   * callers turn `unknown_id` into a controlled refresh, never into a fallback
   * verification with some other key.
   */
  select(
    id: string,
    nowSec: bigint,
  ):
    | { ok: true; material: WechatPlatformMaterial }
    | { ok: false; reason: MaterialRejection } {
    if (this.retired.has(id)) return { ok: false, reason: "retired" };
    const material = this.byId.get(id);
    if (!material) return { ok: false, reason: "unknown_id" };
    if (material.notBeforeSec !== null && nowSec < material.notBeforeSec) {
      return { ok: false, reason: "not_yet_valid" };
    }
    if (material.notAfterSec !== null && nowSec > material.notAfterSec) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, material };
  }

  /** Merge one verified material (idempotent per id). */
  upsert(material: WechatPlatformMaterial): void {
    if (this.retired.has(material.id)) return;
    this.byId.set(material.id, material);
  }

  /** Retired material is refused forever, even if re-offered. */
  retire(id: string): void {
    this.retired.add(id);
    this.byId.delete(id);
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  /**
   * Controlled refresh of certificate-mode material. Concurrent callers share
   * one in-flight fetch; repeated calls inside the rate-limit window reuse the
   * previous outcome without touching the network again. The fetcher returns
   * ALREADY-VERIFIED materials (the certificates endpoint response must itself
   * be verified against the current trusted set before anything is merged).
   */
  async refreshCertificates(
    fetcher: () => Promise<WechatPlatformMaterial[]>,
  ): Promise<RefreshOutcome> {
    if (this.inFlight) return this.inFlight;
    const now = this.nowMs();
    if (now - this.lastRefreshMs < this.refreshMinIntervalMs) {
      return { added: [], fetched: false };
    }
    this.inFlight = (async () => {
      try {
        this.lastRefreshMs = this.nowMs();
        const materials = await fetcher();
        const added: string[] = [];
        for (const material of materials) {
          if (!this.byId.has(material.id)) added.push(material.id);
          this.upsert(material);
        }
        return { added, fetched: true };
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
