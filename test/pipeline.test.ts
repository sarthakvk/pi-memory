/**
 * Whole-pipeline tests: temp memory dirs -> scan -> select (mocked provider)
 * -> injected system prompt. This is the closest headless equivalent of the
 * interactive `/system-prompt` check in pi.
 */

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  assert,
  assertDeepEqual,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  makeTempDir,
  test,
  writeFile,
  writeMemory,
} from "./harness.ts";
import {
  attachSelector,
  buildInjection,
  initSession,
  NO_SELECTION,
  renderBudget,
  renderDoctor,
  renderDryRun,
  renderList,
  renderWhy,
  rescan,
  runTurn,
  type SessionState,
} from "../extension/runtime.ts";
import { SELECTOR_TOOL_NAME, type CompleteFn } from "../extension/selector.ts";
import { buildPolicyPrompt } from "../extension/prompts.ts";

interface Fixture {
  state: SessionState;
  privateDir: string;
  projectDir: string;
  configDir: string;
}

/** Build a session over fresh temp dirs with an explicit config. */
function fixture(config: Record<string, unknown> = {}, opts: { withProject?: boolean } = {}): Fixture {
  const configDir = makeTempDir("pi-memory-cfg-");
  const privateDir = join(makeTempDir("pi-memory-priv-"), "memory");
  const projectRoot = makeTempDir("pi-memory-proj-");
  const projectDir = join(projectRoot, ".pi", "memory");
  if (opts.withProject !== false) writeFile(join(projectDir, ".keep"), "");

  writeFileSync(
    join(configDir, "memory-config.json"),
    JSON.stringify({ dir: privateDir, projectDir: ".pi/memory", ...config }),
    "utf8",
  );

  const state = initSession(projectRoot, configDir);
  assert(state !== undefined, "session should initialise");
  return { state, privateDir, projectDir, configDir };
}

/** Mock provider returning a fixed selection. */
function provider(names: string[]): CompleteFn {
  return async () => ({
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "1", name: SELECTOR_TOOL_NAME, arguments: { selected_memories: names } },
    ],
  });
}

// ---------------------------------------------------------------------------

test("single-scope policy preserves the private-only location sentence", () => {
  const prompt = buildPolicyPrompt({
    privateDir: "/private",
    indexMaxLines: 200,
    maxPinned: 8,
  });
  assertIncludes(
    prompt,
    "You have a persistent, file-based memory system at `/private`. This directory already exists",
  );
  assertNotIncludes(prompt, "at `/private` (private to this user)");
});

test("policy preserves dollar sequences in runtime values", () => {
  const prompt = buildPolicyPrompt({
    privateDir: "/tmp/$&/private",
    teamDir: "/tmp/$`/team",
    indexMaxLines: 200,
    maxPinned: 8,
    displayName: "Memory $' title",
  });
  assertIncludes(prompt, "# Memory $' title");
  assertIncludes(prompt, "at `/tmp/$&/private` (private to this user) and `/tmp/$`/team`");
  assertNotIncludes(prompt, "__DISPLAY_NAME__");
  assertNotIncludes(prompt, "__PRIVATE_DIR__");
  assertNotIncludes(prompt, "__TEAM_DIR__");
});

test("a turn injects policy, index and pinned block", async () => {
  const f = fixture();
  writeFile(join(f.privateDir, "MEMORY.md"), "- [Testing](testing.md) — how to run tests\n");
  writeMemory(f.privateDir, "testing.md", {
    name: "testing",
    description: "how to run this project's tests",
    type: "project",
    body: "Run `bun test`.",
  });
  writeMemory(f.privateDir, "always.md", {
    name: "always",
    description: "always applies",
    type: "feedback",
    pinned: true,
    body: "Never force-push to main.",
  });

  const out = await runTurn(f.state, "BASE PROMPT", "how do I run the tests");
  assert(out !== undefined, "the handler returned a prompt");
  assert(out.startsWith("BASE PROMPT\n\n"), "the incoming prompt is preserved verbatim at the front");
  assertIncludes(out, "# Memory");
  assertIncludes(out, "## MEMORY.md");
  assertIncludes(out, "- [Testing](testing.md) — how to run tests");
  assertIncludes(out, "# Pinned memories (apply to every conversation)");
  assertIncludes(out, "Never force-push to main.");
  // Tier 2 is off in this fixture (no selector attached), so the unpinned body
  // must not appear — only its index line.
  assertNotIncludes(out, "Run `bun test`.");
});

test("enabled: false yields no session at all", () => {
  const configDir = makeTempDir();
  writeFileSync(join(configDir, "memory-config.json"), JSON.stringify({ enabled: false }), "utf8");
  assertEqual(initSession(process.cwd(), configDir), undefined);
});

test("a project dir that does not exist is skipped", () => {
  const f = fixture({}, { withProject: false });
  assertEqual(f.state.teamDir, undefined);
  const out = buildInjection(f.state, "BASE", NO_SELECTION).prompt;
  assertNotIncludes(out, "shared with all users of this project");
  assertIncludes(out, "You have a persistent, file-based memory system at ");
});

test("both scopes are scanned and the team scope is namespaced", () => {
  const f = fixture();
  writeMemory(f.privateDir, "p.md", { description: "private one" });
  writeMemory(f.projectDir, "t.md", { description: "team one" });
  rescan(f.state);
  assertDeepEqual(f.state.files.map((x) => x.filename).sort(), ["p.md", "team/t.md"]);
});

test("a selected memory's body reaches the prompt", async () => {
  const f = fixture();
  writeMemory(f.privateDir, "testing.md", {
    name: "testing",
    description: "how to run this project's tests",
    type: "project",
    body: "Run `bun test` from the repo root.",
  });
  writeMemory(f.privateDir, "unrelated.md", {
    name: "unrelated",
    description: "the office coffee machine",
    type: "reference",
    body: "SHOULD NOT APPEAR",
  });
  rescan(f.state);
  attachSelector(f.state, provider(["testing.md"]));

  const out = await runTurn(f.state, "BASE", "how do I run the tests");
  assert(out !== undefined, "prompt returned");
  assertIncludes(out, "Run `bun test` from the repo root.");
  assertNotIncludes(out, "SHOULD NOT APPEAR");
  assertIncludes(out, `Memory: ${join(f.privateDir, "testing.md")}:`);
  assertDeepEqual(f.state.lastTurn?.selected, ["testing.md"]);
  assertEqual(f.state.lastTurn?.selectorReason, "ok");
});

test("a memory surfaced on turn 1 is not re-injected on turn 2", async () => {
  const f = fixture();
  writeMemory(f.privateDir, "testing.md", {
    name: "testing",
    description: "how to run tests",
    type: "project",
    body: "Run `bun test`.",
  });
  rescan(f.state);
  attachSelector(f.state, provider(["testing.md"]));

  const first = await runTurn(f.state, "BASE", "how do I run the tests");
  assertIncludes(first ?? "", "Run `bun test`.");

  const second = await runTurn(f.state, "BASE", "remind me how tests work");
  assertNotIncludes(second ?? "", "Memory: ");
  assertDeepEqual(f.state.lastTurn?.selected, []);
});

test("once the budget is spent recall stops but pinning continues", async () => {
  const f = fixture({ maxSessionBytes: 64 });
  writeMemory(f.privateDir, "big.md", {
    name: "big",
    description: "a large memory",
    type: "project",
    body: "x".repeat(400),
  });
  writeMemory(f.privateDir, "other.md", {
    name: "other",
    description: "another memory",
    type: "project",
    body: "SECOND BODY",
  });
  writeMemory(f.privateDir, "pin.md", {
    name: "pin",
    description: "pinned",
    type: "feedback",
    pinned: true,
    body: "PINNED BODY",
  });
  rescan(f.state);
  attachSelector(f.state, provider(["big.md", "other.md"]));

  const first = await runTurn(f.state, "BASE", "give me the large memory");
  assertIncludes(first ?? "", "PINNED BODY");
  assert(f.state.budget.exhausted, `budget should be spent, got ${f.state.budget.bytes}B`);

  const second = await runTurn(f.state, "BASE", "and now something else entirely");
  assertEqual(f.state.lastTurn?.selectorReason, "budget-exhausted");
  assertDeepEqual(f.state.lastTurn?.selected, []);
  assertIncludes(second ?? "", "PINNED BODY", "pinned injection is unaffected by the budget");
  assertIncludes(second ?? "", "# Pinned memories (apply to every conversation)");
});

test("selector.enabled false keeps tiers 1 and 3 and never calls the provider", async () => {
  const f = fixture({ selector: { enabled: false } });
  let calls = 0;
  writeMemory(f.privateDir, "pin.md", { description: "pinned", pinned: true, body: "PINNED BODY" });
  writeMemory(f.privateDir, "other.md", { description: "other", body: "OTHER BODY" });
  rescan(f.state);
  attachSelector(f.state, async () => {
    calls++;
    return { stopReason: "stop", content: [] };
  });

  const out = await runTurn(f.state, "BASE", "a query with several words");
  assertEqual(calls, 0, "the provider must not be called");
  assertIncludes(out ?? "", "PINNED BODY");
  assertNotIncludes(out ?? "", "OTHER BODY");
  assertEqual(f.state.lastTurn?.selectorReason, "disabled");
});

test("a failing selector still yields a complete, valid prompt", async () => {
  const f = fixture();
  writeMemory(f.privateDir, "pin.md", { description: "pinned", pinned: true, body: "PINNED BODY" });
  rescan(f.state);
  attachSelector(f.state, async () => {
    throw new Error("provider exploded");
  });

  const out = await runTurn(f.state, "BASE", "a query with several words");
  assert(out !== undefined, "the turn still produced a prompt");
  assertIncludes(out, "BASE");
  assertIncludes(out, "PINNED BODY");
  assertEqual(f.state.lastTurn?.selectorReason, "error");
});

test("a disabled selector model latches off for the session", async () => {
  const f = fixture();
  writeMemory(f.privateDir, "a.md", { description: "a memory", body: "A BODY" });
  rescan(f.state);
  f.state.selectorDisabledReason = 'selector model "bogus/model" not found in the model registry';
  attachSelector(f.state, async () => {
    throw new Error("must not be called");
  });

  const out = await runTurn(f.state, "BASE", "a query with several words");
  assert(out !== undefined, "prompt returned");
  assertEqual(f.state.lastTurn?.selectorReason, "disabled");
  assertIncludes(renderBudget(f.state).join("\n"), "Selector disabled: selector model");
});

test("a malformed memory file does not break a turn", async () => {
  const f = fixture();
  writeFile(join(f.privateDir, "broken.md"), "---\n:: not : yaml [\n---\nBROKEN BODY\n");
  writeMemory(f.privateDir, "fine.md", { description: "fine", pinned: true, body: "FINE BODY" });
  rescan(f.state);

  const out = await runTurn(f.state, "BASE", "a query with several words");
  assert(out !== undefined, "the turn survived the malformed file");
  assertIncludes(out, "FINE BODY");
  assertEqual(f.state.files.length, 2);
});

test("an oversized index truncates inside a real turn", async () => {
  const f = fixture({ indexMaxLines: 5 });
  writeFile(
    join(f.privateDir, "MEMORY.md"),
    Array.from({ length: 20 }, (_, i) => `- [E${i}](e${i}.md) — hook`).join("\n"),
  );
  const out = await runTurn(f.state, "BASE", "a query with several words");
  assertIncludes(out ?? "", "> WARNING: MEMORY.md is 20 lines (limit: 5).");
  assertIncludes(out ?? "", "- [E4](e4.md) — hook");
  assertNotIncludes(out ?? "", "- [E5](e5.md) — hook");
  assertEqual(f.state.lastTurn?.indexTruncated, true);
});

// --- commands ---------------------------------------------------------------

test("/memory list reports scope, type, pinned state and description", () => {
  const f = fixture();
  writeMemory(f.privateDir, "a.md", { description: "alpha memory", type: "user", pinned: true });
  writeMemory(f.projectDir, "b.md", { description: "beta memory", type: "project" });
  writeMemory(f.privateDir, "c.md", { name: "c", body: "" });
  rescan(f.state);

  const text = renderList(f.state).join("\n");
  assertIncludes(text, "[user] a.md [pinned]");
  assertIncludes(text, "alpha memory");
  assertIncludes(text, "[project] team/b.md");
  assertIncludes(text, "(no description — invisible to the selector)");
  assertIncludes(text, "total ");
});

test("/memory why reports the last turn", async () => {
  const f = fixture();
  assertIncludes(renderWhy(f.state).join("\n"), "No turn has been injected yet");
  writeMemory(f.privateDir, "pin.md", { description: "pinned", pinned: true, body: "P" });
  rescan(f.state);
  attachSelector(f.state, provider([]));
  await runTurn(f.state, "BASE", "a query with several words");
  const text = renderWhy(f.state).join("\n");
  assertIncludes(text, "pinned:   pin.md");
  assertIncludes(text, "selector: ok");
});

test("/memory budget reports the budget and selector counters", async () => {
  const f = fixture({ maxSessionBytes: 1000 });
  writeMemory(f.privateDir, "a.md", { description: "alpha", body: "A BODY" });
  rescan(f.state);
  attachSelector(f.state, provider(["a.md"]));
  await runTurn(f.state, "BASE", "a query with several words");

  const text = renderBudget(f.state).join("\n");
  assertIncludes(text, "/ 1000B");
  assertIncludes(text, "Pinned injection is unaffected by the budget.");
  assertIncludes(text, "Selector calls: 1, failures 0, timeouts 0");
});

test("/memory dry-run selects the right file and rejects an unrelated one", async () => {
  const f = fixture();
  writeMemory(f.privateDir, "testing.md", {
    description: "how to run this project's tests",
    type: "project",
    body: "bun test",
  });
  writeMemory(f.privateDir, "coffee.md", {
    description: "the office coffee machine",
    type: "reference",
    body: "grind fine",
  });
  rescan(f.state);
  attachSelector(f.state, provider(["testing.md", "hallucinated.md"]));

  const text = (await renderDryRun(f.state, "how do I run the tests")).join("\n");
  assertIncludes(text, "verdict:  ok");
  assertIncludes(text, "selected: testing.md");
  assertNotIncludes(text, "coffee.md\n", "the unrelated file is not selected");
  assertNotIncludes(text, "selected: testing.md, hallucinated.md");
  assertIncludes(text, "listing sent:");
  assertIncludes(text, "- [project] testing.md");
});

test("/memory dry-run without a query prints usage", async () => {
  const f = fixture();
  assertIncludes((await renderDryRun(f.state, "  ")).join("\n"), "usage: /memory dry-run <query>");
});

test("/memory dry-run does not spend the session budget", async () => {
  const f = fixture();
  writeMemory(f.privateDir, "a.md", { description: "alpha", body: "A BODY" });
  rescan(f.state);
  attachSelector(f.state, provider(["a.md"]));
  await renderDryRun(f.state, "a query with several words");
  assertEqual(f.state.budget.bytes, 0, "dry-run never surfaces, so it never charges the budget");
});

// --- pinned / index double injection ------------------------------------------

test("a pinned memory kept out of the index appears exactly once", async () => {
  const f = fixture();
  writeMemory(f.privateDir, "always.md", {
    name: "always",
    description: "never force-push to main",
    type: "feedback",
    pinned: true,
    body: "Never force-push to main.",
  });
  writeMemory(f.privateDir, "testing.md", {
    name: "testing",
    description: "how to run tests",
    type: "project",
    body: "Run `bun test`.",
  });
  // Correct index per : the pinned memory is absent.
  writeFile(join(f.privateDir, "MEMORY.md"), "- [Testing](testing.md) — bun test\n");

  const out = (await runTurn(f.state, "BASE", "how do I run the tests")) ?? "";
  assertIncludes(out, "Never force-push to main.");
  assertEqual(
    out.split("always.md").length - 1,
    1,
    "the pinned file is named exactly once — the <pinned-memory> path attribute, with no index pointer",
  );
  assertIncludes(out, "- [Testing](testing.md) — bun test");
});

test("the redundancy this rule removes is real when the rule is broken", async () => {
  const f = fixture();
  writeMemory(f.privateDir, "always.md", {
    name: "always",
    description: "never force-push to main",
    type: "feedback",
    pinned: true,
    body: "Never force-push to main.",
  });
  // The state  forbids: pinned AND indexed.
  writeFile(join(f.privateDir, "MEMORY.md"), "- [Always](always.md) — never force-push\n");

  const out = (await runTurn(f.state, "BASE", "a query with several words")) ?? "";
  assert(
    out.split("always.md").length - 1 >= 2,
    "without the rule the file is named twice: once inline, once as an index pointer",
  );
  // And doctor is what surfaces it.
  assertIncludes(renderDoctor(f.state).join("\n"), "[pinned-and-indexed] always.md");
});
