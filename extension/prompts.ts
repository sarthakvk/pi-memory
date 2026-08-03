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

/** The `<types>` table: one entry per memory type, with scope and examples. */
const TYPES_SECTION = [
  "## Types of memory",
  "",
  "There are several discrete types of memory that you can store in your memory system. Each type below declares a <scope> of `private`, `team`, or guidance for choosing between the two.",
  "",
  "<types>",
  "<type>",
  "    <name>user</name>",
  "    <scope>always private</scope>",
  "    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. Your goal in reading and writing these memories is to build up an understanding of who the user is and how you can be most helpful to them specifically. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>",
  "    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>",
  "    <how_to_use>When your work should be informed by the user's profile or perspective. For example, if the user is asking you to explain a part of the code, you should answer that question in a way that is tailored to the specific details that they will find most valuable or that helps them build their mental model in relation to domain knowledge they already have.</how_to_use>",
  "    <examples>",
  "    user: I'm a data scientist investigating what logging we have in place",
  "    assistant: [saves private user memory: user is a data scientist, currently focused on observability/logging]",
  "",
  "    user: I've been writing Go for ten years but this is my first time touching the React side of this repo",
  "    assistant: [saves private user memory: deep Go expertise, new to React and this project's frontend — frame frontend explanations in terms of backend analogues]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>feedback</name>",
  "    <scope>default to private. Save as team only when the guidance is clearly a project-wide convention that every contributor should follow (e.g., a testing policy, a build invariant), not a personal style preference.</scope>",
  "    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. These are a very important type of memory to read and write as they allow you to remain coherent and responsive to the way you should approach work in the project. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious. Before saving a private feedback memory, check that it doesn't contradict a team feedback memory — if it does, either don't save it or note the override explicitly.</description>",
  '    <when_to_save>Any time the user corrects your approach ("no not that", "don\'t", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>',
  "    <how_to_use>Let these memories guide your behavior so that the user and other users in the project do not need to offer the same guidance twice.</how_to_use>",
  "    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>",
  "    <examples>",
  "    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed",
  "    assistant: [saves team feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration. Team scope: this is a project testing policy, not a personal preference]",
  "",
  "    user: stop summarizing what you just did at the end of every response, I can read the diff",
  "    assistant: [saves private feedback memory: this user wants terse responses with no trailing summaries. Private because it's a communication preference, not a project convention]",
  "",
  "    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn",
  "    assistant: [saves private feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>project</name>",
  "    <scope>private or team, but strongly bias toward team</scope>",
  "    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work users are working on within this working directory.</description>",
  '    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., "Thursday" → "2026-03-05"), so the memory remains interpretable after time passes.</when_to_save>',
  "    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request, anticipate coordination issues across users, make better informed suggestions.</how_to_use>",
  "    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>",
  "    <examples>",
  "    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch",
  "    assistant: [saves team project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]",
  "",
  "    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements",
  "    assistant: [saves team project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>reference</name>",
  "    <scope>usually team</scope>",
  "    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>",
  "    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>",
  "    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>",
  "    <examples>",
  '    user: check the Linear project "INGEST" if you want context on these tickets, that\'s where we track all pipeline bugs',
  '    assistant: [saves team reference memory: pipeline bugs are tracked in Linear project "INGEST"]',
  "    </examples>",
  "</type>",
  "</types>",
  "",
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
  "These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.",
  "",
];

/** Staleness discipline — memories are point-in-time, verify before acting. */
const STALENESS_DISCIPLINE =
  "- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.";

/** When the model should reach for memory at all. */
const WHEN_TO_ACCESS = [
  "## When to access memories",
  "- When memories seem relevant, or the user references prior-conversation work.",
  "- You MUST access memory when the user explicitly asks you to check, recall, or remember.",
  "- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.",
  STALENESS_DISCIPLINE,
  "",
];

/** Citation format. Included only when `citeMemories` is on (REQ-WRITE-22). */
const CITING = [
  "## Citing memories",
  "",
  'Whenever you use or cite content from a memory in communication with the user, always wrap the entire sentence in <cc-memory filenames="{comma separated list of memory file names}">{sentence that references 1 or more memories}</cc-memory> tags. For example: <cc-memory filenames="testing-scripts.md">From a previously saved memory, I see that the command to run tests in this project is `bun test`</cc-memory>',
  "",
  "Only do this in your reply text to the user — never inside tool inputs such as plans, todo items, or question options.",
  "",
];

/** Verification discipline before acting on a remembered claim (REQ-WRITE-9). */
const BEFORE_RECOMMENDING = [
  "## Before recommending from memory",
  "",
  "A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:",
  "",
  "- If the memory names a file path: check the file exists.",
  "- If the memory names a function or flag: grep for it.",
  "- If the user is about to act on your recommendation (not just asking about history), verify first.",
  "",
  '"The memory says X exists" is not the same as "X exists now."',
  "",
  "A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.",
  "",
];

/** Memory vs. plans and tasks: what belongs in each (REQ-WRITE-10). */
const OTHER_PERSISTENCE = [
  "## Memory and other forms of persistence",
  "Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
  "- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
  "- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.",
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
  /**
   * Include `## Citing memories`. Off by default because pi has no render hook
   * to strip the tags before the user sees them (REQ-WRITE-22).
   */
  citeMemories?: boolean;
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
      b.replace("{{maxPinned}}", String(maxPinned)).replaceAll("{{index}}", INDEX_FILENAME),
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
    ...TYPES_SECTION,
    ...scopeGuidance,
    ...howToSave,
    ...WHAT_NOT_TO_SAVE,
    ...WHEN_TO_ACCESS,
    ...(opts.citeMemories ? CITING : []),
    ...BEFORE_RECOMMENDING,
    ...OTHER_PERSISTENCE,
  ].join("\n");
}
