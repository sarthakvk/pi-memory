import {
  assert,
  assertDeepEqual,
  assertEqual,
  assertIncludes,
  test,
} from "./harness.ts";
import {
  extractSelection,
  firstJsonObject,
  formatListing,
  queryIsSelectable,
  resolveFilenames,
  SELECTOR_MAX_TOKENS,
  SELECTOR_SCHEMA,
  SELECTOR_TOOL,
  SELECTOR_TOOL_NAME,
  SelectorConversation,
  SessionBudget,
  validateSelection,
  type CompleteArgs,
  type CompleteFn,
  type ListingEntry,
  type SelectorResponse,
} from "../extension/selector.ts";
import { SELECTOR_SYSTEM_PROMPT } from "../extension/prompts.ts";

const T0 = Date.parse("2026-08-01T09:00:00.000Z");

function entry(filename: string, description: string | null, type?: ListingEntry["type"]): ListingEntry {
  return { filename, filePath: `/m/${filename}`, mtimeMs: T0, description, type };
}

const ENTRIES: ListingEntry[] = [
  entry("testing-scripts.md", "how to run this project's tests", "project"),
  entry("user-role.md", "the user is a staff engineer working on ingest", "user"),
  entry("terse-replies.md", "user wants terse replies with no trailing summary", "feedback"),
  entry("no-desc.md", null),
];

/** Mock provider: returns a canned tool call and records what it was asked. */
function toolCallProvider(
  names: string[],
  capture?: { last?: CompleteArgs },
): CompleteFn {
  return async (args) => {
    if (capture) capture.last = args;
    return {
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: SELECTOR_TOOL_NAME,
          arguments: { selected_memories: names },
        },
      ],
    };
  };
}

function conversation(complete: CompleteFn, maxSelected = 5, timeoutMs = 5000): SelectorConversation {
  const c = new SelectorConversation(complete, { maxSelected, timeoutMs });
  c.seed(ENTRIES);
  return c;
}

// --- schema / tool ---------------------------------------------------------

test("REQ-SELECT-8", "the tool parameter schema is the documented output contract", () => {
  assertDeepEqual(SELECTOR_SCHEMA, {
    type: "object",
    properties: { selected_memories: { type: "array", items: { type: "string" } } },
    required: ["selected_memories"],
    additionalProperties: false,
  });
  assertEqual(SELECTOR_TOOL.constrainedSampling.type, "json_schema");
});

test("REQ-SELECT-8", "constrained sampling is 'prefer' so unsupported providers degrade", () => {
  // pi-ai's resolveJsonSchemaStrictSampling THROWS on "require" when the model
  // reports no strict-tool support, and Anthropic defaults supportsStrictTools
  // to false. "require" would therefore break the selector outright for any
  // Anthropic selector.model, never reaching the text-parsing fallback.
  assertEqual(SELECTOR_TOOL.constrainedSampling.strict, "prefer");
});

test("REQ-SELECT-10", "max_tokens is 512", () => {
  assertEqual(SELECTOR_MAX_TOKENS, 512);
});

// --- listing ---------------------------------------------------------------

test("REQ-SELECT-3", "the listing format is the one SPEC.md documents", () => {
  const listing = formatListing(ENTRIES);
  const lines = listing.split("\n");
  assertEqual(
    lines[0],
    "- [project] testing-scripts.md (2026-08-01T09:00:00.000Z): how to run this project's tests",
  );
  assertEqual(lines[3], "- no-desc.md (2026-08-01T09:00:00.000Z)", "no type prefix, no description tail");
});

// --- query gating ----------------------------------------------------------

test("REQ-SELECT-14", "a whitespace-free query is not worth a selector call", () => {
  assertEqual(queryIsSelectable("how do I run the tests"), true);
  assertEqual(queryIsSelectable("  hello world  "), true);
  assertEqual(queryIsSelectable("tests"), false);
  assertEqual(queryIsSelectable(""), false);
  assertEqual(queryIsSelectable("   "), false);
  assertEqual(queryIsSelectable("テスト"), true, "CJK counts as wordy without whitespace");
  assertEqual(queryIsSelectable("测试"), true);
});

// --- parsing ---------------------------------------------------------------

test("REQ-SELECT-8", "a tool call is the primary extraction path", () => {
  const r = extractSelection({
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "1", name: SELECTOR_TOOL_NAME, arguments: { selected_memories: ["a.md"] } },
    ],
  });
  assertDeepEqual(r?.raw, ["a.md"]);
});

test("REQ-SELECT-8", "a tool call with another name is ignored", () => {
  const r = extractSelection({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "1", name: "something_else", arguments: { selected_memories: ["a.md"] } }],
  });
  assertEqual(r, null);
});

test("REQ-SELECT-12", "a text block carrying JSON is the fallback path", () => {
  const r = extractSelection({
    stopReason: "stop",
    content: [{ type: "text", text: 'Here you go:\n{"selected_memories": ["a.md", "b.md"]}\nHope that helps.' }],
  });
  assertDeepEqual(r?.raw, ["a.md", "b.md"]);
});

test("REQ-SELECT-11", "stopReason length yields no selection", () => {
  const r = extractSelection({
    stopReason: "length",
    content: [{ type: "toolCall", id: "1", name: SELECTOR_TOOL_NAME, arguments: { selected_memories: ["a.md"] } }],
  });
  assertEqual(r, null, "a truncated response is discarded even if it looks parseable");
});

test("REQ-SELECT-12", "a response with no text and no tool call yields no selection", () => {
  assertEqual(extractSelection({ stopReason: "stop", content: [] }), null);
  assertEqual(extractSelection({ stopReason: "stop", content: [{ type: "thinking" }] }), null);
});

test("REQ-FAIL-1", "malformed JSON and wrong shapes are rejected", () => {
  assertEqual(extractSelection({ stopReason: "stop", content: [{ type: "text", text: "{not json" }] }), null);
  assertEqual(extractSelection({ stopReason: "stop", content: [{ type: "text", text: "no braces here" }] }), null);
  assertEqual(validateSelection({ selected_memories: "a.md" }), null);
  assertEqual(validateSelection(["a.md"]), null);
  assertEqual(validateSelection(null), null);
  assertDeepEqual(validateSelection({ selected_memories: ["a.md", 7, null] }), ["a.md"]);
});

test("REQ-SELECT-12", "firstJsonObject handles nesting, strings and braces", () => {
  assertEqual(firstJsonObject('x {"a": {"b": 1}} y'), '{"a": {"b": 1}}');
  assertEqual(firstJsonObject('{"a": "}"}'), '{"a": "}"}');
  assertEqual(firstJsonObject('{"a": "\\""}'), '{"a": "\\""}');
  assertEqual(firstJsonObject("no object"), null);
});

// --- filename resolution ---------------------------------------------------

test("REQ-SELECT-8", "unknown filenames are discarded silently", () => {
  const known = new Map(ENTRIES.map((e) => [e.filename, e]));
  const out = resolveFilenames(["testing-scripts.md", "hallucinated.md", "user-role.md"], known);
  assertDeepEqual(out.map((e) => e.filename), ["testing-scripts.md", "user-role.md"]);
});

test("REQ-SELECT-8", "a leading [type] prefix is stripped before matching", () => {
  const known = new Map(ENTRIES.map((e) => [e.filename, e]));
  const out = resolveFilenames(["[project] testing-scripts.md", "[user] user-role.md"], known);
  assertDeepEqual(out.map((e) => e.filename), ["testing-scripts.md", "user-role.md"]);
});

test("REQ-SELECT-8", "duplicates in the response collapse", () => {
  const known = new Map(ENTRIES.map((e) => [e.filename, e]));
  const out = resolveFilenames(["user-role.md", "user-role.md", "[user] user-role.md"], known);
  assertEqual(out.length, 1);
});

// --- conversation ----------------------------------------------------------

test(["REQ-SELECT-2", "REQ-SELECT-4", "REQ-SELECT-5"], "the conversation shape matches SPEC.md §5.4", async () => {
  const capture: { last?: CompleteArgs } = {};
  const c = conversation(toolCallProvider(["testing-scripts.md"], capture));
  await c.run("how do I run the tests");

  const args = capture.last;
  assert(args !== undefined, "the provider was called");
  assertEqual(args.systemPrompt, SELECTOR_SYSTEM_PROMPT, "only the selector system prompt is sent");
  assertEqual(args.maxTokens, 512);
  assertEqual(args.tools[0].name, SELECTOR_TOOL_NAME);
  assertEqual(args.messages.length, 2);
  assertEqual(args.messages[0].role, "user");
  assertIncludes((args.messages[0].content[0] as { text: string }).text, "Available memories:\n- [project] testing-scripts.md");
  assertEqual(
    (args.messages[1].content[0] as { text: string }).text,
    "Select memories relevant to:\nhow do I run the tests",
  );
});

test("REQ-SELECT-6", "history accumulates so the model can honour do-not-re-select", async () => {
  const capture: { last?: CompleteArgs } = {};
  const c = conversation(toolCallProvider([], capture));
  await c.run("first question here");
  await c.run("second question here");
  const args = capture.last;
  assert(args !== undefined, "provider called");
  // listing + (q1, a1) + q2
  assertEqual(args.messages.length, 4);
  assertEqual(args.messages[1].role, "user");
  assertEqual(args.messages[2].role, "assistant");
  assertEqual(
    (args.messages[3].content[0] as { text: string }).text,
    "Select memories relevant to:\nsecond question here",
  );
  assertEqual(c.turnCount, 2);
});

test("REQ-SELECT-9", "a memory surfaced once is never selected again", async () => {
  const c = conversation(toolCallProvider(["testing-scripts.md", "user-role.md"]));
  const first = await c.run("what is the test command");
  assertDeepEqual(first.selected.map((e) => e.filename), ["testing-scripts.md", "user-role.md"]);
  c.markSurfaced(first.selected.map((e) => e.filePath));

  const second = await c.run("remind me about the tests");
  assertEqual(second.selected.length, 0, "already-surfaced memories are filtered out");
});

test("REQ-SELECT-15", "no candidates left means no call at all", async () => {
  let called = 0;
  const c = conversation(async () => {
    called++;
    return { stopReason: "stop", content: [] } satisfies SelectorResponse;
  });
  c.markSurfaced(ENTRIES.map((e) => e.filePath));
  const r = await c.run("anything at all here");
  assertEqual(r.reason, "all-surfaced");
  assertEqual(called, 0, "the provider must not be called");
});

test("REQ-SELECT-15", "an unseeded conversation makes no call", async () => {
  let called = 0;
  const c = new SelectorConversation(
    async () => {
      called++;
      return { stopReason: "stop", content: [] };
    },
    { maxSelected: 5, timeoutMs: 100 },
  );
  const r = await c.run("some query here");
  assertEqual(r.reason, "no-candidates");
  assertEqual(called, 0);
});

test("REQ-SELECT-14", "a one-token query short-circuits before the call", async () => {
  let called = 0;
  const c = conversation(async () => {
    called++;
    return { stopReason: "stop", content: [] };
  });
  const r = await c.run("tests");
  assertEqual(r.reason, "query-not-selectable");
  assertEqual(called, 0);
});

test("REQ-SELECT-7", "the result is capped at maxSelected", async () => {
  const c = conversation(
    toolCallProvider(["testing-scripts.md", "user-role.md", "terse-replies.md", "no-desc.md"]),
    2,
  );
  const r = await c.run("a query with several words");
  assertEqual(r.selected.length, 2);
});

test(["REQ-SELECT-13", "REQ-FAIL-1"], "a slow provider times out and yields an empty selection", async () => {
  const c = conversation(
    (args) =>
      new Promise((_resolve, reject) => {
        args.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    5,
    20,
  );
  const r = await c.run("this query will hang");
  assertEqual(r.reason, "timeout");
  assertDeepEqual(r.selected, []);
  assertEqual(c.stats.timeouts, 1);
});

test("REQ-FAIL-1", "a throwing provider yields an empty selection", async () => {
  const c = conversation(async () => {
    throw new Error("network down");
  });
  const r = await c.run("a perfectly good query");
  assertEqual(r.reason, "error");
  assertDeepEqual(r.selected, []);
  assertEqual(c.stats.failures, 1);
  assertEqual(c.stats.lastError, "network down");
});

test(["REQ-SELECT-11", "REQ-FAIL-1"], "a truncated response yields an empty selection", async () => {
  const c = conversation(async () => ({
    stopReason: "length",
    content: [{ type: "text", text: '{"selected_memories": ["user-role.md"]}' }],
  }));
  const r = await c.run("a perfectly good query");
  assertEqual(r.reason, "truncated");
  assertDeepEqual(r.selected, []);
  assertEqual(c.stats.truncated, 1);
});

test("REQ-SELECT-16", "a failed call leaves the history untouched", async () => {
  const capture: { last?: CompleteArgs } = {};
  let fail = true;
  const c = conversation(async (args) => {
    capture.last = args;
    if (fail) throw new Error("boom");
    return {
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "1", name: SELECTOR_TOOL_NAME, arguments: { selected_memories: [] } },
      ],
    };
  });
  await c.run("first query that fails");
  assertEqual(c.turnCount, 0, "the failed turn is not recorded");
  fail = false;
  await c.run("second query that works");
  assertEqual(capture.last?.messages.length, 2, "history still holds only the listing plus this query");
});

test("REQ-SELECT-2", "re-seeding replaces the listing but keeps accumulated turns", async () => {
  const capture: { last?: CompleteArgs } = {};
  const c = conversation(toolCallProvider([], capture));
  await c.run("a first query here");
  c.seed([...ENTRIES, entry("added.md", "a new memory", "reference")]);
  await c.run("a second query here");
  const args = capture.last;
  assert(args !== undefined, "provider called");
  assertEqual(args.messages.length, 4, "listing + one recorded turn + the new query");
  assertIncludes((args.messages[0].content[0] as { text: string }).text, "added.md");
});

test("REQ-SELECT-1", "dry-run style access to the listing and raw answer", async () => {
  const c = conversation(toolCallProvider(["user-role.md"]));
  const r = await c.run("tell me about the user");
  assertEqual(r.reason, "ok");
  assertIncludes(r.listing, "- [user] user-role.md");
  assertIncludes(r.answerText ?? "", "user-role.md");
  assert(typeof r.latencyMs === "number", "latency is measured");
});

// --- budget ----------------------------------------------------------------

test("REQ-LIMIT-1", "the session budget latches once consumed bytes reach the cap", () => {
  const b = new SessionBudget(100);
  assertEqual(b.exhausted, false);
  b.add(60);
  assertEqual(b.exhausted, false);
  b.add(40);
  assertEqual(b.exhausted, true, "at the cap, not merely above it");
  assertEqual(b.bytes, 100);
  b.reset();
  assertEqual(b.exhausted, false);
});

test("REQ-LIMIT-6", "budget accounting is over UTF-8 bytes", () => {
  const b = new SessionBudget(10);
  b.add(Buffer.byteLength("héllo", "utf8"));
  assertEqual(b.bytes, 6, "é is two bytes in UTF-8, not one UTF-16 unit");
});
