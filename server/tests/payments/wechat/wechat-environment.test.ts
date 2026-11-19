/**
 * Environment matrix and certificate refresh through the signed client
 * (#69 AC3/AC5).
 */

import { describe, expect, test } from "bun:test";
import { WechatApiClient } from "../../../src/payments/wechat/client.js";
import { WechatPayAdapter } from "../../../src/payments/wechat/adapter.js";
import { WechatTrustStore } from "../../../src/payments/wechat/trust-store.js";
import {
  classifyPaymentEnvironment,
  guidanceFor,
} from "../../../src/payments/wechat/environment.js";
import {
  FIXED_NOW_US,
  TEST_APIV3_KEY,
  buildSuccessNotification,
  createControlledPeer,
  encryptResource,
  generateRsa,
} from "./wechat-testkit.js";

const platform = generateRsa("PLATSERIAL02");
const merchant = generateRsa("MCHSERIAL02A");
const NOW_SEC = FIXED_NOW_US / 1_000_000n;

describe("payment environment matrix (AC5)", () => {
  test("desktop → Native QR", () => {
    const environment = classifyPaymentEnvironment({ isMobile: false, isWechatInternalBrowser: false, isEmbeddedWebview: false });
    expect(guidanceFor(environment, { native: true, h5: true })).toEqual({ kind: "native_qr" });
  });

  test("supported external mobile browser → H5 redirect", () => {
    const environment = classifyPaymentEnvironment({ isMobile: true, isWechatInternalBrowser: false, isEmbeddedWebview: false });
    expect(guidanceFor(environment, { native: true, h5: true })).toEqual({ kind: "h5_redirect" });
  });

  test.each([
    ["wechat internal", { isMobile: true, isWechatInternalBrowser: true, isEmbeddedWebview: false }],
    ["embedded webview", { isMobile: true, isWechatInternalBrowser: false, isEmbeddedWebview: true }],
  ])("%s → unsupported, open system browser, never auto-wake WeChat", (_name, input) => {
    const environment = classifyPaymentEnvironment(input);
    const guidance = guidanceFor(environment, { native: true, h5: true });
    expect(guidance.kind).toBe("unsupported_environment");
    if (guidance.kind !== "unsupported_environment") return;
    expect(guidance.hint).toMatch(/system browser/i);
    // Explicitly NOT the same-phone long-press QR claim.
    expect(guidance.hint.toLowerCase()).not.toContain("long press");
  });
});

describe("certificate refresh through the signed /v3/certificates path (AC3)", () => {
  test("unknown serial → refresh hit → notification verifies; refresh failure keeps rejecting", async () => {
    const { envelope } = buildSuccessNotification(
      { mchid: "1900000001", out_trade_no: "order-r" },
      { eventId: "EV-REFRESH" },
    );
    const rawBody = JSON.stringify(envelope);
    let certificateRequests = 0;

    // The controlled peer signs the notification with the NEW platform key and
    // serves an official-shaped, APIv3-encrypted certificates document.
    const peer = createControlledPeer({ platform, apiv3Key: TEST_APIV3_KEY, nowUnixSeconds: () => NOW_SEC });
    const oldPlatform = generateRsa("OLDSERIAL03");
    const transport = async (request: { url: string; method: string; headers: Record<string, string>; body: string | null }) => {
      const url = new URL(request.url);
      if (url.pathname === "/v3/certificates") {
        certificateRequests++;
        // The certificates response is itself signed by a CURRENTLY TRUSTED key.
        const body = JSON.stringify({
          data: [
            {
              serial_no: platform.serial,
              effective_time: "2023-01-01T00:00:00+08:00",
              expire_time: "2030-01-01T00:00:00+08:00",
              encrypt_certificate: {
                algorithm: "AEAD_AES_256_GCM",
                nonce: "certnonce123",
                associated_data: "certificate",
                ciphertext: encryptResource(
                  platform.publicPem,
                  TEST_APIV3_KEY,
                  "certnonce123",
                  "certificate",
                ),
              },
            },
          ],
        });
        const { createSign } = await import("node:crypto");
        const { signatureMessage } = await import("../../../src/payments/wechat/crypto.js");
        const signature = createSign("RSA-SHA256")
          .update(signatureMessage("GET", "/v3/certificates", NOW_SEC.toString(), "cert-nonce", body))
          .sign(oldPlatform.privatePem)
          .toString("base64");
        return {
          status: 200,
          headers: {
            "wechatpay-serial": oldPlatform.serial,
            "wechatpay-signature": signature,
            "wechatpay-timestamp": NOW_SEC.toString(),
            "wechatpay-nonce": "cert-nonce",
          },
          bodyBytes: new TextEncoder().encode(body),
        };
      }
      return peer.transport(request);
    };

    const makeAdapter = (refreshWorks: boolean) => {
      const client = new WechatApiClient({
        identity: { mchid: "1900000001", appid: "wx1234567890", merchantSerial: merchant.serial },
        apiv3Key: TEST_APIV3_KEY,
        privateKeyPem: merchant.privatePem,
        trustStore: new WechatTrustStore(
          [{ id: oldPlatform.serial, publicKeyPem: oldPlatform.publicPem, notBeforeSec: null, notAfterSec: null }],
          { refreshMinIntervalMs: 0 },
        ),
        transport: refreshWorks ? transport : async () => {
          throw new Error("gateway unreachable");
        },
        nowUnixSeconds: () => NOW_SEC,
      });
      return new WechatPayAdapter({ client, nowUs: () => FIXED_NOW_US });
    };

    const bytes = new TextEncoder().encode(rawBody);
    const headers = peer.signNotification(rawBody, { timestampSec: NOW_SEC.toString() });

    // Refresh fails → still a rejection (never a transport crash).
    const failing = await makeAdapter(false).verifyNotification(bytes, headers, {
      method: "POST",
      pathWithQuery: "/payment-callbacks/wechat",
    });
    expect(failing).toEqual({ kind: "rejected", reason: "unknown_serial", detail: expect.any(String) });

    // Refresh hits → the fetched certificate decrypts, merges, and the SAME
    // notification now verifies on the second pass.
    const verification = await makeAdapter(true).verifyNotification(bytes, headers, {
      method: "POST",
      pathWithQuery: "/payment-callbacks/wechat",
    });
    expect(verification.kind).toBe("verified");
    expect(certificateRequests).toBe(1);
  });
});
