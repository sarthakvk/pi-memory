/**
 * INJECT + LIMIT — staleness, pinned block, index truncation, surfaced bodies.
 */

import { readFileSync } from "node:fs";
import { readBudgeted, utf8Length } from "./read.ts";
import type { MemoryFile } from "./scan.ts";
import { INDEX_FILENAME } from "./config.ts";

const MS_PER_DAY = 86400000;

/** Whole days since `mtimeMs`, never negative. */
export function ageInDays(mtimeMs: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - mtimeMs) / MS_PER_DAY));
}

/** Staleness notice. Empty string when the memory is at most one day old. */
export function stalenessSentence(mtimeMs: number, now = Date.now()): string {
  const days = ageInDays(mtimeMs, now);
  if (days <= 1) return "";
  return (
    `This memory is ${days} days old. ` +
    "Memories are point-in-time observations, not live state — " +
    "claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact."
  );
}

/** The staleness sentence wrapped for the pinned block. */
export function stalenessReminder(mtimeMs: number, now = Date.now()): string {
  const s = stalenessSentence(mtimeMs, now);
  if (!s) return "";
  return `<system-reminder>${s}</system-reminder>\n`;
}

/** XML attribute escaping. */
function escapeXmlAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Strip control characters, then escape as an attribute. */
export function sanitizeAttr(s: string): string {
  return escapeXmlAttr(s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ""));
}

/** Neutralise close tags for `tag` inside content, so a body cannot escape it. */
export function scrubCloseTag(tag: string, text: string): string {
  return text.replace(new RegExp(`</(?=${tag}(?:[>\\s/]|$))`, "gi"), "<\\/");
}

export const PINNED_HEADER = "# Pinned memories (apply to every conversation)";

export interface PinnedEntry {
  path: string;
  content: string;
}

/**
 * Returns "" when there is nothing pinned so the caller can omit the section
 * entirely.
 */
export function buildPinnedBlock(entries: PinnedEntry[]): string {
  if (entries.length === 0) return "";
  return [
    PINNED_HEADER,
    ...entries.map(
      (e) =>
        `<pinned-memory path="${sanitizeAttr(e.path)}">\n` +
        `${scrubCloseTag("pinned-memory", e.content.trim())}\n` +
        `</pinned-memory>`,
    ),
  ].join("\n");
}

/**
 * Read pinned memory bodies and build the block. Files that cannot be read are
 * skipped. Staleness is prepended to old entries.
 */
export function pinnedBlockFor(
  files: MemoryFile[],
  opts: { fileMaxLines: number; fileMaxBytes: number; now?: number },
): { block: string; entries: PinnedEntry[]; bytes: number } {
  const now = opts.now ?? Date.now();
  const entries: PinnedEntry[] = [];
  let bytes = 0;
  for (const f of files) {
    let read;
    try {
      read = readBudgeted(f.filePath, opts.fileMaxLines, opts.fileMaxBytes);
    } catch {
      continue;
    }
    const content = stalenessReminder(f.mtimeMs, now) + read.content;
    bytes += utf8Length(content);
    entries.push({ path: f.filePath, content });
  }
  return { block: buildPinnedBlock(entries), entries, bytes };
}

// ---------------------------------------------------------------------------
// Index (MEMORY.md)
// ---------------------------------------------------------------------------

/** Byte counts as they appear inside truncation warnings. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}KB`;
}

export interface TruncationResult {
  content: string;
  lineCount: number;
  byteCount: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
}

/**
 * Truncate to the line and byte budgets and append a warning describing what
 * was cut. `kind` selects the trailing advice sentence: "index" for MEMORY.md,
 * "file" for a memory file.
 */
export function truncateWithWarning(
  text: string,
  kind: "index" | "file",
  maxLines: number,
  maxBytes: number,
): TruncationResult {
  const trimmed = text.trim();
  const lines = trimmed === "" ? [] : trimmed.split("\n");
  const lineCount = lines.length;
  const byteCount = utf8Length(trimmed);

  const overLines = lineCount > maxLines;
  const overBytes = byteCount > maxBytes;
  if (!overLines && !overBytes) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated: false, wasByteTruncated: false };
  }

  let out = overLines ? lines.slice(0, maxLines).join("\n") : trimmed;
  if (utf8Length(out) > maxBytes) {
    const buf = Buffer.from(out, "utf8");
    const cut = buf.subarray(0, maxBytes).lastIndexOf(0x0a);
    out = buf.subarray(0, cut > 0 ? cut : maxBytes).toString("utf8");
  }

  const detail =
    overBytes && !overLines
      ? `${formatBytes(byteCount)} (limit: ${formatBytes(maxBytes)}) — ${
          kind === "index" ? "index entries are too long" : "its lines are too long"
        }`
      : overLines && !overBytes
        ? `${lineCount} lines (limit: ${maxLines})`
        : `${lineCount} lines and ${formatBytes(byteCount)}`;

  const advice =
    kind === "index"
      ? `${INDEX_FILENAME} is ${detail}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`
      : `this memory file is ${detail}. Only part of it was loaded. Keep each memory file focused on one topic.`;

  return {
    content: `${out}\n> WARNING: ${advice}`,
    lineCount,
    byteCount,
    wasLineTruncated: overLines,
    wasByteTruncated: overBytes,
  };
}

/** Stand-in content when the index is missing or blank. */
export const EMPTY_INDEX_TEXT = `Your ${INDEX_FILENAME} is currently empty. When you save new memories, they will appear here.`;

/**
 * The `## MEMORY.md` section. A missing or blank index still produces the
 * section, carrying the "currently empty" sentence.
 */
export function indexSection(
  indexPath: string,
  opts: { indexMaxLines: number; indexMaxBytes: number },
): { section: string; truncation: TruncationResult | undefined } {
  let raw = "";
  try {
    raw = readFileSync(indexPath, "utf8");
  } catch {
    raw = "";
  }
  if (raw.trim() === "") {
    return { section: [`## ${INDEX_FILENAME}`, "", EMPTY_INDEX_TEXT].join("\n"), truncation: undefined };
  }
  const truncation = truncateWithWarning(raw, "index", opts.indexMaxLines, opts.indexMaxBytes);
  return {
    section: [`## ${INDEX_FILENAME}`, "", truncation.content].join("\n"),
    truncation,
  };
}

// ---------------------------------------------------------------------------
// Surfaced (selected) memories
// ---------------------------------------------------------------------------

/** Header line for a surfaced memory, staleness sentence above it when stale. */
export function memoryHeader(path: string, mtimeMs: number, now = Date.now()): string {
  const s = stalenessSentence(mtimeMs, now);
  return s ? `${s}\nMemory: ${path}:` : `Memory: ${path}:`;
}

export interface SurfacedMemory {
  path: string;
  header: string;
  content: string;
  mtimeMs: number;
  /** UTF-8 bytes of `content`, counted against the session budget. */
  bytes: number;
}

/**
 * Read each selected memory under the surfacing budget and append the
 * truncation notice when a limit bites.
 */
export function readForSurfacing(
  files: Array<{ filePath: string; mtimeMs: number }>,
  opts: { fileMaxLines: number; fileMaxBytes: number; readToolName?: string; now?: number },
): SurfacedMemory[] {
  const now = opts.now ?? Date.now();
  const readTool = opts.readToolName ?? "read";
  const out: SurfacedMemory[] = [];
  for (const f of files) {
    let read;
    try {
      read = readBudgeted(f.filePath, opts.fileMaxLines, opts.fileMaxBytes);
    } catch {
      continue;
    }
    const truncated = read.totalLines > opts.fileMaxLines || read.truncatedByBytes;
    const content = truncated
      ? read.content +
        `\n> This memory file was truncated (${
          read.truncatedByBytes ? `${opts.fileMaxBytes} byte limit` : `first ${opts.fileMaxLines} lines`
        }). Use the ${readTool} tool to view the complete file at: ${f.filePath}`
      : read.content;
    out.push({
      path: f.filePath,
      header: memoryHeader(f.filePath, f.mtimeMs, now),
      content,
      mtimeMs: f.mtimeMs,
      bytes: utf8Length(content),
    });
  }
  return out;
}

/** Render surfaced memories as one block. */
export function buildSurfacedBlock(memories: SurfacedMemory[]): string {
  if (memories.length === 0) return "";
  return memories.map((m) => `${m.header}\n${m.content}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface InjectionParts {
  policy: string;
  index: string;
  pinned: string;
  surfaced: string;
}

/**
 * Append the non-empty sections to the incoming system prompt, separated by
 * blank lines. Never replaces or reorders what came in.
 */
export function assemble(systemPrompt: string, parts: Partial<InjectionParts>): string {
  const blocks = [parts.policy, parts.index, parts.pinned, parts.surfaced].filter(
    (b): b is string => typeof b === "string" && b.trim() !== "",
  );
  if (blocks.length === 0) return systemPrompt;
  const base = systemPrompt.replace(/\s+$/, "");
  return base === "" ? blocks.join("\n\n") : `${base}\n\n${blocks.join("\n\n")}`;
}
