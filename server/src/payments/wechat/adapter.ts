/**
 * WeChat Pay adapter — business mapping over the signed API client (#69).
 *
 * Scope (frozen): Native/H5 create, query by merchant order number, close,
 * refund create/query, trade bill download, notification verification. The
 * adapter reports channel FACTS through discriminated unions; it never
 * fulfils orders, never mints credits, never schedules reconciliation, and
 * never turns a timeout or an untrusted answer into a business result.
 *
 * Ordering and expiry discipline:
 *  - action expiry  = min(issued + 5 minutes, order deadline);
 *  - H5 refresh     = same out_trade_no, same amount, same order deadline,
 *                     only while the order is live and the attempt is not
 *                     terminal; uncertainty resolves by QUERY first;
 *  - refund retry   = same out_refund_no, same parameters, only after the
 *                     original number has been queried; a new refund number is
 *                     NEVER generated here.
 */

import {
  decodeBillBytes,
  defaultBillWorkspace,
  publishBillFile,
  verifyBillDigest,
} from "./bill.js";
import {
  type WechatApiClient,
  type WechatRawResponse,
  WechatTransportError,
} from "./client.js";
import {
  decryptResource,
  timestampWithinWindow,
  verifyWechatpaySignature,
  WechatCryptoError,
} from "./crypto.js";
import {
  type ClosePaymentResult,
  type CreatePaymentInput,
  type CreateRefundResult,
  type NotificationVerification,
  type PaymentActionResult,
  parseTimestampUs,
  parseWechatFen,
  parseWechatTimeUs,
  type QueryPaymentResult,
  type QueryRefundResult,
  type TradeBillResult,
  toWechatJsonFen,
  type VerifiedNotification,
  type VerifiedPaymentFact,
} from "./types.js";

/** Official H5/Native link lifetime (5 minutes) as a fraction of the minute. */
const ACTION_TTL_US = 5n * 60n * 1_000_000n;

const DOWNLOAD_ALLOWED_HOSTS = ["api.mch.weixin.qq.com"] as const;

const PAYMENT_PENDING_STATES = new Set(["NOTPAY", "ACCEPT", "USER_PAYING"]);
const PAYMENT_CLOSED_STATES = new Set(["CLOSED", "REVOKED", "PAYERROR"]);

export interface WechatAdapterDeps {
  readonly client: WechatApiClient;
  /** Absolute microsecond clock (contract string), injectable for tests. */
  readonly nowUs?: () => bigint;
  /** Destination directory for published bills; default: a private temp dir. */
  readonly billWorkspaceDir?: () => string;
}

export class WechatPayAdapter {
  private readonly nowUs: () => bigint;

  constructor(private readonly deps: WechatAdapterDeps) {
    this.nowUs = deps.nowUs ?? (() => BigInt(Date.now()) * 1000n);
  }

  private get client(): WechatApiClient {
    return this.deps.client;
  }

  // ------------------------------------------------------------------ create

  /**
   * Native (desktop QR) or H5 (external mobile browser) prepay. The returned
   * action expires at min(now+5min, order deadline) — the business order keeps
   * its own independent 30-minute deadline, and the action never crosses it.
   */
  async createPayment(input: CreatePaymentInput): Promise<PaymentActionResult> {
    const now = this.nowUs();
    if (parseTimestampUs(input.orderExpiresAtUs.toString()) <= now) {
      return { kind: "rejected", reason: "order_expired" };
    }
    const body: Record<string, unknown> = {
      appid: input.identity.appid,
      mchid: input.identity.mchid,
      description: input.description,
      out_trade_no: input.outTradeNo,
      time_expire: isoFromUs(input.orderExpiresAtUs),
      notify_url: input.notifyUrl,
      amount: {
        total: toWechatJsonFen(input.amountFen, "amount.total"),
        currency: "CNY",
      },
    };
    if (input.scenario === "h5") {
      if (!input.h5?.payerClientIp) {
        return {
          kind: "rejected",
          reason: "amount_or_identity_changed",
          detail: "H5 requires a trusted payer client IP",
        };
      }
      body.scene_info = {
        payer_client_ip: input.h5.payerClientIp,
        h5_info: { type: "Wap" },
      };
    }
    const path =
      input.scenario === "native"
        ? "/v3/pay/transactions/native"
        : "/v3/pay/transactions/h5";
    let result: { status: number; json: unknown };
    try {
      result = await this.client.requestJson(
        "POST",
        path,
        JSON.stringify(body),
      );
    } catch (error) {
      return transportUnknown(error);
    }
    if (
      result.status !== 200 ||
      typeof result.json !== "object" ||
      result.json === null
    ) {
      return {
        kind: "unknown",
        reason: `create answered HTTP ${result.status}`,
        retryable: result.status >= 500 || result.status === 429,
      };
    }
    const field = input.scenario === "native" ? "code_url" : "h5_url";
    const value = (result.json as Record<string, unknown>)[field];
    if (typeof value !== "string" || value === "") {
      return {
        kind: "unknown",
        reason: `create answer lacks ${field}`,
        retryable: false,
      };
    }
    const actionExpiresAtUs = minUs(
      now + ACTION_TTL_US,
      input.orderExpiresAtUs,
    );
    return {
      kind: "action",
      actionType: input.scenario === "native" ? "code_url" : "h5_url",
      value,
      actionExpiresAtUs: actionExpiresAtUs.toString(),
      orderExpiresAtUs: input.orderExpiresAtUs.toString(),
      outTradeNo: input.outTradeNo,
    };
  }

  /**
   * Refresh an H5 (or Native) link: SAME out_trade_no, SAME amount, SAME order
   * deadline. Refuses expired orders and terminal states. When the previous
   * attempt's outcome is uncertain, the CALLER must queryPayment first — this
   * method only refuses when given a terminal fact.
   */
  async refreshPaymentLink(
    input: CreatePaymentInput,
    prior: { readonly terminal?: boolean } | undefined,
  ): Promise<PaymentActionResult> {
    if (parseTimestampUs(input.orderExpiresAtUs.toString()) <= this.nowUs()) {
      return { kind: "rejected", reason: "order_expired" };
    }
    if (prior?.terminal) {
      return { kind: "rejected", reason: "terminal_payment_state" };
    }
    return this.createPayment(input);
  }

  // ------------------------------------------------------------------- query

  /** 商户单号查单. Returns the verified payment fact or an explicit non-fact. */
  async queryPayment(outTradeNo: string): Promise<QueryPaymentResult> {
    const identity = this.client.identity;
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(identity.mchid)}`;
    let result: { status: number; json: unknown };
    try {
      result = await this.client.requestJson("GET", path, null);
    } catch (error) {
      return transportUnknown(error);
    }
    if (result.status === 404) return { kind: "not_found" };
    if (result.status !== 200) {
      return {
        kind: "unknown",
        reason: `query answered HTTP ${result.status}`,
        retryable: result.status >= 500 || result.status === 429,
      };
    }
    const body = result.json;
    if (typeof body !== "object" || body === null) {
      return {
        kind: "unknown",
        reason: "query body is not an object",
        retryable: false,
      };
    }
    const obj = body as Record<string, unknown>;
    const tradeState =
      typeof obj.trade_state === "string" ? obj.trade_state : null;
    if (tradeState === null) {
      return {
        kind: "unknown",
        reason: "query answer lacks trade_state",
        retryable: false,
      };
    }
    if (tradeState === "SUCCESS") {
      return this.verifiedFactFrom(obj, "query");
    }
    if (PAYMENT_PENDING_STATES.has(tradeState)) return { kind: "pending" };
    if (PAYMENT_CLOSED_STATES.has(tradeState)) return { kind: "closed" };
    return {
      kind: "unknown",
      reason: `unmapped trade_state ${tradeState}`,
      retryable: false,
    };
  }

  /**
   * Turn a SUCCESS trade object into a verified fact. ANY absent, illegal or
   * identity-inconsistent field degrades to identity_mismatch — never to a
   * verified payment. 金额采用交易总额; payer_total is kept separately.
   */
  verifiedFactFrom(
    obj: Record<string, unknown>,
    source: "query" | "notification",
  ): QueryPaymentResult {
    const identity = this.client.identity;
    try {
      const mchid = requireString(obj.mchid, "mchid");
      const appid = requireString(obj.appid, "appid");
      const outTradeNo = requireString(obj.out_trade_no, "out_trade_no");
      const transactionId = requireString(obj.transaction_id, "transaction_id");
      const amount = requireObject(obj.amount, "amount");
      const totalFen = parseWechatFen(amount.total, "amount.total");
      const currency = requireString(amount.currency, "amount.currency");
      const payerFen =
        amount.payer_total === undefined || amount.payer_total === null
          ? null
          : parseWechatFen(amount.payer_total, "amount.payer_total");
      const successTimeUs = parseWechatTimeUs(obj.success_time, "success_time");
      if (mchid !== identity.mchid || appid !== identity.appid) {
        return {
          kind: "identity_mismatch",
          reason: "channel trade does not name this merchant/application",
        };
      }
      if (currency !== "CNY") {
        return {
          kind: "identity_mismatch",
          reason: `currency ${currency} is not CNY`,
        };
      }
      const fact: VerifiedPaymentFact = {
        mchid,
        appid,
        outTradeNo,
        transactionId,
        totalFen,
        payerFen,
        currency: "CNY",
        successTimeUs,
        source,
      };
      return { kind: "verified_payment", fact };
    } catch (error) {
      return {
        kind: "identity_mismatch",
        reason:
          error instanceof Error ? error.message : "malformed SUCCESS trade",
      };
    }
  }

  // ------------------------------------------------------------------- close

  /**
   * 关单. Official success is an empty-body 204. Anything else (including
   * "already paid") is indeterminate here: the caller resolves with
   * queryPayment, whose verified fact is the ONLY authority on payment.
   */
  async closePayment(outTradeNo: string): Promise<ClosePaymentResult> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
    let result: { status: number };
    try {
      result = await this.client.requestJson(
        "POST",
        path,
        JSON.stringify({ mchid: this.client.identity.mchid }),
      );
    } catch (error) {
      return transportUnknown(error);
    }
    if (result.status === 204) return { kind: "closed" };
    // 400 ORDERPAID / 403 and any other competitive outcome: query decides.
    return {
      kind: "indeterminate_paid",
      reason: `close answered HTTP ${result.status}; payment state must be queried`,
    };
  }

  // ------------------------------------------------------------------ refund

  /**
   * 申请退款 with a caller-owned out_refund_no. On timeout the number is
   * REUSED for the follow-up query — never regenerated. A channel-side
   * parameter rejection is a refusal; a transport fault is an unknown.
   */
  async createRefund(input: {
    readonly outTradeNo: string;
    readonly outRefundNo: string;
    readonly refundFen: bigint;
    readonly totalFen: bigint;
    readonly reason?: string;
    readonly notifyUrl?: string;
  }): Promise<CreateRefundResult> {
    const body: Record<string, unknown> = {
      out_trade_no: input.outTradeNo,
      out_refund_no: input.outRefundNo,
      reason: input.reason,
      notify_url: input.notifyUrl,
      amount: {
        refund: toWechatJsonFen(input.refundFen, "amount.refund"),
        total: toWechatJsonFen(input.totalFen, "amount.total"),
        currency: "CNY",
      },
    };
    if (input.reason === undefined) delete body.reason;
    if (input.notifyUrl === undefined) delete body.notify_url;
    let result: { status: number; json: unknown };
    try {
      result = await this.client.requestJson(
        "POST",
        "/v3/refund/domestic/refunds",
        JSON.stringify(body),
      );
    } catch (error) {
      return transportUnknown(error);
    }
    if (
      result.status !== 200 ||
      typeof result.json !== "object" ||
      result.json === null
    ) {
      const refusalStatuses = new Set([400, 403, 404]);
      if (refusalStatuses.has(result.status)) {
        return {
          kind: "rejected",
          reason: `refund request refused with HTTP ${result.status}`,
        };
      }
      return {
        kind: "unknown",
        reason: `refund answered HTTP ${result.status}`,
        retryable: result.status >= 500 || result.status === 429,
      };
    }
    const obj = result.json as Record<string, unknown>;
    try {
      const outRefundNo = requireString(obj.out_refund_no, "out_refund_no");
      if (outRefundNo !== input.outRefundNo) {
        return {
          kind: "unknown",
          reason: "channel echoed a different out_refund_no",
          retryable: false,
        };
      }
      const status = typeof obj.status === "string" ? obj.status : "PROCESSING";
      return {
        kind: "accepted",
        outRefundNo,
        refundId: typeof obj.refund_id === "string" ? obj.refund_id : null,
        channelStatus: status,
      };
    } catch (error) {
      return {
        kind: "unknown",
        reason:
          error instanceof Error ? error.message : "malformed refund answer",
        retryable: false,
      };
    }
  }

  /** 查询退款 by the SAME out_refund_no. Five verdicts, ABNORMAL preserved. */
  async queryRefund(outRefundNo: string): Promise<QueryRefundResult> {
    const path = `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`;
    let result: { status: number; json: unknown };
    try {
      result = await this.client.requestJson("GET", path, null);
    } catch (error) {
      return transportUnknown(error);
    }
    if (result.status === 404) return { kind: "not_found" };
    if (result.status !== 200) {
      return {
        kind: "unknown",
        reason: `refund query answered HTTP ${result.status}`,
        retryable: result.status >= 500 || result.status === 429,
      };
    }
    const obj = result.json;
    if (typeof obj !== "object" || obj === null) {
      return {
        kind: "unknown",
        reason: "refund answer is not an object",
        retryable: false,
      };
    }
    return this.refundFromRecord(
      obj as Record<string, unknown>,
      "query",
      outRefundNo,
    );
  }

  refundFromRecord(
    obj: Record<string, unknown>,
    source: "query" | "notification",
    expectedOutRefundNo?: string,
  ): QueryRefundResult {
    try {
      const outRefundNo = requireString(obj.out_refund_no, "out_refund_no");
      if (
        expectedOutRefundNo !== undefined &&
        outRefundNo !== expectedOutRefundNo
      ) {
        return {
          kind: "unknown",
          reason: "channel echoed a different out_refund_no",
          retryable: false,
        };
      }
      const amount = requireObject(obj.amount, "amount");
      const refundFen = parseWechatFen(amount.refund, "amount.refund");
      const currency = requireString(amount.currency, "amount.currency");
      const channelState = requireString(obj.status, "status");
      const status =
        channelState === "SUCCESS"
          ? "succeeded"
          : channelState === "CLOSED"
            ? "failed"
            : channelState === "ABNORMAL"
              ? "abnormal"
              : channelState === "PROCESSING" || channelState === "AUDITING"
                ? "processing"
                : null;
      if (status === null) {
        return {
          kind: "unknown",
          reason: `unmapped refund status ${channelState}`,
          retryable: false,
        };
      }
      if (currency !== "CNY") {
        return {
          kind: "unknown",
          reason: `refund currency ${currency} is not CNY`,
          retryable: false,
        };
      }
      const successTimeUs =
        channelState === "SUCCESS" && obj.success_time !== undefined
          ? parseWechatTimeUs(obj.success_time, "success_time")
          : null;
      return {
        kind: "refund",
        outRefundNo,
        refundId: typeof obj.refund_id === "string" ? obj.refund_id : null,
        outTradeNo:
          typeof obj.out_trade_no === "string" ? obj.out_trade_no : "",
        refundFen,
        currency: "CNY",
        status,
        channelState,
        successTimeUs,
        source,
      };
    } catch (error) {
      return {
        kind: "unknown",
        reason:
          error instanceof Error ? error.message : "malformed refund record",
        retryable: false,
      };
    }
  }

  // -------------------------------------------------------------------- bill

  /**
   * 交易账单: signed metadata request, then a signed binary download verified
   * against the metadata SHA1 before anything is published. 202 = generating,
   * 404 = no bill that day, transport faults are recoverable failures.
   */
  async downloadTradeBill(request: {
    readonly billDate: string;
    readonly billType: "ALL" | "SUCCESS" | "REFUND";
  }): Promise<TradeBillResult> {
    const identity = this.client.identity;
    if (!/^\d{8}$/.test(request.billDate)) {
      return {
        kind: "failed",
        reason: "bill_date must be YYYYMMDD",
        retryable: false,
      };
    }
    const path =
      `/v3/bill/tradebill?bill_date=${encodeURIComponent(request.billDate)}` +
      `&bill_type=${encodeURIComponent(request.billType)}` +
      `&mchid=${encodeURIComponent(identity.mchid)}`;
    let meta: { status: number; json: unknown };
    try {
      meta = await this.client.requestJson("GET", path, null);
    } catch (error) {
      return transportFailed(error);
    }
    if (meta.status === 202) return { kind: "generating" };
    if (meta.status === 404) return { kind: "no_bill" };
    if (
      meta.status !== 200 ||
      typeof meta.json !== "object" ||
      meta.json === null
    ) {
      return {
        kind: "failed",
        reason: `tradebill metadata answered HTTP ${meta.status}`,
        retryable: meta.status >= 500 || meta.status === 429,
      };
    }
    const obj = meta.json as Record<string, unknown>;
    const hashType = typeof obj.hash_type === "string" ? obj.hash_type : "";
    const hashValue = typeof obj.hash_value === "string" ? obj.hash_value : "";
    const downloadUrl =
      typeof obj.download_url === "string" ? obj.download_url : "";
    if (hashType === "" || hashValue === "" || downloadUrl === "") {
      return {
        kind: "failed",
        reason: "tradebill metadata is missing digest fields",
        retryable: false,
      };
    }
    let file: WechatRawResponse;
    try {
      file = await this.client.downloadFile(
        downloadUrl,
        DOWNLOAD_ALLOWED_HOSTS,
      );
    } catch (error) {
      return transportFailed(error);
    }
    if (file.status !== 200) {
      return {
        kind: "failed",
        reason: `bill download answered HTTP ${file.status}`,
        retryable: file.status >= 500 || file.status === 429,
      };
    }
    const digest = verifyBillDigest(file.bodyBytes, hashType, hashValue);
    if (!digest.ok) {
      return { kind: "failed", reason: digest.reason, retryable: false };
    }
    let decoded: { content: Uint8Array };
    try {
      decoded = decodeBillBytes(file.bodyBytes);
    } catch (error) {
      return {
        kind: "failed",
        reason: error instanceof Error ? error.message : "bill decode failed",
        retryable: false,
      };
    }
    const destination = this.deps.billWorkspaceDir?.() ?? defaultWorkspace();
    const stem = `wechat-tradebill-${identity.mchid}-${request.billDate}-${request.billType}`;
    const { publishedPath } = publishBillFile(
      destination,
      stem,
      decoded.content,
    );
    return {
      kind: "bill",
      artifact: {
        mchid: identity.mchid,
        billDate: request.billDate,
        billType: request.billType,
        publishedPath,
        sha1: hashValue.toLowerCase(),
        byteLength: decoded.content.byteLength,
      },
    };
  }

  // ----------------------------------------------------------- notifications

  /**
   * Verify and decrypt an inbound notification from its EXACT raw bytes and
   * Wechatpay-* headers. Signature failure never yields a verified event. In
   * certificate mode an unknown serial triggers the controlled refresh and
   * exactly one re-verification; public-key ids are never refreshed (trusted
   * configuration only) and stay rejected.
   */
  async verifyNotification(
    rawBodyBytes: Uint8Array,
    headers: Record<string, string>,
    context: { readonly method: string; readonly pathWithQuery: string },
  ): Promise<NotificationVerification> {
    const rawBody = new TextDecoder("utf-8", { fatal: false }).decode(
      rawBodyBytes,
    );
    const serial = header(headers, "wechatpay-serial");
    const signature = header(headers, "wechatpay-signature");
    const timestamp = header(headers, "wechatpay-timestamp");
    const nonce = header(headers, "wechatpay-nonce");
    if (!serial || !signature || !timestamp || !nonce) {
      return {
        kind: "rejected",
        reason: "bad_request",
        detail: "missing a Wechatpay-* header",
      };
    }
    if (
      !timestampWithinWindow(
        this.nowUnixSeconds(),
        timestamp,
        this.client.skewLimit(),
      )
    ) {
      return {
        kind: "rejected",
        reason: "timestamp_out_of_window",
        detail: `timestamp ${timestamp}`,
      };
    }
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return {
          kind: "rejected",
          reason: "bad_structure",
          detail: "envelope is not an object",
        };
      }
      envelope = parsed as Record<string, unknown>;
    } catch {
      return {
        kind: "rejected",
        reason: "bad_structure",
        detail: "envelope is not JSON",
      };
    }
    const eventId = typeof envelope.id === "string" ? envelope.id : "";
    const eventType =
      typeof envelope.event_type === "string" ? envelope.event_type : "";
    if (eventId === "" || eventType === "") {
      return {
        kind: "rejected",
        reason: "bad_structure",
        detail: "envelope lacks id or event_type",
      };
    }
    const resourceObj = envelope.resource;
    if (typeof resourceObj !== "object" || resourceObj === null) {
      return {
        kind: "rejected",
        reason: "bad_structure",
        detail: "envelope lacks resource",
      };
    }
    const resource = resourceObj as Record<string, unknown>;

    const verifyWithSerial = (): "ok" | "unknown_serial" | "bad_signature" => {
      const nowSec = this.nowUnixSeconds();
      const selected = this.trustStore().select(serial, nowSec);
      if (!selected.ok) return "unknown_serial";
      return verifyWechatpaySignature({
        method: context.method,
        pathWithQuery: context.pathWithQuery,
        rawBody,
        timestampSec: timestamp,
        nonce,
        signatureB64: signature,
        publicKeyPem: selected.material.publicKeyPem,
      })
        ? "ok"
        : "bad_signature";
    };

    let verdict = verifyWithSerial();
    if (verdict === "unknown_serial" && !serial.startsWith("PUB_KEY_ID_")) {
      // Certificate mode only: one controlled refresh, then exactly one
      // re-verification. A refresh FAILURE stays a rejection — it must never
      // surface as a transport error (500) for a notification we never verified.
      try {
        await this.client.refreshPlatformCertificates(() =>
          this.fetchAndVerifyCertificates(),
        );
      } catch {
        return {
          kind: "rejected",
          reason: "unknown_serial",
          detail: "certificate refresh failed",
        };
      }
      verdict = verifyWithSerial();
    }
    if (verdict === "unknown_serial") {
      return {
        kind: "rejected",
        reason: "unknown_serial",
        detail: serialPrefix(serial),
      };
    }
    if (verdict === "bad_signature") {
      return {
        kind: "rejected",
        reason: "bad_signature",
        detail: serialPrefix(serial),
      };
    }

    let decrypted: Buffer;
    try {
      decrypted = decryptResource({
        algorithm:
          typeof resource.algorithm === "string" ? resource.algorithm : "",
        nonce: typeof resource.nonce === "string" ? resource.nonce : "",
        associatedData:
          typeof resource.associated_data === "string"
            ? resource.associated_data
            : null,
        ciphertext:
          typeof resource.ciphertext === "string" ? resource.ciphertext : "",
        apiv3Key: this.client.apiv3Key(),
      });
    } catch (error) {
      if (error instanceof WechatCryptoError) {
        return {
          kind: "rejected",
          reason:
            error.code === "unknown_algorithm"
              ? "unknown_algorithm"
              : "bad_gcm",
          detail: error.message,
        };
      }
      return {
        kind: "rejected",
        reason: "bad_gcm",
        detail: "decryption failed",
      };
    }
    let parsedDecrypted: unknown;
    try {
      parsedDecrypted = JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
      return {
        kind: "rejected",
        reason: "bad_structure",
        detail: "decrypted resource is not JSON",
      };
    }
    if (typeof parsedDecrypted !== "object" || parsedDecrypted === null) {
      return {
        kind: "rejected",
        reason: "bad_structure",
        detail: "decrypted resource is not an object",
      };
    }
    const decryptedObj = parsedDecrypted as Record<string, unknown>;
    if (
      typeof decryptedObj.out_trade_no !== "string" ||
      typeof decryptedObj.mchid !== "string"
    ) {
      return {
        kind: "rejected",
        reason: "bad_structure",
        detail: "decrypted resource lacks out_trade_no or mchid",
      };
    }
    const eventTimeUs =
      typeof envelope.event_time === "string"
        ? parseWechatTimeUs(envelope.event_time, "event_time")
        : null;
    const notification: VerifiedNotification = {
      eventId,
      eventType,
      resource: {
        algorithm: String(resource.algorithm),
        ciphertext: String(resource.ciphertext),
        associatedData:
          typeof resource.associated_data === "string"
            ? resource.associated_data
            : null,
        nonce: String(resource.nonce),
        originalType:
          typeof resource.original_type === "string"
            ? resource.original_type
            : null,
      },
      decrypted: decryptedObj,
      eventTimeUs,
    };
    return { kind: "verified", notification };
  }

  /**
   * Build the query-side fact from a verified TRANSACTION.SUCCESS notification
   * (shares the exact identity/field discipline with signed query answers).
   */
  paymentFactFromNotification(
    notification: VerifiedNotification,
  ): QueryPaymentResult {
    if (notification.eventType !== "TRANSACTION.SUCCESS") {
      return {
        kind: "identity_mismatch",
        reason: `event ${notification.eventType} is not a success payment event`,
      };
    }
    return this.verifiedFactFrom(notification.decrypted, "notification");
  }

  refundFromNotification(
    notification: VerifiedNotification,
  ): QueryRefundResult {
    if (!notification.eventType.startsWith("REFUND.")) {
      return {
        kind: "unknown",
        reason: `event ${notification.eventType} is not a refund event`,
        retryable: false,
      };
    }
    return this.refundFromRecord(notification.decrypted, "notification");
  }

  // ------------------------------------------------------------------ private

  private trustStore() {
    return this.client.trustStore;
  }

  private nowUnixSeconds(): bigint {
    return this.nowUs() / 1_000_000n;
  }

  /**
   * Fetch /v3/certificates, verifying the response signature against the
   * CURRENT trusted set before returning merge candidates. Certificate
   * contents are only structural candidates here; validity windows are
   * enforced by the trust store at selection time.
   */
  private async fetchAndVerifyCertificates() {
    const result = await this.client.requestJson(
      "GET",
      "/v3/certificates",
      null,
    );
    if (
      result.status !== 200 ||
      typeof result.json !== "object" ||
      result.json === null
    ) {
      return [];
    }
    const data = (result.json as Record<string, unknown>).data;
    if (!Array.isArray(data)) return [];
    const materials: {
      id: string;
      publicKeyPem: string;
      notBeforeSec: bigint | null;
      notAfterSec: bigint | null;
    }[] = [];
    for (const entry of data) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row.serial_no === "string" ? row.serial_no : "";
      const cert =
        typeof row.encrypt_certificate === "object" &&
        row.encrypt_certificate !== null
          ? (row.encrypt_certificate as Record<string, unknown>)
          : null;
      const effectiveTime =
        typeof row.effective_time === "string" ? row.effective_time : null;
      const expireTime =
        typeof row.expire_time === "string" ? row.expire_time : null;
      if (id === "" || cert === null) continue;
      // The certificate payload itself is encrypted; merging requires decrypting it.
      let pem: string;
      try {
        pem = decryptResource({
          algorithm: typeof cert.algorithm === "string" ? cert.algorithm : "",
          nonce: typeof cert.nonce === "string" ? cert.nonce : "",
          associatedData:
            typeof cert.associated_data === "string"
              ? cert.associated_data
              : null,
          ciphertext:
            typeof cert.ciphertext === "string" ? cert.ciphertext : "",
          apiv3Key: this.client.apiv3Key(),
        }).toString("utf8");
      } catch {
        continue;
      }
      materials.push({
        id,
        publicKeyPem: pem,
        notBeforeSec: effectiveTime === null ? null : secFromIso(effectiveTime),
        notAfterSec: expireTime === null ? null : secFromIso(expireTime),
      });
    }
    return materials;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function header(headers: Record<string, string>, name: string): string | null {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = headers[name.toLowerCase()];
  return lower === undefined ? null : lower;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${field} is missing or not a non-empty string`);
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} is missing or not an object`);
  }
  return value as Record<string, unknown>;
}

function minUs(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function isoFromUs(us: bigint): string {
  // time_expire carries second precision; exact microsecond math is preserved
  // by truncating downward with BigInt before any float conversion.
  return new Date(Number(us / 1_000_000n) * 1000).toISOString();
}

function secFromIso(iso: string): bigint {
  return BigInt(Date.parse(iso) >= 0 ? Math.floor(Date.parse(iso) / 1000) : 0);
}

function serialPrefix(serial: string): string {
  return serial.length <= 8 ? serial : `${serial.slice(0, 8)}…`;
}

/** Transport faults are UNKNOWN — never a business refusal, never a payment. */
function transportUnknown(error: unknown): {
  kind: "unknown";
  reason: string;
  retryable: boolean;
} {
  if (error instanceof WechatTransportError) {
    return {
      kind: "unknown",
      reason: `${error.classification}: ${error.message}`,
      retryable: error.classification !== "bad_signature",
    };
  }
  return { kind: "unknown", reason: "transport failure", retryable: true };
}

function transportFailed(error: unknown): {
  kind: "failed";
  reason: string;
  retryable: boolean;
} {
  if (error instanceof WechatTransportError) {
    return {
      kind: "failed",
      reason: `${error.classification}: ${error.message}`,
      retryable:
        error.classification === "timeout" ||
        error.classification === "network_error",
    };
  }
  return { kind: "failed", reason: "download failure", retryable: true };
}

function defaultWorkspace(): string {
  return defaultBillWorkspace();
}
