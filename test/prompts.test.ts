import { assert, assertEqual, assertIncludes, assertNotIncludes, test } from "./harness.ts";
import { buildPolicyPrompt, SELECTOR_SYSTEM_PROMPT } from "../extension/prompts.ts";

const TWO_SCOPE = {
  privateDir: "/home/u/.pi/agent/memory",
  teamDir: "/work/repo/.pi/memory",
  indexMaxLines: 200,
  maxPinned: 8,
};

test("REQ-WRITE-4", "the concise scope rule is present word-for-word", () => {
  const p = buildPolicyPrompt(TWO_SCOPE);
  assertIncludes(
    p,
    "`user` memories are always private; default `feedback` to private, `project` and `reference` to team. Never write secrets or credentials to the team directory.",
  );
});

test("REQ-WRITE-11", "the sensitive-data warning is present when a team dir exists", () => {
  assertIncludes(
    buildPolicyPrompt(TWO_SCOPE),
    "- You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials.",
  );
});

test("REQ-WRITE-4", "scope guidance is omitted when there is no team dir", () => {
  const p = buildPolicyPrompt({ ...TWO_SCOPE, teamDir: undefined });
  assertNotIncludes(p, "## Memory scope");
  assertNotIncludes(p, "Never write secrets or credentials to the team directory.");
  assertIncludes(p, "You have a persistent, file-based memory system at `/home/u/.pi/agent/memory`.");
});

test("REQ-WRITE-1", "both directories are named when the project scope is live", () => {
  const p = buildPolicyPrompt(TWO_SCOPE);
  assertIncludes(
    p,
    "You have a persistent, file-based memory system at `/home/u/.pi/agent/memory` (private to this user) and `/work/repo/.pi/memory` (shared with all users of this project).",
  );
  assertIncludes(
    p,
    "Both directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence).",
  );
});

test("REQ-WRITE-2", "the build-up-over-time framing is present word-for-word", () => {
  const p = buildPolicyPrompt(TWO_SCOPE);
  assertIncludes(
    p,
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
  );
  assertIncludes(
    p,
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
  );
});

test("REQ-WRITE-5", "the two-step save, frontmatter template and index rules are present", () => {
  const p = buildPolicyPrompt(TWO_SCOPE);
  assertIncludes(p, "Saving a memory is a two-step process:");
  assertIncludes(
    p,
    "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
  );
  assertIncludes(p, "name: {{short-kebab-case-slug}}");
  assertIncludes(
    p,
    "description: {{one-line summary — used to decide relevance in future conversations, so be specific}}",
  );
  assertIncludes(p, "  type: {{user, feedback, project, reference}}");
  assertIncludes(
    p,
    "**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `MEMORY.md`.",
  );
  assertIncludes(
    p,
    "`MEMORY.md` lives in the private directory and indexes both; use a `team/` path prefix for team memories.",
  );
  assertIncludes(
    p,
    "- `MEMORY.md` is always loaded into your conversation context — lines after 200 will be truncated, so keep the index concise",
  );
  assertIncludes(
    p,
    "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
  );
  assertIncludes(
    p,
    "In the body, link to related memories with `[[name]]`, where `name` is the other memory's `name:` slug.",
  );
});

test("REQ-WRITE-5", "the pinning bullet documents the union design", () => {
  const p = buildPolicyPrompt(TWO_SCOPE);
  assertIncludes(
    p,
    "- Add `pinned: true` under `metadata` only for memories that must apply to every conversation regardless of topic. Pinned memories are injected unconditionally; at most 8 are loaded, newest first.",
  );
  assertIncludes(buildPolicyPrompt({ ...TWO_SCOPE, maxPinned: 3 }), "at most 3 are loaded");
});

test("REQ-WRITE-6", "the full five-bullet exclusion list is present", () => {
  const p = buildPolicyPrompt(TWO_SCOPE);
  assertIncludes(p, "## What NOT to save in memory");
  assertIncludes(
    p,
    "- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.",
  );
  assertIncludes(p, "- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.");
  assertIncludes(
    p,
    "- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.",
  );
  assertIncludes(p, "- Anything already documented in AGENTS.md files.");
  assertIncludes(
    p,
    "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
  );
  assertNotIncludes(p, "These exclusions apply even when the user explicitly asks you to save.");
  assertNotIncludes(p, "CLAUDE.md", "documented deviation: CLAUDE.md is rendered as AGENTS.md");
});

test("REQ-WRITE-8", "when-to-access includes the staleness discipline bullet", () => {
  const p = buildPolicyPrompt(TWO_SCOPE);
  assertIncludes(p, "## When to access memories");
  assertIncludes(
    p,
    "- When the user explicitly asks you to check, recall, or remember.",
  );
  assertIncludes(
    p,
    ">If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.",
  );
  assertIncludes(p, "- Memory records can become stale over time.");
  assertIncludes(
    p,
    "If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.",
  );
});

test("REQ-WRITE-12", "the policy prompt is deterministic", () => {
  assertEqual(buildPolicyPrompt(TWO_SCOPE), buildPolicyPrompt(TWO_SCOPE));
});

test("REQ-SELECT-5", "the selector system prompt is the one SPEC.md §5.3 documents", () => {
  const lines = SELECTOR_SYSTEM_PROMPT.split("\n");
  assertEqual(
    lines[0],
    "You are selecting memories that will be useful to the coding agent as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.",
  );
  assertEqual(
    lines[1],
    "Return a list of filenames for the memories that will clearly be useful to the coding agent as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.",
  );
  assertEqual(
    lines[2],
    "- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.",
  );
  assertEqual(
    lines[3],
    "- If there are no memories in the list that would clearly be useful, feel free to return an empty list.",
  );
  assert(
    lines[4].startsWith("- Be especially conservative with user-profile and project-overview memories ([user], [project])."),
    lines[4],
  );
  assertEqual(
    lines[5],
    "- Do not re-select memories you already returned for an earlier query in this conversation.",
  );
  assertNotIncludes(SELECTOR_SYSTEM_PROMPT, "Claude Code", "the prompt names no specific product");
});

test(["REQ-WRITE-19", "REQ-WRITE-20"], "the policy states the pinned/index rule and the transition", () => {
  const p = buildPolicyPrompt(TWO_SCOPE);
  assertIncludes(
    p,
    "- A pinned memory does NOT get an entry in `MEMORY.md`. Its full body is already in context, so a pointer adds nothing, and every index line is budget that could otherwise keep an unpinned memory above the truncation cut-off.",
  );
  assertIncludes(
    p,
    "- Pinning and unpinning are two-part edits. When you remove `pinned: true`, add the memory's `MEMORY.md` pointer in the same edit — otherwise it drops out of context entirely and is only reachable if recall happens to pick it. When you add `pinned: true` to a memory that is already indexed, remove its pointer in the same edit.",
  );
});
