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
    const parsed = parseAlipayStatement(bytes.bytes, "2026-11-19");
    expect(parsed.digest.row_count).toBe(2);
    expect(parsed.digest.bill_date).toBe("2026-11-19");
    expect(parsed.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
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
    expect(() => parseAlipayStatement(bytes.bytes, "2026-11-19")).toThrow(
      /central directory/,
    );
  });
});

describe("statement parsing (A6)", () => {
  const zipOf = (csv: string, name = "bill.csv") =>
    buildTestZip([{ name, content: new TextEncoder().encode(csv) }]);

  test("pay and refund rows carry verifiable identity and source lines", () => {
    const parsed = parseAlipayStatement(zipOf(BILL_CSV), "2026-11-19");
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
    const parsed = parseAlipayStatement(zipOf(csv), "2026-11-19");
    expect(parsed.rows[0].merchant_reference).toBe("order,with-commas");
  });

  test("an archive with no CSV fails as an unsupported format", () => {
    const zip = buildTestZip([
      { name: "readme.txt", content: new TextEncoder().encode("hello") },
    ]);
    expect(() => parseAlipayStatement(zip, "2026-11-19")).toThrow(/no CSV/);
  });

  test("a missing required column fails the WHOLE bill, not just a row", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支",
      "2026111922001400001,order-1,2026-11-19 21:00:05,收入",
    ].join("\n");
    expect(() => parseAlipayStatement(zipOf(csv), "2026-11-19")).toThrow(
      /required column/,
    );
  });

  test("a non-exact amount fails the bill — no rounding, no forgiveness", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支,金额(元),退款批次号",
      "2026111922001400001,order-1,2026-11-19 21:00:05,收入,10.101,",
    ].join("\n");
    expect(() => parseAlipayStatement(zipOf(csv), "2026-11-19")).toThrow(
      /non-exact amount/,
    );
  });

  test("an unknown direction fails the bill", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支,金额(元),退款批次号",
      "2026111922001400001,order-1,2026-11-19 21:00:05,其他,10.10,",
    ].join("\n");
    expect(() => parseAlipayStatement(zipOf(csv), "2026-11-19")).toThrow(
      /unknown direction/,
    );
  });

  test("an unreadable time fails the bill", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支,金额(元),退款批次号",
      "2026111922001400001,order-1,2026-02-30 21:00:05,收入,10.10,",
    ].join("\n");
    expect(() => parseAlipayStatement(zipOf(csv), "2026-11-19")).toThrow(
      /unreadable time/,
    );
  });

  test("a ragged row fails the bill with its line number", () => {
    const csv = [
      "支付宝交易号,商户订单号,业务发生时间,收/支,金额(元),退款批次号",
      "2026111922001400001,order-1,2026-11-19 21:00:05,收入",
    ].join("\n");
    expect(() => parseAlipayStatement(zipOf(csv), "2026-11-19")).toThrow(
      /cells/,
    );
  });

  test("a non-UTF-8, non-GBK file is refused, not decoded into noise", () => {
    // Bytes that are invalid in both encodings (0xFF has no GBK lead pairing here).
    const zip = buildTestZip([
      { name: "bill.csv", content: new Uint8Array([0xff, 0xfe, 0x00, 0x81]) },
    ]);
    expect(() => parseAlipayStatement(zip, "2026-11-19")).toThrow(/GBK|UTF-8/);
  });

  test("an entry name with a path is refused as traversal, never unpacked", () => {
    // The zip reader refuses entry names carrying path separators entirely.
    const hostile = buildTestZip([
      { name: "../escape.csv", content: new TextEncoder().encode(BILL_CSV) },
    ]);
    expect(() => parseAlipayStatement(hostile, "2026-11-19")).toThrow(/path/);
  });

  test("digest binds rows to the exact archive bytes", () => {
    const a = parseAlipayStatement(zipOf(BILL_CSV), "2026-11-19");
    const b = parseAlipayStatement(zipOf(`${BILL_CSV}\r\n`), "2026-11-19");
    expect(a.digest.sha256).not.toBe(b.digest.sha256);
    expect(a.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
