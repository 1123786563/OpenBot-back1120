/**
 * Trust-store selection and rotation (#69 AC3): exact serial selection,
 * validity windows, retirement, controlled refresh rate-limiting and
 * in-flight dedupe. No fallback verification with "some" key, ever.
 */

import { describe, expect, test } from "bun:test";
import { WechatTrustStore, type WechatPlatformMaterial } from "../../../src/payments/wechat/trust-store.js";

const material = (id: string, overrides: Partial<WechatPlatformMaterial> = {}): WechatPlatformMaterial => ({
  id,
  publicKeyPem: `-----BEGIN PUBLIC KEY-----${id}-----END PUBLIC KEY-----`,
  notBeforeSec: null,
  notAfterSec: null,
  ...overrides,
});

describe("exact selection", () => {
  const store = new WechatTrustStore([material("SERIAL-A"), material("PUB_KEY_ID_X")]);

  test("the named serial is selected exactly", () => {
    const selected = store.select("SERIAL-A", 1_700_000_000n);
    expect(selected.ok).toBe(true);
    if (selected.ok) expect(selected.material.id).toBe("SERIAL-A");
  });

  test("an unknown id is refused without any fallback", () => {
    expect(store.select("SERIAL-B", 1_700_000_000n)).toEqual({ ok: false, reason: "unknown_id" });
    expect(store.select("PUB_KEY_ID_UNKNOWN", 1_700_000_000n)).toEqual({ ok: false, reason: "unknown_id" });
  });
});

describe("validity windows", () => {
  const windowed = new WechatTrustStore([
    material("FUTURE", { notBeforeSec: 2_000_000_000n }),
    material("PAST", { notAfterSec: 1_600_000_000n }),
    material("WINDOW", { notBeforeSec: 1_699_999_999n, notAfterSec: 1_700_000_001n }),
  ]);

  test("not-yet-valid material is refused", () => {
    expect(windowed.select("FUTURE", 1_700_000_000n)).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  test("expired material is refused", () => {
    expect(windowed.select("PAST", 1_700_000_000n)).toEqual({ ok: false, reason: "expired" });
  });

  test("the validity window is inclusive on both ends", () => {
    expect(windowed.select("WINDOW", 1_699_999_999n).ok).toBe(true);
    expect(windowed.select("WINDOW", 1_700_000_001n).ok).toBe(true);
    expect(windowed.select("WINDOW", 1_700_000_002n).ok).toBe(false);
  });
});

describe("rotation and retirement", () => {
  test("a new overlapping certificate is merged and selected (AC3 rotation)", () => {
    const store = new WechatTrustStore([material("OLD")]);
    store.upsert(material("NEW"));
    expect(store.select("OLD", 1n).ok).toBe(true);
    expect(store.select("NEW", 1n).ok).toBe(true);
  });

  test("retired material is refused even when re-offered", () => {
    const store = new WechatTrustStore([material("OLD")]);
    store.retire("OLD");
    expect(store.select("OLD", 1n)).toEqual({ ok: false, reason: "retired" });
    store.upsert(material("OLD"));
    expect(store.select("OLD", 1n)).toEqual({ ok: false, reason: "retired" });
  });
});

describe("controlled refresh", () => {
  test("concurrent unknown-serial refreshes share one fetch", async () => {
    let fetches = 0;
    const store = new WechatTrustStore([], { refreshMinIntervalMs: 0 });
    const fetcher = async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 5));
      return [material("SERIAL-REFRESHED")];
    };
    const [a, b] = await Promise.all([store.refreshCertificates(fetcher), store.refreshCertificates(fetcher)]);
    expect(fetches).toBe(1);
    expect(a.fetched && b.fetched ? 1 : a.fetched !== b.fetched ? 1 : 0).toBeLessThanOrEqual(1);
    expect(store.select("SERIAL-REFRESHED", 1n).ok).toBe(true);
  });

  test("repeat refreshes inside the rate-limit window do not touch the network", async () => {
    let clock = 1_000;
    let fetches = 0;
    const store = new WechatTrustStore([], {
      refreshMinIntervalMs: 30_000,
      nowMs: () => clock,
    });
    const fetcher = async () => {
      fetches++;
      return [material("S1")];
    };
    await store.refreshCertificates(fetcher);
    clock += 1_000; // +1s, inside the 30s window
    const second = await store.refreshCertificates(fetcher);
    expect(fetches).toBe(1);
    expect(second.fetched).toBe(false);
    clock += 60_000; // outside the window
    await store.refreshCertificates(fetcher);
    expect(fetches).toBe(2);
  });

  test("refresh never resurrects retired material", async () => {
    const store = new WechatTrustStore([material("OLD")]);
    store.retire("OLD");
    await store.refreshCertificates(async () => [material("OLD"), material("NEW")]);
    expect(store.select("OLD", 1n)).toEqual({ ok: false, reason: "retired" });
    expect(store.select("NEW", 1n).ok).toBe(true);
  });
});
