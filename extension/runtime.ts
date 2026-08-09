/**
 * Session state, injection assembly, and command rendering.
 *
 * Deliberately free of pi and pi-ai imports so the whole pipeline can be
 * driven headlessly. `index.ts` supplies the pi context and the
 * real provider call; everything below only sees plain data and a `CompleteFn`.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  disabledByEnv,
  loadConfig,
  resolveDirs,
  type MemoryConfig,
  type ResolvedDirs,
} from "./config.ts";
import {
  assemble,
  buildSurfacedBlock,
  indexSection,
  pinnedBlockFor,
  readForSurfacing,
} from "./inject.ts";
import { diagnose, renderFindings } from "./doctor.ts";
import { buildPolicyPrompt } from "./prompts.ts";
import {
  pinnedCandidates,
  scanAll,
  type MemoryFile,
  type MemoryScope,
} from "./scan.ts";
import {
  SelectorConversation,
  SessionBudget,
  toListingEntry,
  type CompleteFn,
  type SelectorRunResult,
} from "./selector.ts";

export interface TurnRecord {
  pinned: string[];
  pinnedBytes: number;
  selected: string[];
  selectedBytes: number;
  selectorReason: SelectorRunResult["reason"];
  selectorLatencyMs: number | undefined;
  indexTruncated: boolean;
  scanned: number;
  dropped: number;
}

/** Session-scoped counters, reset with the session. */
export interface Counters {
  turns: number;
  scans: number;
  filesScanned: number;
  filesDropped: number;
  pinnedInjected: number;
  surfacedMemories: number;
  surfacedBytes: number;
  /** Turns where no scope root existed, so nothing was injected. */
  turnsWithNoScope: number;
}

export function newCounters(): Counters {
  return {
    turns: 0,
    scans: 0,
    filesScanned: 0,
    filesDropped: 0,
    pinnedInjected: 0,
    surfacedMemories: 0,
    surfacedBytes: 0,
    turnsWithNoScope: 0,
  };
}

export interface SessionState {
  config: MemoryConfig;
  dirs: ResolvedDirs;
  /** Project scope root, present only when it exists on disk. */
  teamDir: string | undefined;
  files: MemoryFile[];
  dropped: number;
  budget: SessionBudget;
  selector: SelectorConversation | undefined;
  /** Set once the selector model proves unusable; recall stays off. */
  selectorDisabledReason: string | undefined;
  lastTurn: TurnRecord | undefined;
  counters: Counters;
}

/** Locate pi's agent directory the same way pi does, without importing it. */
export function agentDir(): string {
  const explicit = process.env.PI_AGENT_DIR;
  if (explicit && explicit.trim() !== "") return explicit;
  return join(homedir(), ".pi", "agent");
}

/** Create the memory dir, swallowing failures. */
function ensureDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    /* best effort — a missing dir simply means nothing to inject */
  }
}

/** Scope roots that actually exist on disk right now. */
export function liveRoots(
  s: SessionState,
): Array<{ root: string; scope: MemoryScope }> {
  const roots: Array<{ root: string; scope: MemoryScope }> = [];
  if (existsSync(s.dirs.privateDir))
    roots.push({ root: s.dirs.privateDir, scope: "private" });
  if (s.teamDir && existsSync(s.teamDir))
    roots.push({ root: s.teamDir, scope: "project" });
  return roots;
}

export function rescan(s: SessionState): void {
  const result = scanAll(liveRoots(s), s.config);
  s.files = result.files;
  s.dropped = result.dropped;
  s.counters.scans++;
  s.counters.filesScanned = result.files.length;
  s.counters.filesDropped = result.dropped;
}

/**
 * Build session state. Returns undefined when the extension is switched off.
 * `configDir` defaults to pi's agent directory.
 */
export function initSession(
  cwd: string,
  configDir = agentDir(),
): SessionState | undefined {
  const config = loadConfig(configDir);
  if (!config.enabled || disabledByEnv()) return undefined;

  const dirs = resolveDirs(config, cwd);
  ensureDir(dirs.privateDir);
  const teamDir =
    dirs.projectDir && existsSync(dirs.projectDir)
      ? dirs.projectDir
      : undefined;

  const s: SessionState = {
    config,
    dirs,
    teamDir,
    files: [],
    dropped: 0,
    budget: new SessionBudget(config.maxSessionBytes),
    selector: undefined,
    selectorDisabledReason: undefined,
    lastTurn: undefined,
    counters: newCounters(),
  };
  rescan(s);
  return s;
}

export const NO_SELECTION: SelectorRunResult = {
  selected: [],
  reason: "disabled",
  listing: "",
  answerText: undefined,
  latencyMs: undefined,
};

/**
 * Attach a selector to the session. `index.ts` calls this once it has resolved
 * a model and credentials; tests pass a mock `CompleteFn`.
 */
export function attachSelector(
  s: SessionState,
  complete: CompleteFn,
): SelectorConversation {
  s.selector = new SelectorConversation(complete, {
    maxSelected: s.config.selector.maxSelected,
    timeoutMs: s.config.selector.timeoutMs,
  });
  return s.selector;
}

/**
 * Run one selection. Honours the config switch, the disabled-model latch, and
 * the session byte budget.
 */
export async function runSelector(
  s: SessionState,
  query: string,
  signal?: AbortSignal,
): Promise<SelectorRunResult> {
  if (!s.config.selector.enabled) return NO_SELECTION;
  if (s.selectorDisabledReason) return NO_SELECTION;
  if (s.budget.exhausted)
    return { ...NO_SELECTION, reason: "budget-exhausted" };
  if (!s.selector) return NO_SELECTION;

  s.selector.seed(s.files.map(toListingEntry));
  return s.selector.run(query, signal);
}

/**
 * Assemble the turn's injection and record what it contained.
 * Side effects: charges the session budget and marks surfaced paths.
 */
export function buildInjection(
  s: SessionState,
  systemPrompt: string,
  selection: SelectorRunResult,
): { prompt: string; record: TurnRecord } {
  const emptyRecord: TurnRecord = {
    pinned: [],
    pinnedBytes: 0,
    selected: [],
    selectedBytes: 0,
    selectorReason: selection.reason,
    selectorLatencyMs: selection.latencyMs,
    indexTruncated: false,
    scanned: s.files.length,
    dropped: s.dropped,
  };

  // No scope root on disk means nothing to say about memory.
  if (liveRoots(s).length === 0) {
    s.counters.turnsWithNoScope++;
    return { prompt: systemPrompt, record: emptyRecord };
  }

  const policy = buildPolicyPrompt({
    privateDir: s.dirs.privateDir,
    teamDir: s.teamDir,
    indexMaxLines: s.config.indexMaxLines,
    maxPinned: s.config.maxPinned,
  });

  const index = indexSection(s.dirs.indexPath, s.config);

  const { candidates } = pinnedCandidates(s.files, s.config.maxPinned);
  const pinned = pinnedBlockFor(candidates, {
    fileMaxLines: s.config.fileMaxLines,
    fileMaxBytes: s.config.fileMaxBytes,
  });

  const surfaced = readForSurfacing(
    selection.selected.map((e) => ({
      filePath: e.filePath,
      mtimeMs: e.mtimeMs,
    })),
    {
      fileMaxLines: s.config.fileMaxLines,
      fileMaxBytes: s.config.fileMaxBytes,
    },
  );

  const selectedBytes = surfaced.reduce((n, m) => n + m.bytes, 0);
  if (surfaced.length > 0) {
    s.budget.add(selectedBytes);
    s.selector?.markSurfaced(surfaced.map((m) => m.path));
  }

  s.counters.turns++;
  s.counters.pinnedInjected += candidates.length;
  s.counters.surfacedMemories += surfaced.length;
  s.counters.surfacedBytes += selectedBytes;

  const record: TurnRecord = {
    pinned: candidates.map((c) => c.filename),
    pinnedBytes: pinned.bytes,
    selected: selection.selected.map((e) => e.filename),
    selectedBytes,
    selectorReason: selection.reason,
    selectorLatencyMs: selection.latencyMs,
    indexTruncated: Boolean(
      index.truncation?.wasLineTruncated || index.truncation?.wasByteTruncated,
    ),
    scanned: s.files.length,
    dropped: s.dropped,
  };

  return {
    prompt: assemble(systemPrompt, {
      policy,
      index: index.section,
      pinned: pinned.block,
      surfaced: buildSurfacedBlock(surfaced),
    }),
    record,
  };
}

/** One full turn: rescan, select, inject, record. Never throws. */
export async function runTurn(
  s: SessionState,
  systemPrompt: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    rescan(s);
    const selection = await runSelector(s, prompt, signal);
    const { prompt: next, record } = buildInjection(s, systemPrompt, selection);
    s.lastTurn = record;
    return next;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Command rendering
// ---------------------------------------------------------------------------

function ageLabel(mtimeMs: number, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - mtimeMs) / 86400000));
  return days === 0 ? "today" : `${days}d`;
}

export function renderList(s: SessionState, now = Date.now()): string[] {
  if (s.files.length === 0) {
    return [
      "No memories found.",
      `  private: ${s.dirs.privateDir}`,
      `  team:    ${s.teamDir ?? "(none)"}`,
    ];
  }
  const lines: string[] = [
    `${s.files.length} memories (private: ${s.dirs.privateDir}${s.teamDir ? `, team: ${s.teamDir}` : ""})`,
  ];
  let totalBytes = 0;
  for (const f of s.files) {
    totalBytes += f.bytes;
    const pin =
      f.pinnedState === "true"
        ? " [pinned]"
        : f.pinnedState === "malformed"
          ? " [pinned?]"
          : "";
    const type = f.type ? `[${f.type}] ` : "";
    lines.push(
      `  ${type}${f.filename}${pin}  ${f.bytes}B  ${ageLabel(f.mtimeMs, now)}`,
    );
    lines.push(
      `      ${f.description ?? "(no description — invisible to the selector)"}`,
    );
  }
  lines.push(
    `total ${totalBytes}B` +
      (s.dropped > 0 ? `, ${s.dropped} dropped by maxFiles` : ""),
  );
  return lines;
}

export function renderWhy(s: SessionState): string[] {
  const t = s.lastTurn;
  if (!t) return ["No turn has been injected yet in this session."];
  return [
    "Last turn:",
    `  scanned:  ${t.scanned}${t.dropped > 0 ? ` (+${t.dropped} dropped)` : ""}`,
    `  pinned:   ${t.pinned.length > 0 ? t.pinned.join(", ") : "(none)"} — ${t.pinnedBytes}B`,
    `  selected: ${t.selected.length > 0 ? t.selected.join(", ") : "(none)"} — ${t.selectedBytes}B`,
    `  selector: ${t.selectorReason}${t.selectorLatencyMs !== undefined ? ` in ${t.selectorLatencyMs}ms` : ""}`,
    `  index:    ${t.indexTruncated ? "TRUNCATED" : "ok"}`,
  ];
}

export function renderBudget(s: SessionState): string[] {
  const lines = [
    `Session recall budget: ${s.budget.bytes}B / ${s.budget.max}B` +
      (s.budget.exhausted
        ? "  — EXHAUSTED, recall is off for this session"
        : ""),
    "Pinned injection is unaffected by the budget.",
    `Scanned files: ${s.files.length}${
      s.dropped > 0
        ? ` (+${s.dropped} dropped by maxFiles=${s.config.maxFiles})`
        : ""
    }`,
  ];
  const c = s.counters;
  lines.push(
    `Counters: turns ${c.turns}, scans ${c.scans}, files ${c.filesScanned}` +
      (c.filesDropped > 0 ? ` (+${c.filesDropped} dropped)` : "") +
      `, pinned ${c.pinnedInjected}, surfaced ${c.surfacedMemories} (${c.surfacedBytes}B)` +
      (c.turnsWithNoScope > 0
        ? `, ${c.turnsWithNoScope} turns with no scope root`
        : ""),
  );
  if (s.selectorDisabledReason)
    lines.push(`Selector disabled: ${s.selectorDisabledReason}`);
  else if (!s.config.selector.enabled)
    lines.push("Selector disabled by config.");
  const stats = s.selector?.stats;
  if (stats) {
    lines.push(
      `Selector calls: ${stats.calls}, failures ${stats.failures}, timeouts ${stats.timeouts}, ` +
        `truncated ${stats.truncated}, empty ${stats.emptyResults}` +
        (stats.lastLatencyMs !== undefined
          ? `, last ${stats.lastLatencyMs}ms`
          : ""),
    );
    if (stats.lastError) lines.push(`Last selector error: ${stats.lastError}`);
  }
  return lines;
}

export async function renderDryRun(
  s: SessionState,
  query: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!query.trim()) return ["usage: /memory dry-run <query>"];
  rescan(s);
  const result = await runSelector(s, query, signal);
  return [
    `dry-run: ${JSON.stringify(query)}`,
    `  verdict:  ${result.reason}${result.latencyMs !== undefined ? ` in ${result.latencyMs}ms` : ""}`,
    `  selected: ${result.selected.length > 0 ? result.selected.map((e) => e.filename).join(", ") : "(none)"}`,
    `  answer:   ${result.answerText ?? "(none)"}`,
    "  listing sent:",
    ...(result.listing
      ? result.listing.split("\n").map((l) => `    ${l}`)
      : ["    (empty)"]),
  ];
}

/** Write-path invariants. Never modifies a file. */
export function renderDoctor(s: SessionState): string[] {
  rescan(s);
  return renderFindings(
    diagnose({ files: s.files, indexPath: s.dirs.indexPath }),
  );
}

export const USAGE = [
  "/memory list           — scanned memories: scope, type, pinned state, size, age",
  "/memory why            — what the last turn injected",
  "/memory budget         — session recall budget and selector counters",
  "/memory dry-run <q>    — run the selector against <q> without spending a turn",
  "/memory doctor         — write-path invariants: scope, index, names, duplicates",
];
