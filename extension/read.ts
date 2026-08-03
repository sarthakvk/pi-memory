/**
 * Budgeted file reads.
 *
 * Memory files are read under two distinct budgets: 30 lines / 65536 bytes
 * when scanning for a description, 200 lines / 4096 bytes when surfacing a
 * body. Truncation happens on the byte limit as well as the line limit.
 * See SPEC.md §3.
 */

import { readFileSync, statSync } from "node:fs";

export interface BudgetedRead {
  /** Content after line and byte truncation. */
  content: string;
  /** Lines actually returned. */
  lineCount: number;
  /** Lines in the whole file. */
  totalLines: number;
  /** UTF-8 bytes in the whole file. */
  totalBytes: number;
  truncatedByLines: boolean;
  truncatedByBytes: boolean;
  mtimeMs: number;
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function sliceUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // A UTF-8 continuation byte is 10xxxxxx; back off until we are on a boundary.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Read a file with line and byte budgets. Throws only if the file cannot be
 * read at all; callers treat that as "skip this file" (REQ-SCAN-12).
 */
export function readBudgeted(path: string, maxLines: number, maxBytes: number): BudgetedRead {
  const stat = statSync(path);
  const raw = readFileSync(path, "utf8");
  const allLines = raw.split("\n");
  const totalLines = allLines.length;
  const totalBytes = utf8Length(raw);

  const truncatedByLines = totalLines > maxLines;
  let content = truncatedByLines ? allLines.slice(0, maxLines).join("\n") : raw;

  const sliced = sliceUtf8(content, maxBytes);
  content = sliced.text;

  return {
    content,
    lineCount: content === "" ? 0 : content.split("\n").length,
    totalLines,
    totalBytes,
    truncatedByLines,
    truncatedByBytes: sliced.truncated,
    mtimeMs: stat.mtimeMs,
  };
}
