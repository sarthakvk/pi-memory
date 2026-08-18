/**
 * SCAN — directory walk, frontmatter extraction, ordering, caps.
 */

import { readdirSync } from "node:fs";
import { basename, join, posix, sep } from "node:path";
import { parseMemoryFile } from "./frontmatter.ts";
import { readBudgeted } from "./read.ts";
import { INDEX_FILENAME, PROJECT_PREFIX, type MemoryConfig } from "./config.ts";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "user" | "project";
/** How `metadata.pinned` parsed: see `pinnedStateOf`. */
export type PinnedState = "absent" | "malformed" | "true" | "false";

export const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

/** A body-derived description is capped at 120 chars. */
export const DESCRIPTION_MAX_CHARS = 120;

export interface MemoryFile {
  /** Display name: `relPath`, `project/` prefixed for the project scope. */
  filename: string;
  /** Name relative to its own scope root — what its own index points at. */
  relPath: string;
  /** Absolute path on disk. */
  filePath: string;
  scope: MemoryScope;
  /** Filesystem mtime; drives scan ordering. */
  mtimeMs: number;
  /** `metadata.modified` when parseable, else mtimeMs; drives pinned ordering. */
  modifiedMs: number;
  name: string | null;
  description: string | null;
  type: MemoryType | undefined;
  pinnedState: PinnedState;
  /** UTF-8 size of the whole file. */
  bytes: number;
  /** True when the file has no parseable frontmatter block. */
  frontmatterMissing: boolean;
}

/**
 * Body-derived description fallback: the first line that is non-empty after
 * stripping a leading markdown heading marker and trimming, truncated to 120
 * characters.
 */
export function deriveDescription(body: string): string | null {
  for (const line of body.split("\n")) {
    const stripped = line.replace(/^#{1,6}\s+/, "").trim();
    if (stripped) return stripped.slice(0, DESCRIPTION_MAX_CHARS);
  }
  return null;
}

/** Classify `metadata.pinned`: booleans and their string forms, else malformed. */
export function pinnedStateOf(v: unknown): PinnedState {
  if (v === null || v === undefined) return "absent";
  if (v === true) return "true";
  if (v === false) return "false";
  if (v === "true") return "true";
  if (v === "false") return "false";
  return "malformed";
}

/** Only the four known type names survive; anything else is untyped. */
export function normalizeType(v: unknown): MemoryType | undefined {
  return typeof v === "string" && (MEMORY_TYPES as string[]).includes(v)
    ? (v as MemoryType)
    : undefined;
}

/**
 * Recursive `*.md` walk. Directory symlinks are not followed, so a symlink
 * loop cannot hang the scan.
 */
function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}${sep}${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRel);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith(".md")) continue;
      out.push(childRel);
    }
  }
  return out;
}

function toPosix(rel: string): string {
  return rel.split(sep).join(posix.sep);
}

export interface ScanOptions {
  scanMaxLines: number;
  scanMaxBytes: number;
}

/**
 * Scan a single scope root. Returns unsorted, uncapped results — the caller
 * merges scopes before sorting and slicing.
 */
export function scanDir(root: string, scope: MemoryScope, opts: ScanOptions): MemoryFile[] {
  const out: MemoryFile[] = [];
  for (const rel of walkMarkdown(root)) {
    // MEMORY.md is the index, never a memory, at any depth.
    if (basename(rel) === INDEX_FILENAME) continue;

    const filePath = join(root, rel);
    let read;
    try {
      read = readBudgeted(filePath, opts.scanMaxLines, opts.scanMaxBytes);
    } catch {
      continue;
    }

    const { frontmatter, body } = parseMemoryFile(read.content);
    const modifiedRaw = frontmatter.metadata.modified;
    const parsedModified =
      typeof modifiedRaw === "string" ? Date.parse(modifiedRaw) : Number.NaN;

    const relPosix = toPosix(rel);
    out.push({
      filename: scope === "project" ? `${PROJECT_PREFIX}${relPosix}` : relPosix,
      relPath: relPosix,
      filePath,
      scope,
      mtimeMs: read.mtimeMs,
      modifiedMs: Number.isNaN(parsedModified) ? read.mtimeMs : parsedModified,
      name: frontmatter.name,
      description: frontmatter.description ?? deriveDescription(body),
      type: normalizeType(frontmatter.metadata.type),
      pinnedState: pinnedStateOf(frontmatter.metadata.pinned),
      bytes: read.totalBytes,
      frontmatterMissing: !frontmatter.present,
    });
  }
  return out;
}

export interface ScanResult {
  files: MemoryFile[];
  /** Files dropped by the maxFiles cap. */
  dropped: number;
}

/**
 * Scan every existing scope root, sort newest-first by mtime, cap at maxFiles.
 * A root that does not exist or cannot be walked contributes nothing
 * The scan as a whole never throws.
 */
export function scanAll(
  roots: Array<{ root: string; scope: MemoryScope }>,
  config: Pick<MemoryConfig, "maxFiles" | "scanMaxLines" | "scanMaxBytes">,
): ScanResult {
  const all: MemoryFile[] = [];
  for (const { root, scope } of roots) {
    try {
      all.push(...scanDir(root, scope, config));
    } catch {
      // A missing or invalid root contributes nothing.
    }
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const files = all.slice(0, config.maxFiles);
  return { files, dropped: all.length - files.length };
}

/**
 * Pinned candidates: pinnedState === "true", newest-first by modifiedMs,
 * capped at maxPinned.
 */
export function pinnedCandidates(
  files: MemoryFile[],
  maxPinned: number,
): { candidates: MemoryFile[]; pinnedCount: number; malformedCount: number } {
  const pinned = files.filter((f) => f.pinnedState === "true");
  const candidates = [...pinned].sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, maxPinned);
  return {
    candidates,
    pinnedCount: pinned.length,
    malformedCount: files.filter((f) => f.pinnedState === "malformed").length,
  };
}
