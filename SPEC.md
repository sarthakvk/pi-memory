# pi-memory — Specification

Version: 1. Status: source of truth. Code follows this document; behaviour not
described here is a spec bug and is fixed here first.

`pi-memory` is a pi coding-agent extension that gives the agent a persistent,
file-based memory: markdown files on disk, a three-tier retrieval path into the
system prompt, and a policy prompt that teaches the model when to write. Every
prompt, constant, and routing rule below is a decision with a rationale
attached; where a choice is non-obvious, the rationale says why the alternative
was rejected.

Requirements carry stable ids `REQ-<AREA>-<n>`. Areas: `SCAN`, `INJECT`,
`SELECT`, `WRITE`, `LIMIT`, `CFG`, `FAIL`. Every test names the requirement it
covers.

---

## 1. Architecture

Three retrieval tiers.

| Tier | Trigger | Content |
|---|---|---|
| **pinned** | every turn, unconditional | files with `metadata.pinned: true` |
| **selected** | every user message, LLM selector | ≤ 5 files chosen from name + type + description |
| **on-demand** | the model's own judgement | any file, via the `read` tool |

Two scopes, split on **private vs. team**:

| Scope | Directory | Rationale |
|---|---|---|
| private | `~/.pi/agent/memory/` | all projects, never shared |
| team | `<project>/.pi/memory/` | git-tracked, travels with the repo |

One `MEMORY.md` lives in the **private** dir and indexes both scopes: bare
`file.md` for private entries, `team/file.md` for project entries.

Repository layout:

```
extension/
  index.ts        pi glue: hooks, commands, provider wiring
  config.ts       CFG: load, defaults, path resolution
  frontmatter.ts  frontmatter parse (dependency-free)
  scan.ts         SCAN
  inject.ts       INJECT + LIMIT (truncation, staleness, blocks)
  selector.ts     SELECT (pure: conversation state, prompt build, parse)
  prompts.ts      policy text and selector system prompt
test/
  *.test.ts       headless assertions, one file per area
  run.ts          runner
```

Only `index.ts` touches pi APIs at runtime. Every other module imports nothing
but `node:*`, so the whole of SCAN / INJECT / SELECT / LIMIT / CFG / FAIL is
testable headlessly with no pi process and no network.

### 1.1 Pi hook mapping

* `session_start` — resolve dirs, reset per-session state (selector history,
  surfaced-path set, byte counter).
* `before_agent_start` — the single injection point. Returns
  `{ systemPrompt }`, which pi chains across extensions. The selector also runs
  here.
* `session_shutdown` — drop per-session state.
* `registerCommand("memory")` — `list`, `why`, `budget`, `dry-run <query>`.

### 1.2 Known constraint: selector latency is not hideable

The natural way to make an LLM selector free is to run it as a *disposable
prefetch* concurrent with the main model stream, so its latency hides behind the
first tokens the user is already reading. Pi cannot do this:
`before_agent_start` is awaited before the request is built, so there is no
concurrent stream to hide behind. The selector therefore adds real wall-clock
latency to every message. Mitigations: a small default model, a hard timeout
(REQ-SELECT-13), and fail-open (REQ-FAIL-1).

---

## 2. Memory file format

```markdown
---
name: <short-kebab-case-slug>
description: <one-line — the entire retrieval surface>
metadata:
  type: user | feedback | project | reference
  pinned: true          # optional
---

<durable, applicable content — [[links]] to related memories>
```

`name` must match `^[a-z0-9_-]+$`. `description` is the only field besides
filename and type that the selector sees.

---

## 3. CFG — configuration

`~/.pi/agent/memory-config.json`. Every key optional.

| key | default | behaviour |
|---|---|---|
| `enabled` | `true` | master switch |
| `dir` | `~/.pi/agent/memory` | private scope root |
| `projectDir` | `.pi/memory` | project scope, relative to cwd; skipped if absent |
| `selector.enabled` | `true` | tier 2 on/off |
| `selector.model` | `openai-codex/gpt-5.4-mini` | any id resolvable in the model registry |
| `selector.maxSelected` | `5` | upper bound per query |
| `selector.timeoutMs` | `5000` | exceeded → empty selection |
| `maxSessionBytes` | `61440` | cumulative surfaced bytes before recall stops |
| `maxFiles` | `200` | scan cap, newest-first by mtime |
| `scanMaxLines` / `scanMaxBytes` | `30` / `65536` | per-file read budget during scan |
| `fileMaxLines` / `fileMaxBytes` | `200` / `4096` | per-file read budget when surfacing |
| `indexMaxLines` / `indexMaxBytes` | `200` / `25000` | `MEMORY.md` truncation thresholds |
| `maxPinned` | `8` | pinned memories injected per turn |
| `citeMemories` | `false` | include `## Citing memories`; off because pi cannot strip the tags (§7.2) |

Note the **two distinct read budgets**. A scan reads many more bytes but far
fewer lines than surfacing does: scanning only needs the frontmatter block and
the first body line, so 30 lines is plenty and the byte cap is there purely to
bound a pathological file. Surfacing needs the memory's actual content, so it
allows 200 lines but caps hard at 4096 bytes — a memory long enough to hit that
is too long to belong in every prompt, and the truncation notice points the
model at the `read` tool for the rest.

* **REQ-CFG-1** — Config is read from `<agentDir>/memory-config.json`. All keys
  are optional; every unset key takes the default above.
* **REQ-CFG-2** — A missing, unreadable, or syntactically invalid config file
  yields the full default config. No exception escapes.
* **REQ-CFG-3** — A key whose value has the wrong type is ignored and the
  default is used for that key alone.
* **REQ-CFG-4** — Unknown keys are ignored.
* **REQ-CFG-5** — `dir` accepts a leading `~` and absolute paths; `~` expands to
  the user's home directory.
* **REQ-CFG-6** — `projectDir` is resolved relative to the session cwd. If the
  resolved directory does not exist, the project scope is skipped entirely; no
  directory is created there.
* **REQ-CFG-7** — `enabled: false`, or the environment variable
  `PI_MEMORY_DISABLED` set to a non-empty value other than `0`, disables every
  hook: no scan, no injection, no selector.
* **REQ-CFG-8** — `selector.enabled: false` disables tier 2 only; pinned and
  index injection continue.

---

## 4. SCAN

* **REQ-SCAN-1** — For each existing scope root, walk recursively and collect
  every file ending in `.md`. Directory symlinks are **not** followed, so a
  symlink loop cannot hang or explode the scan. Symlinked *files* are still
  read.
* **REQ-SCAN-2** — `description` is `frontmatter.description` when present and a
  non-empty string. Otherwise it is derived from the body: the first line that is non-empty after stripping a leading `^#{1,6}\s+` and
  trimming, truncated to **120** characters. If no such line exists,
  `description` is `null`.
* **REQ-SCAN-3** — `type` is `frontmatter.metadata.type` when it is exactly one
  of `user`, `feedback`, `project`, `reference`; otherwise `undefined`.
* **REQ-SCAN-4** — `MEMORY.md` is excluded from the memory set at every scope
  and at every directory depth (`path.basename(f) !== "MEMORY.md"`).
* **REQ-SCAN-5** — Results are sorted newest-first by `mtimeMs`, then sliced to
  `maxFiles` (default 200).
* **REQ-SCAN-6** — Each file is read for scanning with a budget of
  `scanMaxLines` lines / `scanMaxBytes` bytes, truncating on the byte limit.
* **REQ-SCAN-7** — `pinnedState` is derived from `metadata.pinned`:
  `absent` when the key is missing or null; `true` / `false` for booleans and
  the strings `"true"` / `"false"`; `malformed` for any other value.
* **REQ-SCAN-8** — A file with malformed or unparseable frontmatter is still
  included in the scan with an empty frontmatter object. It does not abort the
  scan and does not throw.
* **REQ-SCAN-9** — A scope root that does not exist, or whose walk throws,
  contributes zero files. The overall scan still succeeds.
* **REQ-SCAN-10** — Files found under the project scope are named with a
  `team/` prefix in every user-visible and model-visible surface (index
  pointers, selector listing, `/memory list`), so one namespace covers both
  scopes.
* **REQ-SCAN-11** — Each entry records `mtimeMs` and `modifiedMs`. `modifiedMs`
  is `Date.parse(frontmatter.metadata.modified)` when that parses, else
  `mtimeMs`. Pinned ordering uses `modifiedMs`; scan ordering uses `mtimeMs`:
  a memory the author dated explicitly should outrank one that merely got
  touched.
* **REQ-SCAN-12** — An individual file that cannot be read is skipped; the rest
  of the scan is unaffected.

---

## 5. SELECT

### 5.1 Structured output — resolution of the open question

The selector must return one thing: a list of filenames. The obvious mechanism
is a request-level response format —

```js
{ type: "json_schema", schema: { type: "object",
  properties: { selected_memories: { type: "array", items: { type: "string" } } },
  required: ["selected_memories"], additionalProperties: false } }
```

— and **pi-ai has no request-level field for it.** Verified in
`node_modules/@earendil-works/pi-ai/dist`:

* `StreamOptions` (types.d.ts:47) — `temperature, maxTokens, signal, apiKey,
  fetch, transport, cacheRetention, sessionId, onPayload, onResponse, headers,
  timeoutMs, websocketConnectTimeoutMs, maxRetries, maxRetryDelayMs, metadata,
  env`. No response-format field.
* `SimpleStreamOptions extends StreamOptions` adds only `reasoning` and
  `thinkingBudgets`.
* Per-provider option types (`AnthropicOptions`, `OpenAIResponsesOptions`,
  `OpenAICodexResponsesOptions`, `OpenAICompletionsOptions`, `GoogleOptions`,
  `GoogleVertexOptions`, `MistralOptions`, `BedrockOptions`,
  `AzureOpenAIResponsesOptions`, `PiMessagesOptions`) add reasoning/verbosity/
  tool-choice/service-tier knobs only.
* A repo-wide grep for `json_schema|jsonSchema|response_format|responseFormat|
  structured` across all `.d.ts` returns exactly one hit: `ConstrainedSamplingConfig`,
  which is a **per-tool** setting:

  ```ts
  export type ConstrainedSamplingConfig =
    | { type: "json_schema"; strict: "prefer" | "require" }
    | { type: "grammar"; variants: GrammarVariants };
  export interface Tool<TParameters extends TSchema = TSchema> {
    name: string; description: string; parameters: TParameters;
    constrainedSampling?: false | ConstrainedSamplingConfig;
  }
  ```

  `resolveJsonSchemaStrictSampling(tool, supportsStrictMode)` is imported and
  applied by `anthropic-messages.js`, `openai-responses-shared.js`,
  `openai-completions.js`, `google-shared.js`, `mistral-conversations.js` and
  `bedrock-converse-stream.js` — i.e. it is provider-agnostic.

**Decision: a single forced tool call with json-schema constrained sampling,
with a defensive text parse as fallback. The payload-rewrite hook is rejected.**

* Rejected — `onPayload`: it exists and would work, but the payload shape is
  provider-specific (Responses API `text.format`, Chat Completions
  `response_format`, Anthropic's own shape, Google's `responseSchema`).
  `selector.model` is user-configurable to *any* id in the registry, so a
  provider-shape switch would silently degrade the moment someone points it at
  a provider we did not enumerate. Rejected for fragility, not capability.
* Chosen — tool with `constrainedSampling: { type: "json_schema", strict:
  "prefer" }`. This is the closest available analogue of a request-level
  response format: the same guarantee (schema-constrained sampling), expressed
  through a first-class, provider-agnostic pi-ai field that each adapter maps to
  its own strict-tool encoding. `toolChoice` is passed as an extra option key
  (`ProviderStreamOptions = StreamOptions & Record<string, unknown>`) to force
  the call on providers that honour it; providers that ignore it fall through to
  the text parse.

  **`"prefer"`, not `"require"`.** `resolveJsonSchemaStrictSampling` throws when
  a tool asks for `"require"` and the model reports no strict-tool support:

  ```js
  if (supportsStrictMode) return true;
  if (config.strict === "require")
    throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`);
  return undefined;
  ```

  Anthropic's adapter derives that flag as
  `supportsStrictTools: model.compat?.supportsStrictTools ?? false` — i.e. it
  defaults to **false**. With `"require"`, pointing `selector.model` at any
  Anthropic model would make every selector call throw, and the throw happens
  during request construction, so it never reaches the text-parsing fallback
  that exists for exactly this case. `"prefer"` returns `undefined` instead: the
  tool is still sent, `toolChoice` still applies, and an unconstrained answer
  still lands in the fallback parser. Graceful degradation across the whole
  registry beats a hard guarantee on part of it.
* Fallback — if the response carries no `toolCall` for our tool, any text
  content is scanned for the first balanced JSON object and parsed. Both paths
  converge on the same validator, and both fail open to `[]`.

Corroboration: pi ships `examples/extensions/structured-output.ts`, whose only
content is a `registerTool` with a typed parameter schema. A tool is pi's own
idiom for getting a structured object out of a model; there is no other one.

### 5.2 Call surface

The plan proposed resolving a `Model<Api>` with `findExactModelReferenceMatch`
and driving `ProviderStreams.stream`. Two adjustments:

* `findExactModelReferenceMatch` is **not** exported from the extension-visible
  entry point (`dist/core/index.d.ts` does not re-export it), so the extension
  carries its own equivalent: match `provider/modelId` exactly, else match a
  bare `modelId` and reject it when more than one provider offers it. Input is
  `ctx.modelRegistry.getAvailable()`.
* The call itself uses `complete(model, context, options)` from
  `@earendil-works/pi-ai/compat`, with credentials from
  `ctx.modelRegistry.getApiKeyAndHeaders(model)`. This is the pattern pi's own
  `examples/extensions/summarize.ts` uses, it resolves auth through pi's
  registry rather than reaching into `auth.json`, and it returns a settled
  `AssistantMessage` rather than a stream we would have to drain ourselves.

`stopReason` values are pi's, not Anthropic's: `"length"` is the name for
`max_tokens` (REQ-SELECT-11).

#### What actually reaches the wire on the default model

Traced through the adapters for `openai-codex/gpt-5.4-mini`, the default
`selector.model`. Source evidence only; no live call was made.

| Concern | Evidence | Result |
|---|---|---|
| `toolChoice: "required"` forwarded? | `openai-codex-responses.js` `buildRequestBody`: `tool_choice: options?.toolChoice ?? "auto"` | **yes**, reaches the request body |
| strict schema applied? | same file: `supportsStrictMode = model.compat?.supportsStrictMode ?? true`, passed to `convertResponsesTools`, which sets `functionTool.strict = constrainedStrict ?? defaultStrict` | **yes** — this model's `compat` in `models-store.json` is `{supportsOpenAIGrammarTools, supportsToolSearch}`, so `supportsStrictMode` is unset and defaults to `true`, giving `strict: true` |
| selector system prompt delivered? | `convertResponsesMessages(..., { includeSystemPrompt: false })` drops it from `input`, but the body sets `instructions: context.systemPrompt \|\| "You are a helpful assistant."` | **yes**, as the Responses API `instructions` field rather than a developer message — the `includeSystemPrompt: false` exists to stop it being sent twice |

So on the shipped default both halves of the structured-output guarantee reach
the wire and the selector system prompt is delivered. What remains unverified is
only whether the *service* honours them, which no amount of source reading can
settle.

**Cache control is pi-ai's to place.** The selector conversation is an
append-only history with a stable prefix, so it is exactly the shape prompt
caching pays off on. pi-ai exposes no per-message `cache_control` field; it
places Anthropic-style markers itself, on "the system prompt, last tool
definition, and last user, assistant, or tool-result text content", driven by
the model's `cacheControlFormat` compat flag and the `cacheRetention` stream
option. We therefore pass `cacheRetention: "short"` and let pi-ai place the
markers. For a conversation that only ever grows at the tail, automatic
placement on the system prompt and the last user message caches the whole stable
prefix — all an explicit marker could have achieved.

The selector tool:

```
name:        select_memories
description: Return the memory filenames that will clearly be useful for this query.
parameters:  { type: "object",
               properties: { selected_memories: { type: "array", items: { type: "string" } } },
               required: ["selected_memories"], additionalProperties: false }
constrainedSampling: { type: "json_schema", strict: "require" }
```

The parameter schema is the response contract from §5.1, moved from the request
level onto the tool.

### 5.3 Selector system prompt

```
You are selecting memories that will be useful to the coding agent as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.
Return a list of filenames for the memories that will clearly be useful to the coding agent as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- Be especially conservative with user-profile and project-overview memories ([user], [project]). These describe the user's ongoing focus, not what every question is about. A profile saying "works on DB performance" is NOT relevant to a question that merely contains the word "performance" unless the question is actually about that DB work. Match on what the question IS ABOUT, not on surface keyword overlap with who the user is.
- Do not re-select memories you already returned for an earlier query in this conversation.
```

The prompt names "the coding agent", not a product: the selector describes
whichever agent this extension is loaded into. The two conservatism bullets earn
their place — without them a selector returns something for every query, and a
memory surfaced on keyword overlap costs context and misleads.

### 5.4 Conversation shape

* **REQ-SELECT-1** — When `enabled` and `selector.enabled`, the selector runs
  once per user message, inside `before_agent_start`.
* **REQ-SELECT-2** — The selector is a *persistent conversation* keyed by scope
  root, not a per-turn call. Message 1 is
  `Available memories:\n{listing}`. It is built once per session and reused.
* **REQ-SELECT-3** — The listing line format is
  `- [{type}] {filename} ({ISO-8601 mtime}): {description}`.
  The `[{type}] ` prefix is omitted when type is unknown; `: {description}` is
  omitted when description is null. Lines are joined with `\n`.
* **REQ-SELECT-4** — Each query is appended as a user message with text
  `Select memories relevant to:\n{query}`.
* **REQ-SELECT-5** — The selector call carries *only* the selector system
  prompt, never pi's agent system prompt: the selector is a classifier, and the
  agent prompt would be both expensive and off-task. Cache markers are pi-ai's
  to place; see §5.2.
* **REQ-SELECT-6** — After a successful call, the query message and the model's
  raw answer are appended to the stored history, so subsequent
  queries in the session see them. This is what makes "Do not re-select
  memories you already returned" enforceable.
* **REQ-SELECT-7** — At most `selector.maxSelected` (default 5) memories are
  returned per query.
* **REQ-SELECT-8** — Returned strings are matched against the listing's
  filenames. A string that does not match is retried once after stripping a
  leading `^\[(?:user|feedback|project|reference)\]\s+` prefix, which is the
  listing's own type marker echoed back. Strings that still do not match are
  discarded silently.
* **REQ-SELECT-9** — A memory whose path was already surfaced in this session is
  excluded from the result, and is *not* re-injected. Deduplication is by
  absolute path.
* **REQ-SELECT-10** — `max_tokens` for the selector call is 512. The answer is
  at most five filenames; anything longer is a malfunction, and REQ-SELECT-11
  discards it.
* **REQ-SELECT-11** — A response whose stop reason is `length` (pi's name for
  `max_tokens`) yields `[]`.
* **REQ-SELECT-12** — A response with neither a matching tool call nor a text
  block yields `[]`.
* **REQ-SELECT-13** — The call is raced against `selector.timeoutMs`. On expiry
  the call is aborted and the result is `[]`.
* **REQ-SELECT-14** — The selector is skipped when the query contains no
  whitespace after trimming, unless the query contains CJK characters
  (`[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]`),
  where a single token can be a whole question.
* **REQ-SELECT-15** — The selector is skipped when the scan produced no
  candidate files, or when every candidate has already been surfaced.
* **REQ-SELECT-16** — On any failure the stored history is left unmodified, so
  a failed turn does not corrupt the conversation.

---

## 6. INJECT

The extension appends to `event.systemPrompt` and returns the result. It never
replaces or reorders what pi or earlier extensions produced.

* **REQ-INJECT-1** — The injected block is assembled in this order and appended
  to the incoming system prompt separated by a blank line:
  1. the memory policy prompt (§7),
  2. the `## MEMORY.md` index section,
  3. the pinned block,
  4. the selected-memories block.
  Empty sections are omitted entirely.
* **REQ-INJECT-2** — A memory whose age in whole days is `> 1` is prefixed with
  a staleness notice:

  ```
  This memory is {days} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.
  ```

  Age is `Math.max(0, Math.floor((Date.now() - mtimeMs) / 86400000))`. For the
  pinned block the notice is wrapped as `<system-reminder>{sentence}</system-reminder>\n`;
  for a surfaced memory it is emitted as a bare line above the `Memory:`
  header.
* **REQ-INJECT-3** — The pinned block is the header line
  `# Pinned memories (apply to every conversation)` followed by one
  `<pinned-memory path="{path}">\n{trimmed content}\n</pinned-memory>` element
  per memory, all joined with `\n`.
* **REQ-INJECT-4** — Pinned candidates are the scanned files with
  `pinnedState === "true"`, sorted by `modifiedMs` descending, sliced to
  `maxPinned` (default 8).
* **REQ-INJECT-5** — The `path` attribute is XML-attribute-escaped
  (`& < > " '`) after removing control characters
  `[\u0000-\u001F\u007F-\u009F\u2028\u2029]`, and the body has close tags
  scrubbed: `</` immediately preceding `pinned-memory` followed by `>`,
  whitespace, `/` or end becomes `<\/`. A memory file is untrusted input as far
  as block structure goes; neither a path nor a body may close the element
  early.
* **REQ-INJECT-6** — `MEMORY.md` from the private dir is always injected as
  `## MEMORY.md` followed by its content. When the file is absent or blank the
  content is: `` Your MEMORY.md is currently empty. When you save new memories, they will appear here. ``
* **REQ-INJECT-7** — The index is truncated when it exceeds `indexMaxLines`
  lines or `indexMaxBytes` bytes. Truncation keeps the first `indexMaxLines`
  lines, then, if still over the byte limit, cuts at the last newline before
  `indexMaxBytes`. A warning line is appended:

  ```
  > WARNING: MEMORY.md is {detail}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.
  ```

  where `{detail}` is:
  * byte-only overflow: `{bytes} (limit: {limit}) — index entries are too long`
  * line-only overflow: `{lines} lines (limit: {limit})`
  * both: `{lines} lines and {bytes}`
* **REQ-INJECT-8** — A surfaced (selected) memory is rendered as:

  ```
  [{staleness sentence}\n]Memory: {absolute path}:
  {body}
  ```

* **REQ-INJECT-9** — A surfaced memory body is read with a budget of
  `fileMaxLines` lines / `fileMaxBytes` bytes. When either limit bites, this
  notice is appended:

  ```
  > This memory file was truncated ({either `{fileMaxBytes} byte limit` or `first {fileMaxLines} lines`}). Use the read tool to view the complete file at: {path}
  ```

* **REQ-INJECT-10** — When no scope root exists on disk — the private dir was
  not created and the project dir is absent — the extension injects nothing at
  all, not even the policy prompt, and the turn proceeds with the system prompt
  exactly as it arrived. Telling a model to write memories to a directory that
  does not exist is worse than saying nothing.
* **REQ-INJECT-11** — The private memory dir is created if missing
  (`mkdir`, failures swallowed). The project dir is never created: a project
  scope is opt-in, and creating one would leave an empty directory in someone's
  repo.

---

## 7. WRITE — the policy prompt

The policy text is what teaches the main model to *write* memories. It is
assembled in `prompts.ts` and runs **both** retrieval mechanisms at once: a
`MEMORY.md` index keyed on `metadata.type`, and unconditional injection keyed on
`metadata.pinned`. Either alone would do; both are carried because they solve
different problems — the index gives cheap always-on breadth, pinning gives
unconditional depth for the few memories that must always apply. §7.1 covers the
one question that only arises when you run both: whether a pinned memory also
gets an index entry.

* **REQ-WRITE-1** — The prompt opens with the header `# Memory` and the
  directory sentences, adapted to two scopes:

  > You have a persistent, file-based memory system with two directories: a private directory at `{privateDir}` and a shared team directory at `{teamDir}`.

  and, when only the private dir exists:

  > You have a persistent, file-based memory system at `{privateDir}`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).

* **REQ-WRITE-2** — Unconditional:

  > You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.
  >
  > If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.

* **REQ-WRITE-3** — `## Types of memory` is included in full, with the
  `<types>` block with `user`, `feedback`, `project`,
  `reference`. Each type carries `<name>`, `<scope>`, `<description>`,
  `<when_to_save>`, `<how_to_use>` and `<examples>`; `feedback` and `project`
  additionally carry `<body_structure>`. Header sentence:

  > There are several discrete types of memory that you can store in your memory system. Each type below declares a &lt;scope&gt; of `private`, `team`, or guidance for choosing between the two.

* **REQ-WRITE-4** — Per-type scope routing:

  | type | scope |
  |---|---|
  | `user` | always private |
  | `feedback` | default to private. Save as team only when the guidance is clearly a project-wide convention that every contributor should follow (e.g., a testing policy, a build invariant), not a personal style preference. |
  | `project` | private or team, but strongly bias toward team |
  | `reference` | usually team |

  and the concise restatement:

  > `user` memories are always private; default `feedback` to private, `project` and `reference` to team. Never write secrets or credentials to the team directory.

* **REQ-WRITE-5** — `## How to save memories` describes the two-step save:

  > Saving a memory is a two-step process:
  >
  > **Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:
  >
  > ```markdown
  > ---
  > name: {{short-kebab-case-slug}}
  > description: {{one-line summary — used to decide relevance in future conversations, so be specific}}
  > metadata:
  >   type: {{user, feedback, project, reference}}
  > ---
  >
  > {{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines. Link related memories with [[their-name]].}}
  > ```
  >
  > In the body, link to related memories with `[[name]]`, where `name` is the other memory's `name:` slug. Link liberally — a `[[name]]` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.
  >
  > **Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `MEMORY.md`.

  followed by:

  > - `MEMORY.md` is always loaded into your conversation context — lines after 200 will be truncated, so keep the index concise
  > - Keep the name, description, and type fields in memory files up-to-date with the content
  > - Organize memory semantically by topic, not chronologically
  > - Update or remove memories that turn out to be wrong or outdated
  > - Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.

  Because both mechanisms are live (§7), one further bullet documents pinning:

  > - Add `pinned: true` under `metadata` only for memories that must apply to every conversation regardless of topic. Pinned memories are injected unconditionally; at most 8 are loaded, newest first.

  `MEMORY.md` is described as living in the private directory and indexing both
  scopes, with a `team/` path prefix for team memories.

* **REQ-WRITE-6** — `## What NOT to save in memory` — five bullets plus a
  closing paragraph. The through-line is that memory is for what the repo cannot
  tell you: anything derivable by reading the code, the git history, or
  AGENTS.md does not belong in it.

  > - Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.
  > - Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.
  > - Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
  > - Anything already documented in CLAUDE.md files.
  > - Ephemeral task details: in-progress work, temporary state, current conversation context.
  >
  > These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.


* **REQ-WRITE-7** — `## Citing memories`:

  > Whenever you use or cite content from a memory in communication with the user, always wrap the entire sentence in `<cc-memory filenames="{comma separated list of memory file names}">{sentence that references 1 or more memories}</cc-memory>` tags. For example: `<cc-memory filenames="testing-scripts.md">From a previously saved memory, I see that the command to run tests in this project is `bun test`</cc-memory>`
  >
  > Only do this in your reply text to the user — never inside tool inputs such as plans, todo items, or question options.

  This is a *usage* instruction for the main model. It is **not** the selector
  output format.

  **Included only when `citeMemories` is true, which is not the default.** See
  §7.2 for why.

* **REQ-WRITE-8** — `## When to access memories`, including its trailing
  staleness-discipline bullet:

  > - When memories seem relevant, or the user references prior-conversation work.
  > - You MUST access memory when the user explicitly asks you to check, recall, or remember.
  > - If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.
  > - Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.

* **REQ-WRITE-9** — `## Before recommending from memory`:

  > A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:
  > - If the memory names a file path: check the file exists.
  > - If the memory names a function or flag: grep for it.
  > - If the user is about to act on your recommendation (not just asking about history), verify first.
  >
  > "The memory says X exists" is not the same as "X exists now."
  >
  > A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.

* **REQ-WRITE-10** — `## Memory and other forms of persistence`:

  > Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.
  > - When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.
  > - When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.

* **REQ-WRITE-11** — The scope sentence for team writes:

  > - You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials.

* **REQ-WRITE-12** — The policy prompt is deterministic: given the same config
  and the same directory state it produces byte-identical output.

### 7.1 Write-path invariants

The policy prompt tells the model how to write. Prompting alone gives no
feedback when it gets it wrong: a misfiled memory, a missing index pointer, or
a description too vague to retrieve on are all silent failures. The following
invariants make those states *checkable*, and `/memory doctor` (REQ-CMD-3)
reports them. They are advisory: nothing is auto-corrected and nothing blocks a
turn.

* **REQ-WRITE-13** — Scope invariant. A memory whose `metadata.type` is `user`
  must live in the private scope. A `user` memory found under the project scope
  is reported as a scope violation, because the routing rule is unconditional
  there: "`user` memories are always private" (REQ-WRITE-4).
* **REQ-WRITE-14** — Index invariant. Every scanned **unpinned** memory should
  have a pointer in `MEMORY.md`, and every pointer in `MEMORY.md` should resolve
  to a scanned memory. Pointers are the markdown link targets (`](target)`) plus
  any bare `*.md` token on a line. Unindexed memories and dangling pointers are
  both reported. This is the checkable half of the two-step save (REQ-WRITE-5).
  Pinned memories are exempt from the "should have a pointer" half by
  REQ-WRITE-19; an *unpinned* memory with no pointer is the dangerous state,
  because it is then reachable only if the selector happens to pick it.
* **REQ-WRITE-15** — Name invariant. `name` must be present and match
  `^[a-z0-9_-]+$`. A missing or non-conforming name is reported.
* **REQ-WRITE-16** — Description invariant. A memory with no `description` and
  no derivable body fallback is reported: `description` is the whole retrieval
  surface, so such a memory can never be selected.
* **REQ-WRITE-17** — Duplicate invariant. Two memories whose descriptions
  reduce to the same significant-word set are reported as probable duplicates.
  Reduction: lowercase, strip non-alphanumerics, drop words of two characters or
  fewer, deduplicate, sort. This is the checkable half of "Do not write
  duplicate memories" (REQ-WRITE-5).
* **REQ-WRITE-18** — `/memory doctor` on a clean memory directory reports no
  findings. Every finding names the file it concerns.

#### Pinned memories and the index

A pinned memory can otherwise reach context twice: its full body inside
`<pinned-memory>`, plus a one-line pointer in `MEMORY.md`. The index is injected
as-is from disk (REQ-INJECT-6), so the extension does not control its
membership — this is a write-policy question, not a code bug.

* **REQ-WRITE-19** — A pinned memory is **excluded** from `MEMORY.md`. It has no
  index pointer for as long as it carries `pinned: true`.

  Rationale. The pointer has no consumer. The body is already inline, so it adds
  nothing the model can act on, and the selector reads the **scan**, not the
  index (REQ-SELECT-2), so index membership has zero effect on retrieval. It is
  also mildly incoherent — it points the model at a file whose content is
  already in front of it, inviting a redundant read.

  The decisive argument is not the ~30 tokens per entry but the index budget.
  `MEMORY.md` truncates at 200 lines / 25000 bytes (REQ-INJECT-7), and
  truncation drops the *tail*. Every line spent on a pinned memory — whose
  content is already in context — is a line that can push a genuinely unindexed
  memory past the cut-off and out of the model's view entirely. Pinned entries
  in the index can therefore cost visibility, not just tokens.

  *Considered and rejected: render-time filtering.* The extension could keep the
  on-disk index complete and strip pinned entries from the injected copy,
  removing the redundancy without the transition hazard of REQ-WRITE-20. Rejected
  on three counts: it would mean rewriting free-form markdown (a line may
  reference several files, dropping a line can orphan a heading, and the
  line/byte accounting that drives truncation would no longer describe the file);
  and it makes the injected index differ from the file on disk, which is
  confusing precisely when someone is comparing `/system-prompt` against
  `MEMORY.md` to debug retrieval.

  *Counter-argument considered: the index as a browsable inventory.* Rejected
  because `/memory list` already gives the complete inventory, built from the
  scan, independent of both index membership and of what any turn injected. The
  index's job is retrieval pointers, not inventory.

* **REQ-WRITE-20** — Pinning and unpinning are **two-part edits**, made together:
  * removing `pinned: true` requires **adding** an index pointer in the same
    edit, otherwise the memory silently becomes selector-only;
  * adding `pinned: true` to an indexed memory requires **removing** its pointer
    in the same edit.

  This transition is the cost of REQ-WRITE-19 and is the part that actually
  bites, because neither half fails loudly.

* **REQ-WRITE-21** — Doctor reports a pinned memory that still has an index
  pointer (`pinned-and-indexed`). Together with the REQ-WRITE-14 `unindexed`
  finding — which now fires only for unpinned memories — both directions of the
  REQ-WRITE-20 transition are caught.

### 7.2 Citation tags — why they are off by default

`## Citing memories` asks the main model to wrap every memory-derived sentence
in `<cc-memory filenames="…">…</cc-memory>`. That is an *internal channel* that
travels inside the reply text, and it only works if something downstream strips
the tags before the user sees them and consumes them for attribution.

Pi has nothing that can. Its `ExtensionAPI` exposes no render or display hook — the
full event list is `session_*`, `context`, `before_provider_request`,
`before_provider_headers`, `after_provider_response`, `before_agent_start`,
`agent_*`, `turn_*`, `message_start|update|end`, `tool_*`, `model_select`,
`thinking_level_select`, `user_bash`, and `input`. The only output-shaped result
types are `InputEventResult` (`action: "transform"`, which rewrites *user input*,
not assistant text) and `MessageEndEventResult.message`, which replaces the
finalized message *after* `message_update` has already streamed it token-by-token
to the terminal. Stripping at `message_end` would therefore clean the persisted
session but not the text the user watched appear.

* **REQ-WRITE-22** — `## Citing memories` is included in the policy prompt only
  when `citeMemories` is true. The default is **false**: without a stripping
  renderer, enabling it emits raw XML into user-visible replies. The section
  text itself is kept intact (REQ-WRITE-7), so a host that *does* grow a render
  hook can turn the flag on and get full attribution.

*Rejected:* rewriting the citation instruction into a human-readable form (e.g. a
trailing `— from memory: dev-machine.md`). It preserves provenance without the
XML, but it puts formatting rules for user-visible prose into a memory
extension's remit, and provenance is already available on demand via
`/memory why`. Revisit if attribution proves to be missed.

---

## 8. LIMIT

* **REQ-LIMIT-1** — The extension tracks cumulative *surfaced* bytes across the
  session — the sum of surfaced memory content. Once that total is
  `>= maxSessionBytes`, the selector is skipped for the remainder of the
  session. Pinned and index injection are unaffected.
* **REQ-LIMIT-2** — At most `maxFiles` files survive a scan.
* **REQ-LIMIT-3** — The index is truncated per REQ-INJECT-7.
* **REQ-LIMIT-4** — A surfaced memory is truncated per REQ-INJECT-9.
* **REQ-LIMIT-5** — At most `maxPinned` pinned memories are injected.
* **REQ-LIMIT-6** — Byte counting is over UTF-8 bytes, not UTF-16 code units
  (`String.length`). UTF-8 is the honest measure of what goes on the wire; the
  difference only matters for non-ASCII memories, and only makes the budget
  slightly more conservative.

---

## 9. FAIL

Memory never blocks work. Every failure degrades to a normal turn.

* **REQ-FAIL-1** — Any selector error, timeout, abort, non-JSON answer, or
  schema-invalid answer yields an empty selection and a normal turn.
* **REQ-FAIL-2** — A `selector.model` that cannot be resolved in the model
  registry, or whose provider has no configured credentials, disables the
  selector for the session after one warning. Pinned and index injection
  continue.
* **REQ-FAIL-3** — A memory directory that does not exist contributes nothing
  and raises nothing.
* **REQ-FAIL-4** — A malformed or unreadable memory file is skipped without
  breaking the scan (see REQ-SCAN-8, REQ-SCAN-12).
* **REQ-FAIL-5** — An unexpected exception anywhere inside `before_agent_start`
  is caught; the handler returns `undefined` and the system prompt is left
  exactly as it arrived.
* **REQ-FAIL-6** — An oversized index truncates with the documented warning
  rather than being dropped or blowing the context.

---

## 10. Commands

`/memory <subcommand>`:

| subcommand | behaviour |
|---|---|
| `list` | scanned files: scope, name, type, pinned state, description, bytes, age |
| `why` | what the last turn injected and why: pinned ids, selected ids, selector verdict, byte totals |
| `budget` | `maxSessionBytes`, bytes consumed, whether recall is still live, file/index counts |
| `dry-run <query>` | runs the selector against `<query>` without spending a turn; prints the listing sent, the raw answer, and the resolved selection |
| `doctor` | write-path invariants (§7.1): scope violations, index drift, pinned/index redundancy, bad names, missing descriptions, probable duplicates |

* **REQ-CMD-1** — Every subcommand is read-only except `dry-run`, which mutates
  only the selector conversation history (as a real query would).
* **REQ-CMD-2** — An unknown or empty subcommand prints usage.
* **REQ-CMD-3** — `doctor` reports the §7.1 invariants and never modifies a
  file.
* **REQ-CMD-4** — `budget` reports session counters: turns injected, scans run,
  files scanned and dropped, pinned memories injected, surfaced memories and
  bytes, and the selector's call / failure / timeout / truncation / empty
  counts. Counters are session-scoped and reset with the session.

---

## 11. Test strategy and what is *not* verified

Tests are headless: they import the pure modules, drive them against temporary
directories, and assert on returned strings. The provider stream is mocked; **no
test makes a live model API call.**

Not verifiable in this environment, left for interactive checking by the user:

1. `/reload` + `/system-prompt` showing the injected blocks in a live TUI. The
   headless equivalent is `test/pipeline.test.ts`, which asserts on the exact
   string `before_agent_start` would return, but it does not prove pi loads and
   invokes the extension.
2. `/memory list`, `/memory why`, `/memory budget`, `/memory dry-run`,
   `/memory doctor` *rendering*. The line content of each is asserted headlessly;
   how `ctx.ui.notify` displays a multi-line string is not.
3. A live turn confirming a planted memory reaches context and is acted on.
4. Latency measurement: ten turns with `selector.enabled` true vs. false. This
   is the number that decides whether the deferred-injection fallback (§1.2) is
   needed. Nothing headless can produce it.
5. Real end-to-end selector *accuracy* against `openai-codex/gpt-5.4-mini`.
   Narrowed: §5.2 now traces the adapters and confirms that `tool_choice`,
   `strict: true`, and the selector system prompt all reach the request body for
   this model. What source cannot settle is whether the service honours them,
   and whether the model's selections are actually good. The mocked tests
   exercise both the tool-call and text-fallback paths but cannot say which one
   production takes.

Partially resolved:

6. **Does pi load an extension directory that is a symlink?** Source says yes:
   `dist/core/extensions/loader.js:504` walks the extensions directory with
   `readdirSync(dir, { withFileTypes: true })` and recurses on
   `entry.isDirectory() || entry.isSymbolicLink()`. Not confirmed at runtime.
   `pi --offline --list-models` runs clean with the symlink installed, but that
   is *not* evidence: a deliberately broken extension passed with `-e` produces
   an equally clean run and exit code 0, so `--list-models` does not load
   extensions. The only runtime evidence is that `extension/index.ts` imports
   without error under Node's type stripping with the real
   `@earendil-works/pi-ai` resolved.
7. `openai-codex/gpt-5.4-mini`, the default `selector.model`, is present in this
   environment's model registry (`pi --list-models`), so REQ-FAIL-2's
   "model not found" path should not fire on the default config.

Items 4 and 5 are where a headless pass does not imply a working system.
