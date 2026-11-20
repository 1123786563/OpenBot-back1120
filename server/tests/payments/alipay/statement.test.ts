import { afterAll, describe, expect, test } from "bun:test";
import {
  AlipayStatementError,
  createAlipayStatementFetcher,
  parseAlipayStatement,
} from "../../../src/payments/alipay/statement";
import {
  buildTestZip,
  generateTestRsaMaterial,
  type TestRsaMaterial,
  testAlipayConfig,
} from "./helpers";

/**
 * A6: bill download and parsing against a controlled loopback download
 * service holding real ZIP/CSV fixtures in the official shape.
 */

const material: TestRsaMaterial = generateTestRsaMaterial();
const config = testAlipayConfig(material, "http://127.0.0.1/gateway.do");

/** The trusted merchant identity every parse must carry in its digest. */
const IDENTITY = { app_id: config.appId, seller_id: config.sellerId };

/** A trade-bill CSV fixture in the official shape (header comment, columns, rows). */
const BILL_CSV = [
  "#支付宝交易明细列表",
  "#账单日期：2026-11-19",
  "支付宝交易号,商户订单号,业务发生时间,收/支,金额(元),退款批次号",
  "2026111922001400001,order-2026-1119-0001,2026-11-19 21:00:05,收入,10.10,",
  "2026111922001400001,order-2026-1119-0001,2026-11-19 22:10:00,支出,5.00,refund-2026-1119-0001",
  "#流水总数：2",
].join("\r\n");

describe("statement download boundary", () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bill.zip") {
        const zip = buildTestZip([
          {
            name: "2088000000000000_交易明细_20261119.csv",
            content: new TextEncoder().encode(BILL_CSV),
          },
        ]);
        return new Response(zip, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (url.pathname === "/too-big") {
        return new Response(new Uint8Array(70 * 1024 * 1024));
      }
      if (url.pathname === "/redirect") {
        return new Response(null, {
          status: 302,
          headers: { location: "/bill.zip" },
        });
      }
      if (url.pathname === "/truncated") {
        const zip = buildTestZip([
          { name: "bill.csv", content: new TextEncoder().encode(BILL_CSV) },
        ]);
        // Simulate an interrupted download: cut the central directory off.
        return new Response(zip.slice(0, 40));
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  afterAll(() => server.stop(true));

  test("a whitelisted HTTPS-form loopback host downloads and parses", async () => {
    // The loopback fetcher is exercised via the host whitelist; production
    // hosts are download.alipay.com and kin.
    const fetcher = createAlipayStatementFetcher({
      ...config,
      statementDownloadHosts: [`127.0.0.1:${server.port}`],
    });
    const bytes = await fetcher.fetch(`${base}/bill.zip`);
    expect(bytes.status).toBe(200);
    const parsed = parseAlipayStatement(bytes.bytes, "2026-11-19", IDENTITY);
    expect(parsed.digest.row_count).toBe(2);
    expect(parsed.digest.bill_date).toBe("2026-11-19");
    expect(parsed.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The digest carries the TRUSTED merchant identity (from configuration,
    // not from the bill), so same-date results of different merchants stay
    // independently attributable.
    expect(parsed.digest.app_id).toBe(config.appId);
    expect(parsed.digest.seller_id).toBe(config.sellerId);
  });

  test("a host off the whitelist is refused before any request", async () => {
    const fetcher = createAlipayStatementFetcher(config);
    await expect(fetcher.fetch(`${base}/bill.zip`)).rejects.toThrow(
      AlipayStatementError,
    );
  });

  test("a non-HTTPS address on a real host is refused", async () => {
    const fetcher = createAlipayStatementFetcher(config);
    await expect(
      fetcher.fetch("http://download.alipay.com/bill/20261119.zip"),
    ).rejects.toThrow(/HTTPS/);
  });

  test("oversized archives are refused", async () => {
    const fetcher = createAlipayStatementFetcher({
      ...config,
      statementDownloadHosts: [`127.0.0.1:${server.port}`],
    });
    await expect(fetcher.fetch(`${base}/too-big`)).rejects.toThrow(
      /size limit/,
    );
  });

  test("redirects are refused, not followed", async () => {
    const fetcher = createAlipayStatementFetcher({
      ...config,
      statementDownloadHosts: [`127.0.0.1:${server.port}`],
    });
    await expect(fetcher.fetch(`${base}/redirect`)).rejects.toThrow(
      AlipayStatementError,
    );
  });

  test("an interrupted download cannot be parsed as a bill", async () => {
    const fetcher = createAlipayStatementFetcher({
      ...config,
      statementDownloadHosts: [`127.0.0.1:${server.port}`],
    });
    const bytes = await fetcher.fetch(`${base}/truncated`);
    expect(() =>
      parseAlipayStatement(bytes.bytes, "2026-11-19", IDENTITY),
    ).toThrow(/central directory/);
  });
});

describe("statement parsing (A6)", () => {
  const zipOf = (csv: string, name = "bill.csv") =>
    buildTestZip([{ name, content: new TextEncoder().encode(csv) }]);

  test("pay and refund rows carry verifiable identity and source lines", () => {
    const parsed = parseAlipayStatement(
      zipOf(BILL_CSV),
      "2026-11-19",
      IDENTITY,
    );
    expect(parsed.rows.length).toBe(2);
    const [pay, refund] = parsed.rows;
    expect(pay.direction).toBe("pay");
    expect(pay.provider_transaction_id).toBe("2026111922001400001");
    expect(pay.merchant_reference).toBe("order-2026-1119-0001");
    expect(pay.amount_fen).toBe("1010");
    expect(pay.refund_request_no).toBe(null);
    expect(pay.occurred_at_us).toBe(
      String(Date.UTC(2026, 10, 19, 13, 0, 5) * 1000),
    );
    expect(pay.source_file).toBe("bill.csv");
    expect(pay.source_line).toBe(4); // 1-based, counting the two # comment lines and the header row
    expect(refund.direction).toBe("refund");
    expect(refund.amount_fen).toBe("500");
    expect(refund.refund_request_no).toBe("refund-2026-1119-0001");
    expect(refund.source_line).toBe(5);
  });

  test("quoted CSV cells with commas survive", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支,金额(元),退款批次号",
      '2026111922001400001,"order,with-commas",2026-11-19 21:00:05,收入,10.10,',
    ].join("\n");
    const parsed = parseAlipayStatement(zipOf(csv), "2026-11-19", IDENTITY);
    expect(parsed.rows[0].merchant_reference).toBe("order,with-commas");
  });

  test("an archive with no CSV fails as an unsupported format", () => {
    const zip = buildTestZip([
      { name: "readme.txt", content: new TextEncoder().encode("hello") },
    ]);
    expect(() => parseAlipayStatement(zip, "2026-11-19", IDENTITY)).toThrow(
      /no CSV/,
    );
  });

  test("a missing required column fails the WHOLE bill, not just a row", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支",
      "2026111922001400001,order-1,2026-11-19 21:00:05,收入",
    ].join("\n");
    expect(() =>
      parseAlipayStatement(zipOf(csv), "2026-11-19", IDENTITY),
    ).toThrow(/required column/);
  });

  test("a non-exact amount fails the bill — no rounding, no forgiveness", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支,金额(元),退款批次号",
      "2026111922001400001,order-1,2026-11-19 21:00:05,收入,10.101,",
    ].join("\n");
    expect(() =>
      parseAlipayStatement(zipOf(csv), "2026-11-19", IDENTITY),
    ).toThrow(/non-exact amount/);
  });

  test("an unknown direction fails the bill", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支,金额(元),退款批次号",
      "2026111922001400001,order-1,2026-11-19 21:00:05,其他,10.10,",
    ].join("\n");
    expect(() =>
      parseAlipayStatement(zipOf(csv), "2026-11-19", IDENTITY),
    ).toThrow(/unknown direction/);
  });

  test("an unreadable time fails the bill", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支,金额(元),退款批次号",
      "2026111922001400001,order-1,2026-02-30 21:00:05,收入,10.10,",
    ].join("\n");
    expect(() =>
      parseAlipayStatement(zipOf(csv), "2026-11-19", IDENTITY),
    ).toThrow(/unreadable time/);
  });

  test("a ragged row fails the bill with its line number", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支,金额(元),退款批次号",
      "2026111922001400001,order-1,2026-11-19 21:00:05,收入",
    ].join("\n");
    expect(() =>
      parseAlipayStatement(zipOf(csv), "2026-11-19", IDENTITY),
    ).toThrow(/cells/);
  });

  test("a non-UTF-8, non-GBK file is refused, not decoded into noise", () => {
    // Bytes that are invalid in both encodings (0xFF has no GBK lead pairing here).
    const zip = buildTestZip([
      { name: "bill.csv", content: new Uint8Array([0xff, 0xfe, 0x00, 0x81]) },
    ]);
    expect(() => parseAlipayStatement(zip, "2026-11-19", IDENTITY)).toThrow(
      /GBK|UTF-8/,
    );
  });

  test("an entry name with a path is refused as traversal, never unpacked", () => {
    // The zip reader refuses entry names carrying path separators entirely.
    const hostile = buildTestZip([
      { name: "../escape.csv", content: new TextEncoder().encode(BILL_CSV) },
    ]);
    expect(() => parseAlipayStatement(hostile, "2026-11-19", IDENTITY)).toThrow(
      /path/,
    );
  });

  test("digest binds rows to the exact archive bytes", () => {
    const a = parseAlipayStatement(zipOf(BILL_CSV), "2026-11-19", IDENTITY);
    const b = parseAlipayStatement(
      zipOf(`${BILL_CSV}\r\n`),
      "2026-11-19",
      IDENTITY,
    );
    expect(a.digest.sha256).not.toBe(b.digest.sha256);
    expect(a.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a flipped content byte fails the entry's CRC-32, not reconciliation", () => {
    // Corrupt one byte INSIDE the stored CSV data: the directory still
    // records the original CRC, so the content no longer matches what the
    // archive vouches for — a plausible amount nobody wrote must not parse.
    const zip = zipOf(BILL_CSV);
    const marker = new TextEncoder().encode("10.10");
    const at = findSubarray(zip, marker);
    expect(at).toBeGreaterThan(0);
    const corrupted = new Uint8Array(zip);
    corrupted[at] = corrupted[at]! ^ 0x01; // flip one bit of the amount
    expect(() =>
      parseAlipayStatement(corrupted, "2026-11-19", IDENTITY),
    ).toThrow(/CRC-32/);
  });

  test("a directory that lies about the uncompressed size fails the archive", () => {
    const zip = zipOf(BILL_CSV);
    // Patch the central-directory header's 32-bit uncompressed-size field
    // (offset 24 inside the PK\x01\x02 record) to disagree with the entry.
    const corrupted = new Uint8Array(zip);
    const central = lastCentralDirectoryOffset(corrupted);
    expect(central).toBeGreaterThan(0);
    new DataView(corrupted.buffer).setUint32(central + 24, 99999, true);
    expect(() =>
      parseAlipayStatement(corrupted, "2026-11-19", IDENTITY),
    ).toThrow(/declares/);
  });

  test("a corrupted deflate stream fails the archive, never a partial file", () => {
    // A real deflate entry with one flipped byte in the compressed stream:
    // the inflate itself or the CRC check must fail the WHOLE archive.
    const zip = buildTestZip([
      {
        name: "bill.csv",
        content: new TextEncoder().encode(BILL_CSV),
        deflate: true,
      },
    ]);
    const corrupted = new Uint8Array(zip);
    // The compressed data sits between the local header and the central
    // directory; flipping a byte there cannot yield the signed-off content.
    const centralAt = lastCentralDirectoryOffset(corrupted);
    const dataAt = 30 + "bill.csv".length;
    corrupted[dataAt + Math.floor((centralAt - dataAt) / 2)] ^= 0xff;
    expect(() =>
      parseAlipayStatement(corrupted, "2026-11-19", IDENTITY),
    ).toThrow(/decompress|declares|CRC-32/);
  });

  test("an entry inflating past the size limit fails before parsing", () => {
    // Declared 200 MB uncompressed (over the 128 MB parse bound): refused
    // on the directory's word alone, before any decompression runs.
    const zip = buildTestZip([
      {
        name: "bill.csv",
        content: new TextEncoder().encode(BILL_CSV),
        deflate: true,
      },
    ]);
    const patched = new Uint8Array(zip);
    new DataView(patched.buffer).setUint32(
      lastCentralDirectoryOffset(patched) + 24,
      200 * 1024 * 1024,
      true,
    );
    expect(() => parseAlipayStatement(patched, "2026-11-19", IDENTITY)).toThrow(
      /over the limit/,
    );
  });
});

/** Offset of the last central-directory file header (PK\x01\x02) in a zip. */
function lastCentralDirectoryOffset(zip: Uint8Array): number {
  for (let i = zip.length - 4; i >= 0; i--) {
    if (
      zip[i] === 0x50 &&
      zip[i + 1] === 0x4b &&
      zip[i + 2] === 0x01 &&
      zip[i + 3] === 0x02
    ) {
      return i;
    }
  }
  return -1;
}

/** First offset of `needle` inside `haystack`, or -1. */
function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
