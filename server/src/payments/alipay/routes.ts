/**
 * The real alipay notification HTTP entry (#70): POST /payment-callbacks/alipay.
 *
 * Contract shape (billing OpenAPI, payment-channel tag): authenticated by the
 * CHANNEL PROTOCOL ONLY — no session, no cookie, no bearer token — and the
 * response body is the channel's own acknowledgment, the two plain words
 * "success" and "failure". Alipay posts application/x-www-form-urlencoded
 * and never sends JSON, so the entry reads the RAW body bytes, decodes the
 * form exactly once, verifies the RSA2 signature over the decoded fields and
 * the application/merchant identity against the trusted configuration, and
 * only then durably persists the message. "success" means exactly one thing:
 * this exact payload is now durably held. Business matching — order, amount,
 * entitlement — happens asynchronously in the order service (#68) from the
 * inbox record; a user redirect (return_url) never reaches this entry and
 * never confirms anything.
 */

import { type Hono, Hono as HonoRouter } from "hono";
import { parseTimestampUs } from "../../billing-contract/money-time";
import type { AlipayChannelConfig } from "./config";
import { type AlipayNotifyInbox, alipayNotifyDigest } from "./inbox";
import {
  AlipayNotificationError,
  alipayNotificationIdentity,
  parseAlipayNotifyForm,
  verifyAlipayNotificationFields,
} from "./notification";

/** Alipay notify messages are small; anything larger is not one. */
const MAX_NOTIFY_BODY_BYTES = 64 * 1024;

export interface AlipayNotifyRoutesDeps {
  config: AlipayChannelConfig;
  inbox: AlipayNotifyInbox;
}

/** Microsecond contract instant of receipt. */
function nowUs(): string {
  return parseTimestampUs((BigInt(Date.now()) * 1000n).toString()).toString();
}

export function createAlipayNotifyRoutes(deps: AlipayNotifyRoutesDeps): Hono {
  const app = new HonoRouter();

  app.post("/", async (context) => {
    const contentType = context.req.header("content-type") ?? "";
    const media = contentType.split(";")[0].trim().toLowerCase();
    if (media !== "application/x-www-form-urlencoded") {
      return context.text("failure", 200, {
        "content-type": "text/plain; charset=utf-8",
      });
    }
    const rawBody = await context.req.text();
    if (rawBody.length === 0 || rawBody.length > MAX_NOTIFY_BODY_BYTES) {
      return context.text("failure", 200, {
        "content-type": "text/plain; charset=utf-8",
      });
    }

    let fields: Record<string, string>;
    try {
      fields = parseAlipayNotifyForm(rawBody);
    } catch (error) {
      if (error instanceof AlipayNotificationError) {
        // Duplicate keys or a malformed form: nothing verifiable happened.
        return context.text("failure", 200, {
          "content-type": "text/plain; charset=utf-8",
        });
      }
      throw error;
    }

    const verdict = verifyAlipayNotificationFields(fields, deps.config);
    if (verdict.kind === "rejected") {
      // Signature or identity failure: no storage, no success. The reason is
      // a stable word, never payload content.
      console.warn(`alipay notify rejected: ${verdict.reason}`);
      return context.text("failure", 200, {
        "content-type": "text/plain; charset=utf-8",
      });
    }

    const digest = alipayNotifyDigest(rawBody);
    const identity = alipayNotificationIdentity(fields, digest);
    const dedupeKey =
      identity.notify_id !== null
        ? `notify_id:${identity.notify_id}`
        : identity.fallback_key;
    try {
      const receipt = await deps.inbox.record({
        channel: "alipay",
        appId: deps.config.appId,
        dedupeKey,
        payloadDigest: digest,
        rawPayloadB64: Buffer.from(rawBody, "utf8").toString("base64"),
        view: verdict.view,
        receivedAtUs: nowUs(),
        metadata: {
          notify_type: fields.notify_type ?? "",
          notify_time: fields.notify_time ?? "",
          sign_type: fields.sign_type ?? "",
        },
      });
      void receipt.kind; // stored / duplicate / isolated all mean: durably held
      return context.text("success", 200, {
        "content-type": "text/plain; charset=utf-8",
      });
    } catch (error) {
      // Storage failed: the message is NOT durably held, so the gateway must
      // retry. Answering success here would be the one unrecoverable lie.
      console.warn(
        `alipay notify storage failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return context.text("failure", 503, {
        "content-type": "text/plain; charset=utf-8",
      });
    }
  });

  return app;
}
