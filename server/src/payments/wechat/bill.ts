/**
 * WeChat Pay trade-bill download integrity (#69).
 *
 * Official rules (verified 2026-11-19): the signed tradebill metadata names
 * hash_type (SHA1) and hash_value of the ORIGINAL downloaded file; the trade
 * bill arrives GZIP-compressed. Therefore: verify SHA1 over the raw bytes
 * FIRST, only then decompress under a strict size cap, then publish atomically
 * (temp file + rename) so no partial or corrupted bill is ever visible.
 * Download failures are recoverable: rerunning the same (merchant, date, type)
 * simply re-requests the (5-minute) download URL.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const BILL_MAX_RAW_BYTES = 256 * 1024 * 1024;
export const BILL_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

export class BillIntegrityError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "BillIntegrityError";
  }
}

/** Verify the raw downloaded bytes against the signed metadata digest. */
export function verifyBillDigest(
  bytes: Uint8Array,
  hashType: string,
  hashValue: string,
): { ok: true } | { ok: false; reason: string } {
  if (hashType !== "SHA1") {
    return {
      ok: false,
      reason: `unknown digest algorithm ${JSON.stringify(hashType)}`,
    };
  }
  if (!/^[0-9a-f]{40}$/i.test(hashValue)) {
    return { ok: false, reason: "hash_value is not a SHA-1 digest" };
  }
  const actual = createHash("sha1").update(bytes).digest("hex");
  if (actual !== hashValue.toLowerCase()) {
    return {
      ok: false,
      reason: "SHA1 of downloaded file does not match signed metadata",
    };
  }
  return { ok: true };
}

/**
 * Post-digest handling: decompress GZIP bills under a hard cap. The digest has
 * already authenticated the raw bytes, so decompression cannot smuggle content.
 */
export function decodeBillBytes(bytes: Uint8Array): {
  content: Uint8Array;
  compressed: boolean;
} {
  const gzipMagic = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!gzipMagic) return { content: bytes, compressed: false };
  let content: Buffer;
  try {
    content = gunzipSync(Buffer.from(bytes), {
      maxOutputLength: BILL_MAX_DECOMPRESSED_BYTES,
    });
  } catch {
    throw new BillIntegrityError(
      "decompression_failed",
      "GZIP bill failed integrity-preserving decompression",
    );
  }
  return { content: new Uint8Array(content), compressed: true };
}

/**
 * Atomic publication: write to a temp file in the destination directory and
 * rename. Returns the published absolute path. Nothing partial survives a
 * crash, and the previous artifact (if any) is replaced whole.
 */
export function publishBillFile(
  destinationDir: string,
  fileNameStem: string,
  content: Uint8Array,
): { publishedPath: string } {
  const tempDir = mkdtempSync(join(destinationDir, ".billtmp-"));
  const tempPath = join(tempDir, "bill");
  const publishedPath = join(destinationDir, `${fileNameStem}.csv`);
  try {
    writeFileSync(tempPath, content);
    renameSync(tempPath, publishedPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return { publishedPath };
}

/** Small helper for tests/ops: where do temporary downloads go? */
export function defaultBillWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "openbot-wechat-bill-"));
}
