import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  splitAlipayResponse,
  verifyAlipayNotification,
  verifyAlipayResponse,
} from "../../../src/payments/alipay/signature";
import { parseAlipayStatement } from "../../../src/payments/alipay/statement";
import { buildTestZip, generateTestRsaMaterial } from "./helpers";

/**
 * A1/A3: the OFFICIAL verification vectors. The sample field sets, the
 * canonical to-be-signed strings and the byte shapes below are copied
 * VERBATIM from Alipay's official signing documentation (see
 * fixtures/official/README.md for source, version and expectations); the
 * signature values are re-created per run with throwaway keys because the
 * platform private key that made the originals is (rightly) unavailable.
 * These complement — they do not replace — the controlled-HTTP boundary
 * tests: one pins the rules to the official documented shape, the other
 * drives the production adapter against a live stand-in gateway.
 */

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "official");

const OFFICIAL_NOTIFY_URL_SAMPLE =
  "total_amount=2.00&buyer_id=2088102116773037&body=大乐透2.1&trade_no=2016071921001003030200089909&refund_fee=0.00&notify_time=2016-07-19 14:10:49&subject=大乐透2.1&sign_type=RSA2&charset=utf-8&notify_type=trade_status_sync&out_trade_no=0719141034-6418&gmt_close=2016-07-19 14:10:46&gmt_payment=2016-07-19 14:10:47&trade_status=TRADE_SUCCESS&version=1.0&sign=kPbQIjX+xQc8F0/A6/AocELIjhhZnGbcBN6G4MM/HmfWL4ZiHM6fWl5NQhzXJusaklZ1LFuMo+lHQUELAYeugH8LYFvxnNajOvZhuxNFbN2LhF0l/KL8ANtj8oyPM4NN7Qft2kWJTDJUpQOzCzNnV9hDxh5AaT9FPqRS6ZKxnzM=&gmt_create=2016-07-19 14:10:44&app_id=2015102700040153&seller_id=2088102119685838&notify_id=4a91b7a78a503640467525113fb7d8bg8e";

/** The canonical to-be-signed string, EXACTLY as the official doc prints it. */
const OFFICIAL_NOTIFY_SIGN_CONTENT =
  "body=大乐透2.1&buyer_id=2088102116773037&charset=utf-8&gmt_close=2016-07-19 14:10:46&gmt_payment=2016-07-19 14:10:47&notify_time=2016-07-19 14:10:49&notify_type=trade_status_sync&out_trade_no=0719141034-6418&refund_fee=0.00&subject=大乐透2.1&total_amount=2.00&trade_no=2016071921001003030200089909&trade_status=TRADE_SUCCESS&version=1.0";

/** The official sync-response sample, byte-for-byte including `\/` and layout. */
const OFFICIAL_SYNC_RESPONSE_BODY = `{"alipay_trade_precreate_response":{
  "code":"10000",
  "msg":"Success",
  "out_trade_no":"6141161365682511",
  "qr_code":"https:\\/\\/qr.alipay.com\\/bax03206ug0kulveltqc80a8"
},
 "sign":"SIGN_PLACEHOLDER"
}`;

/** The node bytes the official doc names as the to-be-verified payload. */
const OFFICIAL_SYNC_RESPONSE_NODE = `{
  "code":"10000",
  "msg":"Success",
  "out_trade_no":"6141161365682511",
  "qr_code":"https:\\/\\/qr.alipay.com\\/bax03206ug0kulveltqc80a8"
}`;

const OFFICIAL_DOC_URL = "https://opendocs.alipay.com/common/02mse7";
const OFFICIAL_DOC_UPDATED = "2026-03-26";

function officialNotifyFields(): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(OFFICIAL_NOTIFY_URL_SAMPLE)) {
    fields[k] = v;
  }
  return fields;
}

describe("official fixture traceability (A1)", () => {
  let readme: string;
  beforeAll(() => {
    readme = readFileSync(join(FIXTURE_DIR, "README.md"), "utf8");
  });

  test("the fixtures cite the official source and its recorded version", () => {
    for (const doc of ["async-notify-sample.md", "sync-response-sample.md"]) {
      const text = readFileSync(join(FIXTURE_DIR, doc), "utf8");
      expect(text).toContain(OFFICIAL_DOC_URL);
      expect(text).toContain(OFFICIAL_DOC_UPDATED);
    }
    expect(readme).toContain("02mse7");
    expect(readme).toContain("2026-03-26");
    // The bill fixture is honestly labelled: official FORMAT, desensitised
    // bytes, exact-sample verification deferred to the merchant closed loop.
    expect(readme).toContain("脱敏重构");
  });

  test("the official canonical string matches the rule output on its own fields", () => {
    // The official example is internally inconsistent — its step-2 string
    // omits app_id, gmt_create, notify_id and seller_id, which its own
    // step-1 sample carries and the RULE (all params minus sign/sign_type)
    // includes. So this asserts the format and ordering on exactly the
    // fields the official string does contain: applying our rule to those
    // keys must reproduce the official string byte for byte.
    const fields = officialNotifyFields();
    delete fields.sign;
    delete fields.sign_type;
    const officialKeys = new Set(
      OFFICIAL_NOTIFY_SIGN_CONTENT.split("&").map((pair) =>
        pair.slice(0, pair.indexOf("=")),
      ),
    );
    const restricted = Object.keys(fields)
      .filter((k) => officialKeys.has(k))
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("&");
    expect(restricted).toBe(OFFICIAL_NOTIFY_SIGN_CONTENT);
    // And the rule the verifier actually runs includes the four extra
    // fields, in sorted position.
    const full = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("&");
    expect(full.split("&").length).toBe(
      OFFICIAL_NOTIFY_SIGN_CONTENT.split("&").length + 4,
    );
  });
});

describe("official async-notification vector (A1/A3)", () => {
  const alipay = generateTestRsaMaterial();

  /** The official fields minus sign/sign_type, per the official rule. */
  function officialRuleContent(fields: Record<string, string>): string {
    return Object.keys(fields)
      .filter((k) => k !== "sign" && k !== "sign_type" && fields[k] !== "")
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("&");
  }

  test("the official field set verifies under the production verifier", () => {
    const fields = officialNotifyFields();
    const sign = createSign("RSA-SHA256")
      .update(officialRuleContent(fields), "utf8")
      .sign(alipay.alipayPrivateKey, "base64");
    expect(
      verifyAlipayNotification(
        { ...fields, sign_type: "RSA2", sign },
        alipay.alipayPublicKey,
      ),
    ).toBe(true);
  });

  test("any flipped value breaks the official vector", () => {
    const fields = officialNotifyFields();
    const flipped = { ...fields, total_amount: "0.01" }; // flipped after signing
    const sign = createSign("RSA-SHA256")
      .update(officialRuleContent(fields), "utf8")
      .sign(alipay.alipayPrivateKey, "base64");
    expect(
      verifyAlipayNotification(
        { ...flipped, sign_type: "RSA2", sign },
        alipay.alipayPublicKey,
      ),
    ).toBe(false);
  });
});

describe("official sync-response vector (A1)", () => {
  const alipay = generateTestRsaMaterial();

  test("the official byte shape (escaped slashes, doc layout) verifies", () => {
    // Sign the node bytes EXACTLY as the official doc prints them — the
    // `\/` escapes and the newlines are part of what the gateway signs.
    const sign = createSign("RSA-SHA256")
      .update(OFFICIAL_SYNC_RESPONSE_NODE, "utf8")
      .sign(alipay.alipayPrivateKey, "base64");
    const raw = OFFICIAL_SYNC_RESPONSE_BODY.replace("SIGN_PLACEHOLDER", sign);
    expect(
      verifyAlipayResponse(
        raw,
        "alipay_trade_precreate_response",
        alipay.alipayPublicKey,
      ),
    ).toBe(true);
  });

  test("a re-serialized response with the same data FAILS verification", () => {
    const sign = createSign("RSA-SHA256")
      .update(OFFICIAL_SYNC_RESPONSE_NODE, "utf8")
      .sign(alipay.alipayPrivateKey, "base64");
    const raw = OFFICIAL_SYNC_RESPONSE_BODY.replace("SIGN_PLACEHOLDER", sign);
    // Same DATA, different BYTES: JSON round-trip reorders nothing here but
    // compacts whitespace and un-escapes the slashes — the official rule
    // says verify the ORIGINAL bytes, so this must not pass.
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect(reserialized).not.toBe(raw);
    expect(
      verifyAlipayResponse(
        reserialized,
        "alipay_trade_precreate_response",
        alipay.alipayPublicKey,
      ),
    ).toBe(false);
  });

  test("the signed payload the verifier checks is the official node text", () => {
    // Split the response the way production does and hash what it cut out:
    // it must equal the sha256 of the exact bytes the official doc names.
    const sign = createSign("RSA-SHA256")
      .update(OFFICIAL_SYNC_RESPONSE_NODE, "utf8")
      .sign(alipay.alipayPrivateKey, "base64");
    const raw = OFFICIAL_SYNC_RESPONSE_BODY.replace("SIGN_PLACEHOLDER", sign);
    const split = splitAlipayResponse(raw, "alipay_trade_precreate_response");
    expect(createHash("sha256").update(split.responseData).digest("hex")).toBe(
      createHash("sha256").update(OFFICIAL_SYNC_RESPONSE_NODE).digest("hex"),
    );
    expect(split.sign).toBe(sign);
  });
});

describe("official bill-format fixture (A6)", () => {
  const identity = {
    app_id: "2021000198765432",
    seller_id: "2088102119685838",
  };

  test("the GBK official-shape bill parses to its documented rows", () => {
    const csvBytes = readFileSync(
      join(FIXTURE_DIR, "2088102119685838_交易明细_20260101.csv"),
    );
    // Real bills arrive GBK-encoded inside a ZIP; decode must survive it.
    expect(new TextDecoder("utf-8").decode(csvBytes)).not.toContain("支付宝");
    const zip = buildTestZip([
      { name: "2088102119685838_交易明细_20260101.csv", content: csvBytes },
    ]);
    const parsed = parseAlipayStatement(zip, "2026-01-01", identity);
    expect(parsed.digest.row_count).toBe(2);
    expect(parsed.digest.app_id).toBe(identity.app_id);
    expect(parsed.digest.seller_id).toBe(identity.seller_id);
    const [pay, refund] = parsed.rows;
    expect(pay.direction).toBe("pay");
    expect(pay.amount_fen).toBe("200");
    expect(pay.merchant_reference).toBe("order-2026-0101-0001");
    expect(pay.provider_transaction_id).toBe("2026010122001400001234");
    expect(pay.refund_request_no).toBe(null);
    expect(pay.source_line).toBe(5);
    expect(refund.direction).toBe("refund");
    expect(refund.amount_fen).toBe("50");
    expect(refund.refund_request_no).toBe("refund-2026-0101-0001");
    expect(refund.source_line).toBe(6);
  });

  test("the bill fixture fails wholesale when a required column is missing", () => {
    const csvBytes = readFileSync(
      join(FIXTURE_DIR, "2088102119685838_交易明细_20260101.csv"),
    );
    const text = new TextDecoder("gbk").decode(csvBytes);
    // Drop ONLY the 金额(元) column (header cell and every data cell), so
    // the header row is still recognisable and the failure names the
    // missing REQUIRED column, not an unreadable header.
    const withoutAmount = text
      .split(/\r?\n/)
      .map((line) => {
        const cells = line.split(",");
        const at = cells.indexOf("金额(元)");
        if (at === -1) return line;
        cells.splice(at, 1);
        return cells.join(",");
      })
      .join("\n");
    expect(withoutAmount).not.toContain("金额(元)");
    const zip = buildTestZip([
      {
        name: "bill.csv",
        content: Buffer.from(withoutAmount, "utf8"),
      },
    ]);
    expect(() => parseAlipayStatement(zip, "2026-01-01", identity)).toThrow(
      /required column/,
    );
  });
});
