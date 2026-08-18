/**
 * WRITE — checkable write-path invariants.
 *
 * The policy prompt tells the model how to write memories; nothing tells it
 * when it got it wrong. These checks turn the silent failure modes — a misfiled
 * `user` memory, a memory with no index pointer, a description too vague to
 * retrieve on, a near-duplicate — into something `/memory doctor` can print.
 *
 * Advisory only: nothing here modifies a file or blocks a turn.
 */

import { readFileSync } from "node:fs";
import { NAME_PATTERN } from "./frontmatter.ts";
import { INDEX_FILENAME, PROJECT_PREFIX } from "./config.ts";
import type { MemoryFile, MemoryScope, MemoryType } from "./scan.ts";

export type FindingKind =
  | "scope-violation"
  | "unindexed"
  | "pinned-and-indexed"
  | "dangling-pointer"
  | "bad-name"
  | "no-description"
  | "duplicate";

export interface Finding {
  kind: FindingKind;
  /** Scope-relative filename, or the raw pointer for `dangling-pointer`. */
  subject: string;
  message: string;
}

/**
 * Pointer extraction. Markdown link targets plus any bare `*.md` token, so a
 * hand-written index line still counts.
 */
export function extractIndexPointers(indexText: string): Set<string> {
  const out = new Set<string>();
  for (const m of indexText.matchAll(/\]\(([^)\s]+)\)/g)) {
    out.add(normalisePointer(m[1]));
  }
  for (const m of indexText.matchAll(/(?:^|[\s`(])([\w./-]+\.md)\b/g)) {
    out.add(normalisePointer(m[1]));
  }
  return out;
}

function normalisePointer(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\//, "").split("#")[0].trim();
}

/**
 * Reduce a description to its significant-word set so two differently phrased
 * restatements of the same fact collide.
 */
export function descriptionKey(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return [...new Set(words)].sort().join(" ");
}

export interface DoctorInput {
  files: MemoryFile[];
  /** One index per live scope. Each scope indexes only its own memories. */
  indexes: Array<{ indexPath: string; scope: MemoryScope }>;
}

/** Display name for a scope-relative pointer. */
function displayName(scope: MemoryScope, relPath: string): string {
  return scope === "project" ? `${PROJECT_PREFIX}${relPath}` : relPath;
}

/**
 * Which scope a memory of each type belongs in, when the routing rule is
 * unconditional. `feedback` and `reference` are left out: either scope can be
 * right for them, and only the author knows which.
 */
const REQUIRED_SCOPE: Partial<Record<MemoryType, MemoryScope>> = {
  user: "user",
  project: "project",
};

const SCOPE_REASON: Record<MemoryScope, string> = {
  user: "facts about the user or their system stay true across projects, so they belong in user memory",
  project: "project memory is scoped to this project, which is where project-specific facts belong",
};

/** Run every write-path invariant. Returns findings in a stable order. */
export function diagnose(input: DoctorInput): Finding[] {
  const findings: Finding[] = [];
  const { files } = input;

  // Pointers are per scope: each MEMORY.md indexes its own directory, with
  // paths relative to that directory.
  const pointersByScope = new Map<MemoryScope, Set<string>>();
  for (const { indexPath, scope } of input.indexes) {
    let indexText = "";
    try {
      indexText = readFileSync(indexPath, "utf8");
    } catch {
      indexText = "";
    }
    pointersByScope.set(scope, extractIndexPointers(indexText));
  }
  const knownByScope = new Map<MemoryScope, Set<string>>();
  for (const f of files) {
    const bucket = knownByScope.get(f.scope);
    if (bucket) bucket.add(f.relPath);
    else knownByScope.set(f.scope, new Set([f.relPath]));
  }

  for (const f of files) {
    const required = f.type ? REQUIRED_SCOPE[f.type] : undefined;
    if (required !== undefined && f.scope !== required) {
      findings.push({
        kind: "scope-violation",
        subject: f.filename,
        message: `\`${f.type}\` memories belong in ${required} memory — ${SCOPE_REASON[required]}`,
      });
    }

    if (!f.name) {
      findings.push({
        kind: "bad-name",
        subject: f.filename,
        message: "no `name:` in frontmatter",
      });
    } else if (!NAME_PATTERN.test(f.name)) {
      findings.push({
        kind: "bad-name",
        subject: f.filename,
        message: `name "${f.name}" does not match ^[a-z0-9_-]+$`,
      });
    }

    if (!f.description) {
      findings.push({
        kind: "no-description",
        subject: f.filename,
        message: "no description and no derivable body line — this memory can never be selected",
      });
    }

    // A pinned memory should have no pointer; an unpinned one should have
    // exactly one. Both directions of the transition are caught here.
    const indexed = Boolean(pointersByScope.get(f.scope)?.has(f.relPath));
    const pinned = f.pinnedState === "true";
    if (pinned && indexed) {
      findings.push({
        kind: "pinned-and-indexed",
        subject: f.filename,
        message: `pinned, so its body is already injected in full — remove its pointer from the ${f.scope} ${INDEX_FILENAME}; the index line is budget that could keep an unpinned memory above the truncation cut-off`,
      });
    } else if (!pinned && !indexed) {
      findings.push({
        kind: "unindexed",
        subject: f.filename,
        message: `not pinned and no pointer to \`${f.relPath}\` in the ${f.scope} ${INDEX_FILENAME} — this memory is invisible to the model unless recall happens to select it. If it was just unpinned, add its index pointer`,
      });
    }
  }

  // Check the other direction, scope by scope.
  for (const { scope } of input.indexes) {
    const known = knownByScope.get(scope) ?? new Set<string>();
    for (const pointer of [...(pointersByScope.get(scope) ?? [])].sort()) {
      if (pointer === INDEX_FILENAME) continue;
      if (known.has(pointer)) continue;
      findings.push({
        kind: "dangling-pointer",
        subject: displayName(scope, pointer),
        message: `the ${scope} ${INDEX_FILENAME} points at a memory that does not exist in ${scope} memory`,
      });
    }
  }

  const byKey = new Map<string, string[]>();
  for (const f of files) {
    if (!f.description) continue;
    const key = descriptionKey(f.description);
    if (key === "") continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(f.filename);
    else byKey.set(key, [f.filename]);
  }
  for (const names of byKey.values()) {
    if (names.length < 2) continue;
    const sorted = [...names].sort();
    for (const name of sorted) {
      findings.push({
        kind: "duplicate",
        subject: name,
        message: `probable duplicate of ${sorted.filter((n) => n !== name).join(", ")}`,
      });
    }
  }

  return findings;
}

/** Render findings for `/memory doctor`. */
export function renderFindings(findings: Finding[]): string[] {
  if (findings.length === 0) return ["memory doctor: no findings."];
  const lines = [`memory doctor: ${findings.length} finding${findings.length === 1 ? "" : "s"}`];
  for (const f of findings) {
    lines.push(`  [${f.kind}] ${f.subject}`);
    lines.push(`      ${f.message}`);
  }
  return lines;
}
