/**
 * WeChat Pay notification entry point (#69): POST /payment-callbacks/wechat.
 *
 * This is the WeChat LINE protocol — raw JSON body plus Wechatpay-* headers,
 * no user session, no CallbackEnvelope re-encoding. Discipline:
 *  - the raw body bytes are read once and never re-serialized before
 *    verification;
 *  - verification failure answers HTTP 4xx with the channel failure format
 *    (`code: FAIL`, redacted `message`) and NEVER yields a verified event;
 *  - the event is durably persisted BEFORE any success ACK (no ACK-before-commit);
 *  - first receipt: 200 with `{"code":"SUCCESS","message":"成功"}`;
 *    legitimate duplicate: empty-body 200;
 *  - same-id/different-content conflicts alarm and refuse (FAIL, 409);
 *  - storage failure answers 5xx FAIL so WeChat re-delivers;
 *  - answers are immediate (well inside the official 5-second limit).
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WechatPayAdapter } from "./adapter.js";
import { InboxConflictError, type WechatNotificationInbox } from "./inbox.js";

/** Official guidance keeps notifications small; refuse anything larger early. */
const MAX_NOTIFICATION_BYTES = 262_144;

export interface WechatCallbackDeps {
  readonly adapter: WechatPayAdapter;
  /** Absent inbox means the receiving boundary is not deployed: answer 503. */
  readonly inbox: WechatNotificationInbox | null;
  /** Alarm sink for conflict/anomaly events; default: structured console error. */
  readonly alarm?: (message: string) => void;
}

function fail(status: 400 | 401 | 403 | 409 | 500 | 503, message: string) {
  // `message` carries classification only — never payload, key or link material.
  return Response.json({ code: "FAIL", message }, { status });
}

export function createWechatCallbackRoutes(deps: WechatCallbackDeps): Hono {
  const app = new Hono();
  app.use(
    "/payment-callbacks/wechat",
    bodyLimit({
      maxSize: MAX_NOTIFICATION_BYTES,
      onError: () => fail(400, "notification too large"),
    }),
  );

  app.post("/payment-callbacks/wechat", async (context) => {
    const rawBytes = new Uint8Array(await context.req.arrayBuffer());
    if (rawBytes.byteLength === 0) {
      return fail(400, "empty notification body");
    }
    const url = new URL(context.req.url);
    const pathWithQuery = `${url.pathname}${url.search}`;
    const headers: Record<string, string> = {};
    context.req.raw.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });

    const verification = await deps.adapter.verifyNotification(
      rawBytes,
      headers,
      {
        method: "POST",
        pathWithQuery,
      },
    );
    if (verification.kind === "rejected") {
      // Signature and window failures answer 401/403; malformed structure 400.
      const status =
        verification.reason === "timestamp_out_of_window" ||
        verification.reason === "unknown_serial" ||
        verification.reason === "bad_signature"
          ? 401
          : 400;
      return fail(status, `notification rejected: ${verification.reason}`);
    }

    const notification = verification.notification;
    if (!deps.inbox) {
      return fail(503, "receiving boundary is not deployed");
    }
    const mchid =
      typeof notification.decrypted.mchid === "string"
        ? notification.decrypted.mchid
        : "unknown";
    let outcome: "stored" | "duplicate";
    try {
      outcome = await deps.inbox.record({
        mchid,
        eventId: notification.eventId,
        eventType: notification.eventType,
        rawEnvelopeBytes: rawBytes,
        decryptedResource: notification.decrypted,
        signatureSerial: headers["wechatpay-serial"] ?? "unknown",
      });
    } catch (error) {
      if (error instanceof InboxConflictError) {
        (deps.alarm ?? defaultAlarm)(error.message);
        return fail(409, "notification identity conflict");
      }
      (deps.alarm ?? defaultAlarm)(
        `inbox storage failure for event ${notification.eventId.slice(0, 8)}…`,
      );
      return fail(500, "storage failure");
    }
    if (outcome === "duplicate") {
      // Legitimate duplicate: confirm with an EMPTY 200 body, never reprocess.
      return new Response(null, { status: 200 });
    }
    return Response.json({ code: "SUCCESS", message: "成功" }, { status: 200 });
  });

  return app;
}

function defaultAlarm(message: string): void {
  console.error(JSON.stringify({ alarm: "wechat_notification", message }));
}
