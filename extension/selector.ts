/**
 * SELECT — the persistent selector conversation.
 *
 * This module is pure: it takes a `CompleteFn` and never imports pi or pi-ai
 * at runtime, so the whole of SELECT is testable with a mocked provider.
 * `index.ts` supplies the real `complete()` from `@earendil-works/pi-ai/compat`.
 */

import { SELECTOR_SYSTEM_PROMPT } from "./prompts.ts";
import type { MemoryFile, MemoryType } from "./scan.ts";
import { MEMORY_TYPES } from "./scan.ts";

/** The answer is a short filename list; 512 is ample and caps a runaway. */
export const SELECTOR_MAX_TOKENS = 512;

export const SELECTOR_TOOL_NAME = "select_memories";

/**
 * The selector's output contract, carried as the tool's parameter schema.
 */
export const SELECTOR_SCHEMA = {
  type: "object",
  properties: { selected_memories: { type: "array", items: { type: "string" } } },
  required: ["selected_memories"],
  additionalProperties: false,
} as const;

/**
 * `strict: "prefer"` is used instead of `"require"` so providers without
 * strict-tool support can fall back to text parsing.
 *
 * pi-ai's `resolveJsonSchemaStrictSampling` *throws* when a tool asks for
 * `"require"` and the model reports no strict-tool support. Anthropic's adapter
 * defaults `supportsStrictTools` to **false**, so `"require"` would make the
 * selector throw on every call for any Anthropic `selector.model` — defeating
 * the text-parsing fallback that exists precisely for that case. `"prefer"`
 * returns undefined instead, so the tool is still sent, `toolChoice` still
 * applies, and an unconstrained answer still lands in the fallback parser.
 */
export const SELECTOR_TOOL = {
  name: SELECTOR_TOOL_NAME,
  description: "Return the memory filenames that will clearly be useful for this query.",
  parameters: SELECTOR_SCHEMA,
  constrainedSampling: { type: "json_schema", strict: "prefer" },
} as const;

/** A model that echoes the listing's `[type] ` prefix still matches. */
export const TYPE_PREFIX = new RegExp(`^\\[(?:${MEMORY_TYPES.join("|")})\\]\\s+`);

// ---------------------------------------------------------------------------
// Minimal structural mirrors of the pi-ai shapes we touch. Declared locally so
// this module has no runtime or type dependency on pi-ai.
// ---------------------------------------------------------------------------

export interface SelectorTextContent {
  type: "text";
  text: string;
}

export interface SelectorToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type SelectorContent = SelectorTextContent | SelectorToolCall | { type: string };

export interface SelectorMessage {
  role: "user" | "assistant";
  content: SelectorContent[];
  timestamp?: number;
}

export interface SelectorResponse {
  content: SelectorContent[];
  /** pi's stop reasons. "length" is pi's name for max_tokens. */
  stopReason?: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
}

export interface CompleteArgs {
  systemPrompt: string;
  messages: SelectorMessage[];
  tools: Array<typeof SELECTOR_TOOL>;
  maxTokens: number;
  signal: AbortSignal;
}

export type CompleteFn = (args: CompleteArgs) => Promise<SelectorResponse>;

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ListingEntry {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description: string | null;
  type: MemoryType | undefined;
}

/**
 * `- [{type}] {filename} ({ISO mtime}): {description}`, with
 * the type prefix omitted when unknown and the `: description` tail omitted
 * when null.
 */
export function formatListing(entries: ListingEntry[]): string {
  return entries
    .map((e) => {
      const type = e.type ? `[${e.type}] ` : "";
      const iso = new Date(e.mtimeMs).toISOString();
      const head = `- ${type}${e.filename} (${iso})`;
      return e.description ? `${head}: ${e.description}` : head;
    })
    .join("\n");
}

export function toListingEntry(f: MemoryFile): ListingEntry {
  return {
    filename: f.filename,
    filePath: f.filePath,
    mtimeMs: f.mtimeMs,
    description: f.description,
    type: f.type,
  };
}

// ---------------------------------------------------------------------------
// Query gating
// ---------------------------------------------------------------------------

/** CJK ranges: these count as "wordy" even with no whitespace in the query. */
const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

/** A single whitespace-free token is not worth a selector call. */
export function queryIsSelectable(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed === "") return false;
  if (/\s/.test(trimmed)) return true;
  return CJK.test(trimmed.normalize("NFKC"));
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Extract the first balanced JSON object from free text. Returns null if none. */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Validate the schema shape and return the raw string list, or null. */
export function validateSelection(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const arr = (value as Record<string, unknown>).selected_memories;
  if (!Array.isArray(arr)) return null;
  return arr.filter((v): v is string => typeof v === "string");
}

/**
 * Pull `selected_memories` out of a response.
 *
 * Primary path: the forced `select_memories` tool call. Fallback: the first
 * balanced JSON object in any text block. Returns null when neither yields a
 * schema-valid object, which the caller turns into an empty selection.
 */
export function extractSelection(response: SelectorResponse): { raw: string[]; answerText: string } | null {
  if (response.stopReason === "length") return null;

  for (const block of response.content ?? []) {
    if (block.type !== "toolCall") continue;
    const call = block as SelectorToolCall;
    if (call.name !== SELECTOR_TOOL_NAME) continue;
    const raw = validateSelection(call.arguments);
    if (raw) return { raw, answerText: JSON.stringify(call.arguments) };
  }

  for (const block of response.content ?? []) {
    if (block.type !== "text") continue;
    const text = (block as SelectorTextContent).text;
    const json = firstJsonObject(text);
    if (!json) continue;
    try {
      const raw = validateSelection(JSON.parse(json));
      if (raw) return { raw, answerText: text };
    } catch {
      /* try the next block */
    }
  }

  return null;
}

/**
 * Resolve returned strings against the listing. A string that
 * does not match is retried once with a leading `[type] ` prefix stripped;
 * anything still unmatched is discarded silently.
 */
export function resolveFilenames(raw: string[], known: Map<string, ListingEntry>): ListingEntry[] {
  const out: ListingEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    if (typeof candidate !== "string") continue;
    const name = known.has(candidate) ? candidate : candidate.replace(TYPE_PREFIX, "");
    const entry = known.get(name);
    if (!entry || seen.has(name)) continue;
    seen.add(name);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The persistent conversation
// ---------------------------------------------------------------------------

export interface SelectorStats {
  calls: number;
  failures: number;
  timeouts: number;
  truncated: number;
  emptyResults: number;
  lastError: string | undefined;
  lastLatencyMs: number | undefined;
}

export interface SelectorRunResult {
  selected: ListingEntry[];
  /** Why nothing came back, when nothing came back. */
  reason:
    | "ok"
    | "disabled"
    | "no-candidates"
    | "all-surfaced"
    | "query-not-selectable"
    | "budget-exhausted"
    | "timeout"
    | "error"
    | "truncated"
    | "no-structured-output";
  /** The listing sent as message 1, for `/memory dry-run`. */
  listing: string;
  /** The model's raw answer, for `/memory dry-run`. */
  answerText: string | undefined;
  latencyMs: number | undefined;
}

/**
 * One selector conversation. Instantiate per session; call `run` per user
 * message. History grows only on success.
 */
export class SelectorConversation {
  private history: SelectorMessage[] = [];
  private listing = "";
  private known = new Map<string, ListingEntry>();
  private seeded = false;
  /** Absolute paths already surfaced in this session. */
  readonly surfaced = new Set<string>();
  readonly stats: SelectorStats = {
    calls: 0,
    failures: 0,
    timeouts: 0,
    truncated: 0,
    emptyResults: 0,
    lastError: undefined,
    lastLatencyMs: undefined,
  };

  private readonly complete: CompleteFn;
  private readonly opts: { maxSelected: number; timeoutMs: number; now?: () => number };

  constructor(
    complete: CompleteFn,
    opts: { maxSelected: number; timeoutMs: number; now?: () => number },
  ) {
    this.complete = complete;
    this.opts = opts;
  }

  /** Reset everything; used by `session_start`. */
  reset(): void {
    this.history = [];
    this.listing = "";
    this.known = new Map();
    this.seeded = false;
    this.surfaced.clear();
  }

  /** True once message 1 exists. Exposed for tests and `/memory why`. */
  get isSeeded(): boolean {
    return this.seeded;
  }

  get turnCount(): number {
    return (this.history.length - 1) / 2;
  }

  /** Mark a path as surfaced so it is never selected again. */
  markSurfaced(paths: Iterable<string>): void {
    for (const p of paths) this.surfaced.add(p);
  }

  /**
   * Seed message 1 from the current scan. Re-seeding replaces
   * the listing but keeps the accumulated query/answer turns, so "do not
   * re-select" stays enforceable across a rescan.
   */
  seed(entries: ListingEntry[]): void {
    this.known = new Map(entries.map((e) => [e.filename, e]));
    this.listing = formatListing(entries);
    const first: SelectorMessage = {
      role: "user",
      content: [{ type: "text", text: `Available memories:\n${this.listing}` }],
    };
    if (this.seeded) this.history[0] = first;
    else this.history.unshift(first);
    this.seeded = true;
  }

  private empty(reason: SelectorRunResult["reason"], latencyMs?: number): SelectorRunResult {
    return { selected: [], reason, listing: this.listing, answerText: undefined, latencyMs };
  }

  /**
   * Run one selection. Never throws; every failure path returns an empty
   * selection.
   */
  async run(query: string, externalSignal?: AbortSignal): Promise<SelectorRunResult> {
    if (!this.seeded || this.known.size === 0) return this.empty("no-candidates");
    if (!queryIsSelectable(query)) return this.empty("query-not-selectable");

    const available = [...this.known.values()].filter((e) => !this.surfaced.has(e.filePath));
    if (available.length === 0) return this.empty("all-surfaced");

    const userMessage: SelectorMessage = {
      role: "user",
      content: [{ type: "text", text: `Select memories relevant to:\n${query}` }],
    };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const startedAt = (this.opts.now ?? Date.now)();

    this.stats.calls++;
    let response: SelectorResponse;
    try {
      response = await this.complete({
        systemPrompt: SELECTOR_SYSTEM_PROMPT,
        messages: [...this.history, userMessage],
        tools: [SELECTOR_TOOL],
        maxTokens: SELECTOR_MAX_TOKENS,
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted && !externalSignal?.aborted;
      this.stats.failures++;
      if (timedOut) this.stats.timeouts++;
      this.stats.lastError = error instanceof Error ? error.message : String(error);
      return this.empty(timedOut ? "timeout" : "error", elapsed(startedAt, this.opts.now));
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }

    const latencyMs = elapsed(startedAt, this.opts.now);
    this.stats.lastLatencyMs = latencyMs;

    if (response.stopReason === "length") {
      this.stats.truncated++;
      return this.empty("truncated", latencyMs);
    }

    const extracted = extractSelection(response);
    if (!extracted) {
      this.stats.failures++;
      return this.empty("no-structured-output", latencyMs);
    }

    // History grows only on a successful call.
    this.history.push(userMessage, {
      role: "assistant",
      content: [{ type: "text", text: extracted.answerText }],
    });

    const selected = resolveFilenames(extracted.raw, this.known)
      .filter((e) => !this.surfaced.has(e.filePath))
      .slice(0, this.opts.maxSelected);

    if (selected.length === 0) this.stats.emptyResults++;

    return {
      selected,
      reason: "ok",
      listing: this.listing,
      answerText: extracted.answerText,
      latencyMs,
    };
  }
}

function elapsed(startedAt: number, now?: () => number): number {
  return (now ?? Date.now)() - startedAt;
}

// ---------------------------------------------------------------------------
// LIMIT — session byte budget
// ---------------------------------------------------------------------------

/**
 * Cumulative surfaced bytes gate the selector, not the pinned block.
 */
export class SessionBudget {
  private consumed = 0;
  private readonly maxSessionBytes: number;

  constructor(maxSessionBytes: number) {
    this.maxSessionBytes = maxSessionBytes;
  }

  get bytes(): number {
    return this.consumed;
  }

  get max(): number {
    return this.maxSessionBytes;
  }

  get exhausted(): boolean {
    return this.consumed >= this.maxSessionBytes;
  }

  add(bytes: number): void {
    this.consumed += bytes;
  }

  reset(): void {
    this.consumed = 0;
  }
}
