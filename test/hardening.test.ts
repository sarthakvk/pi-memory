/**
 * M4 — hardening. Limit enforcement, degenerate inputs, telemetry counters,
 * and the "no scope root" path.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { DEFAULTS } from "../extension/config.ts";
import { scanAll, scanDir } from "../extension/scan.ts";
import { truncateWithWarning } from "../extension/inject.ts";
import {
  attachSelector,
  buildInjection,
  initSession,
  NO_SELECTION,
  renderBudget,
  rescan,
  runTurn,
  type SessionState,
} from "../extension/runtime.ts";
import { SELECTOR_TOOL_NAME, type CompleteFn } from "../extension/selector.ts";

function session(config: Record<string, unknown>, cwd: string): SessionState {
  const configDir = makeTempDir("pi-memory-h-cfg-");
  writeFileSync(join(configDir, "memory-config.json"), JSON.stringify(config), "utf8");
  const s = initSession(cwd, configDir);
  assert(s !== undefined, "session should initialise");
  return s;
}

function provider(names: string[]): CompleteFn {
  return async () => ({
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "1", name: SELECTOR_TOOL_NAME, arguments: { selected_memories: names } },
    ],
  });
}

// --- limits -----------------------------------------------------------------

test("REQ-LIMIT-2", "the scan cap holds and keeps the newest files", () => {
  const root = makeTempDir();
  for (let i = 0; i < 40; i++) {
    writeMemory(root, `m${String(i).padStart(2, "0")}.md`, { description: `m${i}`, ageDays: i });
  }
  const { files, dropped } = scanAll([{ root, scope: "private" }], { ...DEFAULTS, maxFiles: 10 });
  assertEqual(files.length, 10);
  assertEqual(dropped, 30);
  assertEqual(files[0].filename, "m00.md", "newest first");
  assertEqual(files[9].filename, "m09.md");
});

test("REQ-LIMIT-2", "the cap is enforced across both scopes together", () => {
  const priv = makeTempDir();
  const proj = makeTempDir();
  for (let i = 0; i < 6; i++) writeMemory(priv, `p${i}.md`, { description: `p${i}`, ageDays: i * 2 });
  for (let i = 0; i < 6; i++) writeMemory(proj, `t${i}.md`, { description: `t${i}`, ageDays: i * 2 + 1 });
  const { files, dropped } = scanAll(
    [
      { root: priv, scope: "private" },
      { root: proj, scope: "project" },
    ],
    { ...DEFAULTS, maxFiles: 4 },
  );
  assertEqual(files.length, 4);
  assertEqual(dropped, 8);
  assertDeepEqual(files.map((f) => f.filename), ["p0.md", "team/t0.md", "p1.md", "team/t1.md"]);
});

test("REQ-LIMIT-2", "a maxFiles of zero surfaces nothing but does not throw", () => {
  const root = makeTempDir();
  writeMemory(root, "a.md", { description: "a" });
  const { files, dropped } = scanAll([{ root, scope: "private" }], { ...DEFAULTS, maxFiles: 0 });
  assertEqual(files.length, 0);
  assertEqual(dropped, 1);
});

// --- no scope root ----------------------------------------------------------

test("REQ-INJECT-10", "with no scope root on disk nothing at all is injected", () => {
  const base = makeTempDir();
  const s = session({ dir: join(base, "created"), projectDir: "" }, makeTempDir());
  // initSession creates the configured dir, so point at one that was never made.
  const gone = join(base, "never", "created");
  assertEqual(existsSync(gone), false, "the fixture path must genuinely not exist");
  const s2: SessionState = { ...s, dirs: { ...s.dirs, privateDir: gone }, teamDir: undefined };
  s2.files = [];
  const out = buildInjection(s2, "BASE PROMPT ONLY", NO_SELECTION);
  assertEqual(out.prompt, "BASE PROMPT ONLY", "the system prompt is returned untouched");
  assertEqual(s2.counters.turnsWithNoScope, 1);
});

test("REQ-INJECT-10", "a turn with no scope root leaves the prompt byte-identical", async () => {
  const missing = join(makeTempDir(), "gone");
  const s = session({ dir: missing, projectDir: "" }, makeTempDir());
  s.dirs = { ...s.dirs, privateDir: join(missing, "deeper", "still-gone") };
  s.teamDir = undefined;
  const out = await runTurn(s, "SYSTEM", "a query with several words");
  assertEqual(out, "SYSTEM");
});

test("REQ-INJECT-11", "the private memory dir is created, the project dir never is", () => {
  const home = makeTempDir();
  const privateDir = join(home, "agent", "memory");
  const cwd = makeTempDir();
  assertEqual(existsSync(privateDir), false);

  const s = session({ dir: privateDir, projectDir: ".pi/memory" }, cwd);
  assertEqual(existsSync(privateDir), true, "the private dir is created on session start");
  assertEqual(existsSync(join(cwd, ".pi", "memory")), false, "the project dir is never created");
  assertEqual(s.teamDir, undefined);
});

// --- degenerate inputs ------------------------------------------------------

test("REQ-SCAN-8", "an empty file, a frontmatter-only file and a bare delimiter all scan", () => {
  const root = makeTempDir();
  writeFile(join(root, "empty.md"), "");
  writeFile(join(root, "fmonly.md"), "---\nname: fmonly\ndescription: only frontmatter\n---\n");
  writeFile(join(root, "dashes.md"), "---\n");
  const files = scanDir(root, "private", DEFAULTS);
  assertEqual(files.length, 3);
  const byName = new Map(files.map((f) => [f.filename, f]));
  assertEqual(byName.get("empty.md")?.description, null);
  assertEqual(byName.get("fmonly.md")?.description, "only frontmatter");
  assertEqual(byName.get("dashes.md")?.description, "---", "an unterminated block is just body text");
});

test("REQ-SCAN-8", "CRLF line endings parse", () => {
  const root = makeTempDir();
  writeFile(
    join(root, "crlf.md"),
    "---\r\nname: crlf\r\ndescription: windows line endings\r\nmetadata:\r\n  type: user\r\n  pinned: true\r\n---\r\n\r\nbody\r\n",
  );
  const [f] = scanDir(root, "private", DEFAULTS);
  assertEqual(f.name, "crlf");
  assertEqual(f.description, "windows line endings");
  assertEqual(f.type, "user");
  assertEqual(f.pinnedState, "true");
});

test("REQ-SCAN-1", "a deeply nested memory is still found", () => {
  const root = makeTempDir();
  writeMemory(root, join("a", "b", "c", "d", "e", "deep.md"), { description: "deep one" });
  const files = scanDir(root, "private", DEFAULTS);
  assertEqual(files.length, 1);
  assertEqual(files[0].filename, "a/b/c/d/e/deep.md");
});

test("REQ-FAIL-3", "a scope root that is a file, not a directory, is tolerated", () => {
  const parent = makeTempDir();
  const notADir = join(parent, "memory");
  writeFileSync(notADir, "I am a file", "utf8");
  const { files } = scanAll([{ root: notADir, scope: "private" }], DEFAULTS);
  assertDeepEqual(files, []);
});

test("REQ-INJECT-7", "an index of exactly the limit is not truncated", () => {
  const text = Array.from({ length: 200 }, (_, i) => `- [E${i}](e${i}.md)`).join("\n");
  const r = truncateWithWarning(text, "index", 200, 25000);
  assertEqual(r.wasLineTruncated, false);
  assertNotIncludes(r.content, "> WARNING:");
});

test("REQ-INJECT-7", "an index one line over the limit truncates", () => {
  const text = Array.from({ length: 201 }, (_, i) => `- [E${i}](e${i}.md)`).join("\n");
  const r = truncateWithWarning(text, "index", 200, 25000);
  assertEqual(r.wasLineTruncated, true);
  assertIncludes(r.content, "201 lines (limit: 200)");
});

test("REQ-LIMIT-6", "multi-byte content is truncated on a code-point boundary", () => {
  const r = truncateWithWarning("héllo wörld ".repeat(50), "file", 1000, 20);
  assertEqual(r.wasByteTruncated, true);
  // Round-tripping proves no lone surrogate or split sequence survived.
  assertEqual(Buffer.from(r.content, "utf8").toString("utf8"), r.content);
  assertNotIncludes(r.content, "�");
});

// --- telemetry --------------------------------------------------------------

test("REQ-CMD-4", "counters accumulate across turns and appear in /memory budget", async () => {
  const privateDir = join(makeTempDir(), "memory");
  const s = session({ dir: privateDir, projectDir: "", maxSessionBytes: 100000 }, makeTempDir());
  writeMemory(privateDir, "pin.md", { name: "pin", description: "pinned", pinned: true, body: "P BODY" });
  writeMemory(privateDir, "a.md", { name: "a", description: "alpha memory", body: "A BODY" });
  writeMemory(privateDir, "b.md", { name: "b", description: "beta memory", body: "B BODY" });
  rescan(s);
  attachSelector(s, provider(["a.md"]));

  await runTurn(s, "BASE", "a first query with words");
  await runTurn(s, "BASE", "a second query with words");

  assertEqual(s.counters.turns, 2);
  assert(s.counters.scans >= 3, `expected at least 3 scans, got ${s.counters.scans}`);
  assertEqual(s.counters.filesScanned, 3);
  assertEqual(s.counters.pinnedInjected, 2, "one pinned memory injected on each of two turns");
  assertEqual(s.counters.surfacedMemories, 1, "a.md surfaces once, then is deduped");
  assert(s.counters.surfacedBytes > 0, "surfaced bytes were counted");

  const text = renderBudget(s).join("\n");
  assertIncludes(text, "Counters: turns 2");
  assertIncludes(text, "pinned 2, surfaced 1");
  assertIncludes(text, "Selector calls: 2");
});

test("REQ-CMD-4", "counters report files dropped by the cap", () => {
  const privateDir = join(makeTempDir(), "memory");
  const s = session({ dir: privateDir, projectDir: "", maxFiles: 2 }, makeTempDir());
  for (let i = 0; i < 5; i++) writeMemory(privateDir, `m${i}.md`, { description: `m${i}`, ageDays: i });
  rescan(s);
  assertEqual(s.counters.filesScanned, 2);
  assertEqual(s.counters.filesDropped, 3);
  assertIncludes(renderBudget(s).join("\n"), "files 2 (+3 dropped)");
});

test("REQ-CMD-4", "a turn with no scope root is counted", async () => {
  const s = session({ dir: join(makeTempDir(), "x"), projectDir: "" }, makeTempDir());
  s.dirs = { ...s.dirs, privateDir: join(makeTempDir(), "definitely-not-here") };
  s.teamDir = undefined;
  await runTurn(s, "SYSTEM", "a query with several words");
  assertEqual(s.counters.turnsWithNoScope, 1);
  assertIncludes(renderBudget(s).join("\n"), "1 turns with no scope root");
});

// --- ordering stability -----------------------------------------------------

test("REQ-INJECT-1", "section order is policy, index, pinned, surfaced", async () => {
  const privateDir = join(makeTempDir(), "memory");
  const s = session({ dir: privateDir, projectDir: "" }, makeTempDir());
  mkdirSync(privateDir, { recursive: true });
  writeFile(join(privateDir, "MEMORY.md"), "- [A](a.md) — alpha");
  writeMemory(privateDir, "pin.md", { name: "pin", description: "pinned", pinned: true, body: "P BODY" });
  writeMemory(privateDir, "a.md", { name: "a", description: "alpha memory", body: "A BODY" });
  rescan(s);
  attachSelector(s, provider(["a.md"]));

  const out = (await runTurn(s, "BASE", "a query with several words")) ?? "";
  const iPolicy = out.indexOf("# Memory");
  const iIndex = out.indexOf("## MEMORY.md");
  const iPinned = out.indexOf("# Pinned memories");
  const iSurfaced = out.indexOf("Memory: ");
  assert(iPolicy >= 0 && iIndex > iPolicy, "index follows policy");
  assert(iPinned > iIndex, "pinned follows index");
  assert(iSurfaced > iPinned, "surfaced follows pinned");
});
