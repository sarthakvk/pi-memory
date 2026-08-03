/**
 * WRITE — checkable write-path invariants. See SPEC.md §7.1.
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
import { INDEX_FILENAME } from "./config.ts";
import type { MemoryFile } from "./scan.ts";

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
 * REQ-WRITE-14 — pointer extraction. Markdown link targets plus any bare `*.md`
 * token, so a hand-written index line still counts.
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
 * REQ-WRITE-17 — reduce a description to its significant-word set so two
 * differently phrased restatements of the same fact collide.
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
  indexPath: string;
}

/** Run every §7.1 invariant. Returns findings in a stable order. */
export function diagnose(input: DoctorInput): Finding[] {
  const findings: Finding[] = [];
  const { files } = input;

  let indexText = "";
  try {
    indexText = readFileSync(input.indexPath, "utf8");
  } catch {
    indexText = "";
  }
  const pointers = extractIndexPointers(indexText);
  const known = new Set(files.map((f) => f.filename));

  for (const f of files) {
    // REQ-WRITE-13
    if (f.type === "user" && f.scope === "project") {
      findings.push({
        kind: "scope-violation",
        subject: f.filename,
        message: "`user` memories are always private; move this out of the team directory",
      });
    }

    // REQ-WRITE-15
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

    // REQ-WRITE-16
    if (!f.description) {
      findings.push({
        kind: "no-description",
        subject: f.filename,
        message: "no description and no derivable body line — this memory can never be selected",
      });
    }

    // REQ-WRITE-14 / REQ-WRITE-19 / REQ-WRITE-21 — a pinned memory should have
    // no pointer; an unpinned one should have exactly one. Both directions of
    // the REQ-WRITE-20 transition are caught here.
    const indexed = pointers.has(f.filename);
    const pinned = f.pinnedState === "true";
    if (pinned && indexed) {
      findings.push({
        kind: "pinned-and-indexed",
        subject: f.filename,
        message: `pinned, so its body is already injected in full — remove its ${INDEX_FILENAME} pointer; the index line is budget that could keep an unpinned memory above the truncation cut-off`,
      });
    } else if (!pinned && !indexed) {
      findings.push({
        kind: "unindexed",
        subject: f.filename,
        message: `not pinned and no pointer in ${INDEX_FILENAME} — this memory is invisible to the model unless recall happens to select it. If it was just unpinned, add its index pointer`,
      });
    }
  }

  // REQ-WRITE-14, the other direction.
  for (const pointer of [...pointers].sort()) {
    if (pointer === INDEX_FILENAME) continue;
    if (known.has(pointer)) continue;
    findings.push({
      kind: "dangling-pointer",
      subject: pointer,
      message: `${INDEX_FILENAME} points at a memory that does not exist`,
    });
  }

  // REQ-WRITE-17
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

/** REQ-CMD-3 — render findings for `/memory doctor`. */
export function renderFindings(findings: Finding[]): string[] {
  if (findings.length === 0) return ["memory doctor: no findings."];
  const lines = [`memory doctor: ${findings.length} finding${findings.length === 1 ? "" : "s"}`];
  for (const f of findings) {
    lines.push(`  [${f.kind}] ${f.subject}`);
    lines.push(`      ${f.message}`);
  }
  return lines;
}
