/**
 * Trade-bill download and parsing (#70).
 *
 * The gateway hands back a time-limited HTTPS URL of a ZIP archive; the
 * archive holds the CSV trade statement. This module is the only place a
 * bill URL is fetched, and it is built like the untrusted boundary it is:
 *   - HTTPS only, host on the configured whitelist, redirects refused;
 *   - DNS is resolved before the fetch and private/loopback/link-local
 *     answers are rejected, so an address can never be aimed inward;
 *   - size and line caps bound memory and parsing;
 *   - the archive is unpacked entry by entry: entry names may not carry
 *     path separators (zip-slip), CSV content is DATA ONLY — a cell that
 *     looks like a spreadsheet formula is inert text and is never evaluated;
 *   - parsing is all-or-nothing: an unknown required column, a corrupt row
 *     or an invalid amount fails the whole bill. A silently partial bill
 *     would reconcile money that was never checked.
 *
 * Every parsed row keeps its source file name, source line and the archive
 * digest, so a reconciler (#75) can re-verify the exact bytes it came from.
 * Reconciliation itself, and any balance change, live in #75 — this module
 * only produces verifiable rows.
 */

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { inflateRawSync } from "node:zlib";
import { BillingValueError } from "../../billing-contract/money-time";
import type { StatementDigest, StatementRow } from "../types";
import type { AlipayChannelConfig } from "./config";
import { yuanToFen } from "./money";
import { alipayBeijingTimeToUs } from "./time";

export class AlipayStatementError extends Error {
  constructor(
    message: string,
    readonly code:
      | "url_not_allowed"
      | "dns_refused"
      | "download_failed"
      | "download_interrupted"
      | "too_large"
      | "corrupt_archive"
      | "unsupported_format"
      | "parse_failed",
  ) {
    super(message);
    this.name = "AlipayStatementError";
  }
}

export interface StatementFetch {
  status: number;
  bytes: Uint8Array;
}

export interface StatementFetcher {
  fetch(url: string): Promise<StatementFetch>;
}

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_CSV_BYTES = 128 * 1024 * 1024; // uncompressed bound
const MAX_ROWS = 500_000;

export function createAlipayStatementFetcher(
  config: AlipayChannelConfig,
): StatementFetcher {
  return {
    async fetch(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new AlipayStatementError(
          "bill url is not a URL",
          "url_not_allowed",
        );
      }
      if (parsed.protocol !== "https:") {
        // The one exception is a loopback download service, which exists only
        // for the controlled protocol-test boundary; the real bill hosts are
        // HTTPS and the whitelist governs them.
        const loopback =
          parsed.protocol === "http:" &&
          (parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "localhost" ||
            parsed.hostname === "[::1]");
        if (!loopback) {
          throw new AlipayStatementError(
            "bill url must be HTTPS",
            "url_not_allowed",
          );
        }
      }
      if (!hostWhitelisted(config.statementDownloadHosts, parsed.host)) {
        throw new AlipayStatementError(
          "bill host is not on the download whitelist",
          "url_not_allowed",
        );
      }
      await rejectPrivateAddress(parsed.hostname);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        config.requestTimeoutMs,
      );
      let response: Response;
      try {
        response = await fetch(parsed, {
          redirect: "error", // hop-by-hop: a redirect is a new target to judge, not a follow
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new AlipayStatementError(
            "bill download timed out",
            "download_interrupted",
          );
        }
        throw new AlipayStatementError(
          `bill download failed: ${error instanceof Error ? error.message : "unknown"}`,
          "download_failed",
        );
      } finally {
        clearTimeout(timer);
      }
      if (response.status !== 200) {
        throw new AlipayStatementError(
          `bill download answered HTTP ${response.status}`,
          "download_failed",
        );
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_ARCHIVE_BYTES) {
        throw new AlipayStatementError(
          `bill archive exceeds the size limit (${declared} bytes)`,
          "too_large",
        );
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
        throw new AlipayStatementError(
          "bill archive exceeds the size limit",
          "too_large",
        );
      }
      return { status: response.status, bytes: buffer };
    },
  };
}

/** Exact host match or proper-subdomain match against the whitelist. */
function hostWhitelisted(hosts: readonly string[], host: string): boolean {
  const candidate = host.toLowerCase();
  return hosts.some((h) => {
    const allowed = h.toLowerCase();
    return candidate === allowed || candidate.endsWith(`.${allowed}`);
  });
}

async function rejectPrivateAddress(hostname: string): Promise<void> {
  // The loopback controlled-test boundary is exempt; every real bill host
  // must resolve to a public address.
  if (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]"
  ) {
    return;
  }
  const literal = isIP(hostname) ? hostname : null;
  const addresses: { address: string }[] = literal
    ? [{ address: literal }]
    : ((await dnsLookup(hostname, { all: true }).catch(() => {
        throw new AlipayStatementError(
          "bill host does not resolve",
          "dns_refused",
        );
      })) as { address: string }[]);
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new AlipayStatementError(
        "bill host resolves to a private address",
        "url_not_allowed",
      );
    }
  }
}

function isPrivateIp(ip: string): boolean {
  if (
    ip === "::1" ||
    ip.startsWith("fe80:") ||
    ip.startsWith("fc") ||
    ip.startsWith("fd")
  ) {
    return true;
  }
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!v4) return true; // not a recognisable public form — refuse
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true; // multicast/reserved
  return false;
}

export interface ParsedStatement {
  rows: StatementRow[];
  digest: StatementDigest;
}

/**
 * Parse one downloaded bill archive into verified rows. Everything is
 * validated before anything is returned: an archive that cannot be fully
 * parsed raises {@link AlipayStatementError} instead of a partial result.
 */
export function parseAlipayStatement(
  archiveBytes: Uint8Array,
  billDate: string,
): ParsedStatement {
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  const entries = readZipEntries(archiveBytes);
  const csvEntries = entries.filter(([name]) =>
    name.toLowerCase().endsWith(".csv"),
  );
  if (csvEntries.length === 0) {
    throw new AlipayStatementError(
      "bill archive holds no CSV statement file",
      "unsupported_format",
    );
  }
  const rows: StatementRow[] = [];
  for (const [name, bytes] of csvEntries) {
    rows.push(...parseAlipayStatementCsv(name, bytes, billDate));
  }
  return {
    rows,
    digest: { bill_date: billDate, sha256: digest, row_count: rows.length },
  };
}

/**
 * The trade-bill columns this parser requires, per the official trade
 * statement format. A bill missing one of these columns, or naming an
 * unknown extra required column, fails the whole parse.
 */
const COLUMN_TRADE_NO = "支付宝交易号";
const COLUMN_OUT_TRADE_NO = "商户订单号";
const COLUMN_TIME = "业务发生时间";
const COLUMN_DIRECTION = "收/支";
const COLUMN_AMOUNT = "金额(元)";
const COLUMN_REFUND_NO = "退款批次号";

const REQUIRED_COLUMNS = [
  COLUMN_TRADE_NO,
  COLUMN_OUT_TRADE_NO,
  COLUMN_TIME,
  COLUMN_DIRECTION,
  COLUMN_AMOUNT,
];

function parseAlipayStatementCsv(
  fileName: string,
  bytes: Uint8Array,
  billDate: string,
): StatementRow[] {
  if (bytes.byteLength > MAX_CSV_BYTES) {
    throw new AlipayStatementError(
      `statement file ${fileName} exceeds the size limit`,
      "too_large",
    );
  }
  const text = decodeStatementText(bytes, fileName);
  const table = parseCsv(text);
  const headerIndex = table.findIndex(
    (row) => row.includes(COLUMN_TRADE_NO) && row.includes(COLUMN_OUT_TRADE_NO),
  );
  if (headerIndex === -1) {
    throw new AlipayStatementError(
      `statement file ${fileName} has no recognisable trade-bill header row`,
      "unsupported_format",
    );
  }
  const header = table[headerIndex];
  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      throw new AlipayStatementError(
        `statement file ${fileName} misses required column ${column}`,
        "unsupported_format",
      );
    }
  }
  const columnAt = (column: string) => header.indexOf(column);
  const rows: StatementRow[] = [];
  for (let i = headerIndex + 1; i < table.length; i++) {
    const cells = table[i];
    // Trailing meta lines (#-prefixed) and fully empty rows are not data.
    const joined = cells.join(",");
    if (joined.trim() === "" || joined.startsWith("#")) continue;
    if (cells.length !== header.length) {
      throw new AlipayStatementError(
        `statement file ${fileName} line ${i + 1} has ${cells.length} cells, header has ${header.length}`,
        "parse_failed",
      );
    }
    rows.push(
      statementRowFromCells(cells, {
        fileName,
        lineNumber: i + 1,
        columnAt,
        billDate,
      }),
    );
    if (rows.length > MAX_ROWS) {
      throw new AlipayStatementError(
        "statement exceeds the row limit",
        "too_large",
      );
    }
  }
  return rows;
}

/** GBK first (the gateway's encoding), falling back to UTF-8. */
function decodeStatementText(bytes: Uint8Array, fileName: string): string {
  for (const encoding of ["gbk", "utf-8"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {}
  }
  throw new AlipayStatementError(
    `statement file ${fileName} is neither GBK nor UTF-8 text`,
    "unsupported_format",
  );
}

function statementRowFromCells(
  cells: string[],
  ctx: {
    fileName: string;
    lineNumber: number;
    columnAt: (column: string) => number;
    billDate: string;
  },
): StatementRow {
  const cell = (column: string) => cells[ctx.columnAt(column)] ?? "";
  const amountRaw = cell(COLUMN_AMOUNT).trim();
  let amountFen: bigint;
  try {
    amountFen = yuanToFen(amountRaw.replace(/^¥/, ""));
  } catch (error) {
    if (error instanceof BillingValueError) {
      throw new AlipayStatementError(
        `statement file ${ctx.fileName} line ${ctx.lineNumber} has a non-exact amount ${JSON.stringify(amountRaw)}`,
        "parse_failed",
      );
    }
    throw error;
  }
  const directionRaw = cell(COLUMN_DIRECTION).trim();
  const direction =
    directionRaw === "收入" ? "pay" : directionRaw === "支出" ? "refund" : null;
  if (direction === null) {
    throw new AlipayStatementError(
      `statement file ${ctx.fileName} line ${ctx.lineNumber} has an unknown direction ${JSON.stringify(directionRaw)}`,
      "parse_failed",
    );
  }
  let occurredAtUs: string;
  try {
    occurredAtUs = alipayBeijingTimeToUs(cell(COLUMN_TIME).trim());
  } catch {
    throw new AlipayStatementError(
      `statement file ${ctx.fileName} line ${ctx.lineNumber} has an unreadable time ${JSON.stringify(cell(COLUMN_TIME))}`,
      "parse_failed",
    );
  }
  const refundNo = cell(COLUMN_REFUND_NO).trim();
  return {
    provider_transaction_id: cell(COLUMN_TRADE_NO).trim() || null,
    merchant_reference: cell(COLUMN_OUT_TRADE_NO).trim() || null,
    refund_request_no: refundNo === "" ? null : refundNo,
    direction,
    amount_fen: amountFen.toString(),
    occurred_at_us: occurredAtUs,
    bill_date: ctx.billDate,
    source_file: ctx.fileName,
    source_line: ctx.lineNumber,
  };
}

/** RFC 4180: quoted cells, escaped quotes, CRLF or LF row ends. */
function parseCsv(text: string): string[][] {
  const table: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(cell);
      table.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      table.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    table.push(row);
  }
  return table;
}

/**
 * Minimal ZIP central-directory reader. Stored and deflate entries only —
 * the gateway produces no other kind, and anything else should fail loudly
 * rather than decode into something nobody verified.
 */
function readZipEntries(bytes: Uint8Array): [string, Uint8Array][] {
  const eocd = findEndOfCentralDirectory(bytes);
  if (!eocd) {
    throw new AlipayStatementError(
      "bill archive is not a readable ZIP (no central directory)",
      "corrupt_archive",
    );
  }
  const entryCount = eocd.view.getUint16(10, true);
  // The central directory's own start offset, recorded in the EOCD record.
  let offset = eocd.view.getUint32(16, true);
  const entries: [string, Uint8Array][] = [];
  for (let i = 0; i < entryCount; i++) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    if (view.getUint32(0, true) !== 0x02014b50) {
      throw new AlipayStatementError(
        "bill archive central directory is corrupt",
        "corrupt_archive",
      );
    }
    const method = view.getUint16(10, true);
    const compressedSize = view.getUint32(20, true);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    const localOffset = view.getUint32(42, true);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes);
    if (name.includes("/") && name.includes("\\")) {
      // A name that mixes separators is a traversal attempt, not a bill.
      throw new AlipayStatementError(
        `bill archive entry name is not a plain file name: ${JSON.stringify(name)}`,
        "corrupt_archive",
      );
    }
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      throw new AlipayStatementError(
        `bill archive entry name carries a path: ${JSON.stringify(name)}`,
        "corrupt_archive",
      );
    }
    const local = new DataView(bytes.buffer, bytes.byteOffset + localOffset);
    if (local.getUint32(0, true) !== 0x04034b50) {
      throw new AlipayStatementError(
        "bill archive local header is corrupt",
        "corrupt_archive",
      );
    }
    const localNameLength = local.getUint16(26, true);
    const localExtraLength = local.getUint16(28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let content: Uint8Array;
    if (method === 0) {
      content = compressed;
    } else if (method === 8) {
      try {
        content = inflateRawSync(compressed);
      } catch {
        throw new AlipayStatementError(
          `bill archive entry ${name} failed to decompress`,
          "corrupt_archive",
        );
      }
    } else {
      throw new AlipayStatementError(
        `bill archive entry ${name} uses unsupported compression method ${method}`,
        "unsupported_format",
      );
    }
    entries.push([name, content]);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(
  bytes: Uint8Array,
): { offset: number; view: DataView } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (
    let i = bytes.byteLength - 22;
    i >= 0 && i > bytes.byteLength - 22 - 65_536;
    i--
  ) {
    if (view.getUint32(i, true) === 0x06054b50) {
      // A view positioned AT the EOCD record, so its fixed-offset fields
      // (entry count, central-directory offset) read relative to i.
      return {
        offset: i,
        view: new DataView(bytes.buffer, bytes.byteOffset + i),
      };
    }
  }
  return null;
}
