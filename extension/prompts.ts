/**
 * WRITE — the memory policy prompt, and the SELECT system prompt.
 *
 * These strings are the extension's whole behavioural surface: the policy
 * prompt is what teaches the main model to write memories, and the selector
 * prompt is what decides which memories come back. Both are load-bearing text —
 * edit them the way you would edit code, and see SPEC.md §5.3 and §7 for the
 * requirement each block satisfies.
 */

import { INDEX_FILENAME } from "./config.ts";

// ---------------------------------------------------------------------------
// SELECT — selector system prompt
// ---------------------------------------------------------------------------

/**
 * The selector's whole instruction set (REQ-SELECT-5). It names "the coding
 * agent" rather than any specific product, because the selector is describing
 * whichever agent this extension is loaded into.
 */
export const SELECTOR_SYSTEM_PROMPT = [
  "You are selecting memories that will be useful to the coding agent as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.",
  "Return a list of filenames for the memories that will clearly be useful to the coding agent as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.",
  "- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.",
  "- If there are no memories in the list that would clearly be useful, feel free to return an empty list.",
  '- Be especially conservative with user-profile and project-overview memories ([user], [project]). These describe the user\'s ongoing focus, not what every question is about. A profile saying "works on DB performance" is NOT relevant to a question that merely contains the word "performance" unless the question is actually about that DB work. Match on what the question IS ABOUT, not on surface keyword overlap with who the user is.',
  "- Do not re-select memories you already returned for an earlier query in this conversation.",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// WRITE — policy prompt sections
// ---------------------------------------------------------------------------

/** Used when only the private scope exists. */
const DIR_EXISTS =
  "This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).";

/** Used when both scopes exist. */
const DIRS_EXIST =
  "Both directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence).";

/** Wiki-link guidance, appended under the frontmatter template. */
const LINK_GUIDANCE =
  "In the body, link to related memories with `[[name]]`, where `name` is the other memory's `name:` slug. Link liberally — a `[[name]]` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.";

/** The frontmatter template quoted into step 1 of the save instructions. */
const FRONTMATTER_TEMPLATE = [
  "```markdown",
  "---",
  "name: {{short-kebab-case-slug}}",
  "description: {{one-line summary — used to decide relevance in future conversations, so be specific}}",
  "metadata:",
  "  type: {{user, feedback, project, reference}}",
  "---",
  "",
  "{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines. Link related memories with [[their-name]].}}",
  "```",
  "",
  LINK_GUIDANCE,
];

/**
 * The exclusion list (REQ-WRITE-6). The fourth bullet names AGENTS.md because
 * that is pi's context-file name.
 */
const WHAT_NOT_TO_SAVE = [
  "## What NOT to save in memory",
  "",
  "- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.",
  "- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.",
  "- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.",
  "- Anything already documented in AGENTS.md files.",
  "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
  "",
];

/** Staleness discipline — memories are point-in-time, verify before acting. */
const STALENESS_DISCIPLINE =
  "- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.";

/** When the model should reach for memory at all. */
const WHEN_TO_ACCESS = [
  "## When to access memories",
  "- When memories seem relevant, or the user references prior-conversation work.",
  "- When the user explicitly asks you to check, recall, or remember.",
  "",
  ">If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.",
  STALENESS_DISCIPLINE,
  "",
];

/**
 * Pinning is orthogonal to the index: the index gives cheap always-on breadth,
 * pinning gives unconditional depth. Running both raises a question neither
 * mechanism answers alone — whether a pinned memory also gets an index entry.
 * It does not; see REQ-WRITE-19/20 and SPEC.md §7.
 */
const PINNING_BULLETS = [
  "- Add `pinned: true` under `metadata` only for memories that must apply to every conversation regardless of topic. Pinned memories are injected unconditionally; at most {{maxPinned}} are loaded, newest first.",
  "- A pinned memory does NOT get an entry in `{{index}}`. Its full body is already in context, so a pointer adds nothing, and every index line is budget that could otherwise keep an unpinned memory above the truncation cut-off.",
  "- Pinning and unpinning are two-part edits. When you remove `pinned: true`, add the memory's `{{index}}` pointer in the same edit — otherwise it drops out of context entirely and is only reachable if recall happens to pick it. When you add `pinned: true` to a memory that is already indexed, remove its pointer in the same edit.",
];

export interface PolicyPromptOptions {
  /** Absolute private memory directory. */
  privateDir: string;
  /** Absolute team memory directory, or undefined when there is no project scope. */
  teamDir?: string;
  /** Index line cap, quoted into the "lines after N will be truncated" bullet. */
  indexMaxLines: number;
  /** Pinned cap, quoted into the pinning bullet. */
  maxPinned: number;
  /** Section title. Defaults to "Memory". */
  displayName?: string;
}

/**
 * Build the memory policy prompt: the index-based save flow, the type table,
 * and the two-scope directory sentences.
 *
 * Deterministic: same options in, byte-identical string out (REQ-WRITE-12).
 */
export function buildPolicyPrompt(opts: PolicyPromptOptions): string {
  const { privateDir, teamDir, indexMaxLines, maxPinned } = opts;
  const displayName = opts.displayName ?? "Memory";

  // One sentence for the single-scope case, another for private + team.
  const location = teamDir
    ? `at \`${privateDir}\` (private to this user) and \`${teamDir}\` (shared with all users of this project). ${DIRS_EXIST}`
    : `at \`${privateDir}\`. ${DIR_EXISTS}`;

  const howToSave = [
    "## How to save memories",
    "",
    "Saving a memory is a two-step process:",
    "",
    "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
    "",
    ...FRONTMATTER_TEMPLATE,
    "",
    `**Step 2** — add a pointer to that file in \`${INDEX_FILENAME}\`. \`${INDEX_FILENAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${INDEX_FILENAME}\`.`,
    "",
  ];

  if (teamDir) {
    howToSave.push(
      `\`${INDEX_FILENAME}\` lives in the private directory and indexes both; use a \`team/\` path prefix for team memories.`,
      "",
    );
  }

  howToSave.push(
    `- \`${INDEX_FILENAME}\` is always loaded into your conversation context — lines after ${indexMaxLines} will be truncated, so keep the index concise`,
    "- Keep the name, description, and type fields in memory files up-to-date with the content",
    "- Organize memory semantically by topic, not chronologically",
    "- Update or remove memories that turn out to be wrong or outdated",
    "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
    ...PINNING_BULLETS.map((b) =>
      b
        .replace("{{maxPinned}}", String(maxPinned))
        .replaceAll("{{index}}", INDEX_FILENAME),
    ),
    "",
  );

  const scopeGuidance = teamDir
    ? [
        "## Memory scope",
        "",
        "`user` memories are always private; default `feedback` to private, `project` and `reference` to team. Never write secrets or credentials to the team directory.",
        "",
        "- You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials.",
        "",
      ]
    : [];

  return [
    `# ${displayName}`,
    "",
    `You have a persistent, file-based memory system ${location}`,
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    ...scopeGuidance,
    ...howToSave,
    ...WHAT_NOT_TO_SAVE,
    ...WHEN_TO_ACCESS,
  ].join("\n");
}
