/**
 * M4 — hardening. Limit enforcement, degenerate inputs, telemetry counters,
 * and the "no scope root" path.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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

test("the scan cap holds and keeps the newest files", () => {
  const root = makeTempDir();
  for (let i = 0; i < 40; i++) {
    writeMemory(root, `m${String(i).padStart(2, "0")}.md`, { description: `m${i}`, ageDays: i });
  }
  const { files, dropped } = scanAll([{ root, scope: "user" }], { ...DEFAULTS, maxFiles: 10 });
  assertEqual(files.length, 10);
  assertEqual(dropped, 30);
  assertEqual(files[0].filename, "m00.md", "newest first");
  assertEqual(files[9].filename, "m09.md");
});

test("the cap is enforced across both scopes together", () => {
  const priv = makeTempDir();
  const proj = makeTempDir();
  for (let i = 0; i < 6; i++) writeMemory(priv, `p${i}.md`, { description: `p${i}`, ageDays: i * 2 });
  for (let i = 0; i < 6; i++) writeMemory(proj, `t${i}.md`, { description: `t${i}`, ageDays: i * 2 + 1 });
  const { files, dropped } = scanAll(
    [
      { root: priv, scope: "user" },
      { root: proj, scope: "project" },
    ],
    { ...DEFAULTS, maxFiles: 4 },
  );
  assertEqual(files.length, 4);
  assertEqual(dropped, 8);
  assertDeepEqual(files.map((f) => f.filename), [
    "p0.md",
    "project/t0.md",
    "p1.md",
    "project/t1.md",
  ]);
});

test("a maxFiles of zero surfaces nothing but does not throw", () => {
  const root = makeTempDir();
  writeMemory(root, "a.md", { description: "a" });
  const { files, dropped } = scanAll([{ root, scope: "user" }], { ...DEFAULTS, maxFiles: 0 });
  assertEqual(files.length, 0);
  assertEqual(dropped, 1);
});

// --- no scope root ----------------------------------------------------------

test("with no scope root on disk nothing at all is injected", () => {
  const base = makeTempDir();
  const s = session({ dir: join(base, "created"), projectMemoryRoot: "" }, makeTempDir());
  // initSession creates the configured dir, so point at one that was never made.
  const gone = join(base, "never", "created");
  assertEqual(existsSync(gone), false, "the fixture path must genuinely not exist");
  const s2: SessionState = { ...s, dirs: { ...s.dirs, userDir: gone, projectDir: undefined } };
  s2.files = [];
  const out = buildInjection(s2, "BASE PROMPT ONLY", NO_SELECTION);
  assertEqual(out.prompt, "BASE PROMPT ONLY", "the system prompt is returned untouched");
  assertEqual(s2.counters.turnsWithNoScope, 1);
});

test("a turn with no scope root leaves the prompt byte-identical", async () => {
  const missing = join(makeTempDir(), "gone");
  const s = session({ dir: missing, projectMemoryRoot: "" }, makeTempDir());
  s.dirs = { ...s.dirs, userDir: join(missing, "deeper", "still-gone") };
  const out = await runTurn(s, "SYSTEM", "a query with several words");
  assertEqual(out, "SYSTEM");
});

test("both memory dirs are created on session start, and nothing lands in the project", () => {
  const home = makeTempDir();
  const userDir = join(home, "agent", "memory");
  const projectMemoryRoot = join(home, "agent", "project-memory");
  const cwd = makeTempDir();
  assertEqual(existsSync(userDir), false);

  const s = session({ dir: userDir, projectMemoryRoot }, cwd);
  assertEqual(existsSync(userDir), true, "the user dir is created on session start");
  assert(s.dirs.projectDir !== undefined, "the project scope is live");
  assertEqual(existsSync(s.dirs.projectDir), true, "the project dir is created too");
  assert(
    s.dirs.projectDir.startsWith(projectMemoryRoot),
    "project memory lives under the agent dir, never inside the project",
  );
  assertDeepEqual(readdirSync(cwd), [], "nothing at all is written into the project directory");
});

test("the same project reached from a subdirectory resolves to one memory dir", () => {
  const home = makeTempDir();
  const repo = makeTempDir("pi-memory-hrepo-");
  mkdirSync(join(repo, ".git"));
  const nested = join(repo, "packages", "web");
  mkdirSync(nested, { recursive: true });
  const config = {
    dir: join(home, "memory"),
    projectMemoryRoot: join(home, "project-memory"),
  };
  assertEqual(session(config, repo).dirs.projectDir, session(config, nested).dirs.projectDir);
});

// --- degenerate inputs ------------------------------------------------------

test("an empty file, a frontmatter-only file and a bare delimiter all scan", () => {
  const root = makeTempDir();
  writeFile(join(root, "empty.md"), "");
  writeFile(join(root, "fmonly.md"), "---\nname: fmonly\ndescription: only frontmatter\n---\n");
  writeFile(join(root, "dashes.md"), "---\n");
  const files = scanDir(root, "user", DEFAULTS);
  assertEqual(files.length, 3);
  const byName = new Map(files.map((f) => [f.filename, f]));
  assertEqual(byName.get("empty.md")?.description, null);
  assertEqual(byName.get("fmonly.md")?.description, "only frontmatter");
  assertEqual(byName.get("dashes.md")?.description, "---", "an unterminated block is just body text");
});

test("CRLF line endings parse", () => {
  const root = makeTempDir();
  writeFile(
    join(root, "crlf.md"),
    "---\r\nname: crlf\r\ndescription: windows line endings\r\nmetadata:\r\n  type: user\r\n  pinned: true\r\n---\r\n\r\nbody\r\n",
  );
  const [f] = scanDir(root, "user", DEFAULTS);
  assertEqual(f.name, "crlf");
  assertEqual(f.description, "windows line endings");
  assertEqual(f.type, "user");
  assertEqual(f.pinnedState, "true");
});

test("a deeply nested memory is still found", () => {
  const root = makeTempDir();
  writeMemory(root, join("a", "b", "c", "d", "e", "deep.md"), { description: "deep one" });
  const files = scanDir(root, "user", DEFAULTS);
  assertEqual(files.length, 1);
  assertEqual(files[0].filename, "a/b/c/d/e/deep.md");
});

test("a scope root that is a file, not a directory, is tolerated", () => {
  const parent = makeTempDir();
  const notADir = join(parent, "memory");
  writeFileSync(notADir, "I am a file", "utf8");
  const { files } = scanAll([{ root: notADir, scope: "user" }], DEFAULTS);
  assertDeepEqual(files, []);
});

test("an index of exactly the limit is not truncated", () => {
  const text = Array.from({ length: 200 }, (_, i) => `- [E${i}](e${i}.md)`).join("\n");
  const r = truncateWithWarning(text, "index", 200, 25000);
  assertEqual(r.wasLineTruncated, false);
  assertNotIncludes(r.content, "> WARNING:");
});

test("an index one line over the limit truncates", () => {
  const text = Array.from({ length: 201 }, (_, i) => `- [E${i}](e${i}.md)`).join("\n");
  const r = truncateWithWarning(text, "index", 200, 25000);
  assertEqual(r.wasLineTruncated, true);
  assertIncludes(r.content, "201 lines (limit: 200)");
});

test("multi-byte content is truncated on a code-point boundary", () => {
  const r = truncateWithWarning("héllo wörld ".repeat(50), "file", 1000, 20);
  assertEqual(r.wasByteTruncated, true);
  // Round-tripping proves no lone surrogate or split sequence survived.
  assertEqual(Buffer.from(r.content, "utf8").toString("utf8"), r.content);
  assertNotIncludes(r.content, "�");
});

// --- telemetry --------------------------------------------------------------

test("counters accumulate across turns and appear in /memory budget", async () => {
  const userDir = join(makeTempDir(), "memory");
  const s = session({ dir: userDir, projectMemoryRoot: "", maxSessionBytes: 100000 }, makeTempDir());
  writeMemory(userDir, "pin.md", { name: "pin", description: "pinned", pinned: true, body: "P BODY" });
  writeMemory(userDir, "a.md", { name: "a", description: "alpha memory", body: "A BODY" });
  writeMemory(userDir, "b.md", { name: "b", description: "beta memory", body: "B BODY" });
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

test("counters report files dropped by the cap", () => {
  const userDir = join(makeTempDir(), "memory");
  const s = session({ dir: userDir, projectMemoryRoot: "", maxFiles: 2 }, makeTempDir());
  for (let i = 0; i < 5; i++) writeMemory(userDir, `m${i}.md`, { description: `m${i}`, ageDays: i });
  rescan(s);
  assertEqual(s.counters.filesScanned, 2);
  assertEqual(s.counters.filesDropped, 3);
  assertIncludes(renderBudget(s).join("\n"), "files 2 (+3 dropped)");
});

test("a turn with no scope root is counted", async () => {
  const s = session({ dir: join(makeTempDir(), "x"), projectMemoryRoot: "" }, makeTempDir());
  s.dirs = { ...s.dirs, userDir: join(makeTempDir(), "definitely-not-here") };
  await runTurn(s, "SYSTEM", "a query with several words");
  assertEqual(s.counters.turnsWithNoScope, 1);
  assertIncludes(renderBudget(s).join("\n"), "1 turns with no scope root");
});

// --- ordering stability -----------------------------------------------------

test("section order is policy, index, pinned, surfaced", async () => {
  const userDir = join(makeTempDir(), "memory");
  const s = session({ dir: userDir, projectMemoryRoot: "" }, makeTempDir());
  mkdirSync(userDir, { recursive: true });
  writeFile(join(userDir, "MEMORY.md"), "- [A](a.md) — alpha");
  writeMemory(userDir, "pin.md", { name: "pin", description: "pinned", pinned: true, body: "P BODY" });
  writeMemory(userDir, "a.md", { name: "a", description: "alpha memory", body: "A BODY" });
  rescan(s);
  attachSelector(s, provider(["a.md"]));

  const out = (await runTurn(s, "BASE", "a query with several words")) ?? "";
  const iPolicy = out.indexOf("# Memory");
  const iIndex = out.indexOf("## MEMORY.md");
  const iPinned = out.indexOf("# Pinned memories");
  const iSurfaced = out.indexOf(`<memory path="${join(userDir, "a.md")}">`);
  assert(iPolicy >= 0 && iIndex > iPolicy, "index follows policy");
  assert(iPinned > iIndex, "pinned follows index");
  assert(iSurfaced > iPinned, "surfaced follows pinned");
});
