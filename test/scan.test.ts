import { join } from "node:path";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { assert, assertDeepEqual, assertEqual, makeTempDir, test, writeFile, writeMemory } from "./harness.ts";
import { DEFAULTS } from "../extension/config.ts";
import {
  deriveDescription,
  normalizeType,
  pinnedCandidates,
  pinnedStateOf,
  scanAll,
  scanDir,
} from "../extension/scan.ts";

const SCAN_OPTS = { scanMaxLines: DEFAULTS.scanMaxLines, scanMaxBytes: DEFAULTS.scanMaxBytes };

test("REQ-SCAN-1", "the walk is recursive and markdown-only", () => {
  const root = makeTempDir();
  writeMemory(root, "a.md", { description: "top level" });
  writeMemory(root, "sub/b.md", { description: "nested" });
  writeMemory(root, "sub/deep/c.md", { description: "deeper" });
  writeFile(join(root, "notes.txt"), "ignored");
  writeFile(join(root, "sub/readme.rst"), "ignored");

  const files = scanDir(root, "private", SCAN_OPTS);
  assertDeepEqual(files.map((f) => f.filename).sort(), ["a.md", "sub/b.md", "sub/deep/c.md"]);
});

test("REQ-SCAN-2", "description falls back to the first meaningful body line", () => {
  assertEqual(deriveDescription("\n\n## A heading\nbody\n"), "A heading");
  assertEqual(deriveDescription("plain first line\nsecond"), "plain first line");
  assertEqual(deriveDescription("\n   \n"), null);
  assertEqual(deriveDescription(`# ${"x".repeat(300)}`)?.length, 120, "capped at nny=120");
});

test("REQ-SCAN-2", "frontmatter description wins over the body fallback", () => {
  const root = makeTempDir();
  writeMemory(root, "with.md", { description: "from frontmatter", body: "# from body" });
  writeMemory(root, "without.md", { name: "n", body: "# from body" });
  const files = scanDir(root, "private", SCAN_OPTS);
  const byName = new Map(files.map((f) => [f.filename, f]));
  assertEqual(byName.get("with.md")?.description, "from frontmatter");
  assertEqual(byName.get("without.md")?.description, "from body");
});

test("REQ-SCAN-3", "only the four known types survive", () => {
  assertEqual(normalizeType("user"), "user");
  assertEqual(normalizeType("reference"), "reference");
  assertEqual(normalizeType("banana"), undefined);
  assertEqual(normalizeType(42), undefined);
  assertEqual(normalizeType(undefined), undefined);
});

test("REQ-SCAN-4", "MEMORY.md is excluded at every depth and every scope", () => {
  const priv = makeTempDir();
  const proj = makeTempDir();
  writeFile(join(priv, "MEMORY.md"), "- [A](a.md) — hook");
  writeFile(join(priv, "sub/MEMORY.md"), "- nested index");
  writeMemory(priv, "a.md", { description: "a" });
  writeFile(join(proj, "MEMORY.md"), "- team index");
  writeMemory(proj, "t.md", { description: "t" });

  const { files } = scanAll(
    [
      { root: priv, scope: "private" },
      { root: proj, scope: "project" },
    ],
    DEFAULTS,
  );
  assert(
    files.every((f) => !f.filename.endsWith("MEMORY.md")),
    `MEMORY.md leaked into the memory set: ${files.map((f) => f.filename).join(", ")}`,
  );
  assertEqual(files.length, 2);
});

test("REQ-SCAN-5", "results are newest-first by mtime and capped at maxFiles", () => {
  const root = makeTempDir();
  writeMemory(root, "old.md", { description: "old", ageDays: 30 });
  writeMemory(root, "mid.md", { description: "mid", ageDays: 10 });
  writeMemory(root, "new.md", { description: "new", ageDays: 0 });

  const all = scanAll([{ root, scope: "private" }], DEFAULTS);
  assertDeepEqual(all.files.map((f) => f.filename), ["new.md", "mid.md", "old.md"]);

  const capped = scanAll([{ root, scope: "private" }], { ...DEFAULTS, maxFiles: 2 });
  assertDeepEqual(capped.files.map((f) => f.filename), ["new.md", "mid.md"]);
  assertEqual(capped.dropped, 1);
});

test("REQ-SCAN-6", "the scan read budget bounds what frontmatter is seen", () => {
  const root = makeTempDir();
  // Frontmatter pushed past the 3-line scan budget must not be found.
  writeFile(
    join(root, "late.md"),
    ["padding", "padding", "padding", "---", "description: never seen", "---", "body"].join("\n"),
  );
  const files = scanDir(root, "private", { scanMaxLines: 3, scanMaxBytes: 65536 });
  assertEqual(files[0].description, "padding", "only the first 3 lines were read");
});

test("REQ-SCAN-7", "pinnedState maps every input shape", () => {
  assertEqual(pinnedStateOf(undefined), "absent");
  assertEqual(pinnedStateOf(null), "absent");
  assertEqual(pinnedStateOf(true), "true");
  assertEqual(pinnedStateOf("true"), "true");
  assertEqual(pinnedStateOf(false), "false");
  assertEqual(pinnedStateOf("false"), "false");
  assertEqual(pinnedStateOf("yes"), "malformed");
  assertEqual(pinnedStateOf(1), "malformed");
});

test(["REQ-SCAN-8", "REQ-FAIL-4"], "a malformed file is scanned, not skipped", () => {
  const root = makeTempDir();
  writeFile(join(root, "broken.md"), "---\nthis: [is: not: yaml\n---\nsome body\n");
  writeMemory(root, "fine.md", { description: "fine" });
  const files = scanDir(root, "private", SCAN_OPTS);
  assertEqual(files.length, 2, "the malformed file must not abort the scan");
  const broken = files.find((f) => f.filename === "broken.md");
  assert(broken !== undefined, "broken.md is present");
  assertEqual(broken.type, undefined);
  assertEqual(broken.pinnedState, "absent");
});

test(["REQ-SCAN-9", "REQ-FAIL-3"], "a missing root contributes nothing and does not throw", () => {
  const root = makeTempDir();
  writeMemory(root, "a.md", { description: "a" });
  const { files } = scanAll(
    [
      { root, scope: "private" },
      { root: join(root, "does-not-exist"), scope: "project" },
    ],
    DEFAULTS,
  );
  assertEqual(files.length, 1);
});

test("REQ-SCAN-10", "project-scope files are namespaced under team/", () => {
  const priv = makeTempDir();
  const proj = makeTempDir();
  writeMemory(priv, "p.md", { description: "private" });
  writeMemory(proj, "sub/t.md", { description: "team" });
  const { files } = scanAll(
    [
      { root: priv, scope: "private" },
      { root: proj, scope: "project" },
    ],
    DEFAULTS,
  );
  const names = files.map((f) => f.filename).sort();
  assertDeepEqual(names, ["p.md", "team/sub/t.md"]);
  assertEqual(files.find((f) => f.filename.startsWith("team/"))?.scope, "project");
});

test("REQ-SCAN-11", "modifiedMs prefers metadata.modified when it parses", () => {
  const root = makeTempDir();
  writeFile(
    join(root, "dated.md"),
    ["---", "name: dated", "metadata:", "  modified: 2020-01-02T00:00:00Z", "---", "", "body"].join("\n"),
  );
  writeFile(
    join(root, "baddate.md"),
    ["---", "name: baddate", "metadata:", "  modified: not-a-date", "---", "", "body"].join("\n"),
  );
  const files = scanDir(root, "private", SCAN_OPTS);
  const dated = files.find((f) => f.filename === "dated.md");
  const bad = files.find((f) => f.filename === "baddate.md");
  assertEqual(dated?.modifiedMs, Date.parse("2020-01-02T00:00:00Z"));
  assertEqual(bad?.modifiedMs, bad?.mtimeMs, "an unparseable date falls back to mtime");
});

test("REQ-SCAN-12", "an unreadable file is skipped without breaking the scan", () => {
  const root = makeTempDir();
  writeMemory(root, "ok.md", { description: "ok" });
  const denied = join(root, "denied.md");
  writeFile(denied, "---\ndescription: secret\n---\n");
  try {
    chmodSync(denied, 0o000);
  } catch {
    return; // cannot exercise this without permission control
  }
  const files = scanDir(root, "private", SCAN_OPTS);
  chmodSync(denied, 0o644);
  // Running as root defeats chmod; only assert the scan survived.
  assert(files.some((f) => f.filename === "ok.md"), "the readable file is still scanned");
});

test(["REQ-INJECT-4", "REQ-LIMIT-5"], "pinned candidates are newest-first by modifiedMs and capped", () => {
  const root = makeTempDir();
  for (let i = 0; i < 12; i++) {
    writeMemory(root, `p${i}.md`, { description: `p${i}`, pinned: true, ageDays: i });
  }
  writeMemory(root, "unpinned.md", { description: "u" });
  writeMemory(root, "bad.md", { description: "b", pinned: "sometimes" });

  const { files } = scanAll([{ root, scope: "private" }], DEFAULTS);
  const { candidates, pinnedCount, malformedCount } = pinnedCandidates(files, DEFAULTS.maxPinned);
  assertEqual(pinnedCount, 12);
  assertEqual(malformedCount, 1);
  assertEqual(candidates.length, 8, "tny = uXr * 2 = 8");
  assertDeepEqual(
    candidates.map((c) => c.filename),
    ["p0.md", "p1.md", "p2.md", "p3.md", "p4.md", "p5.md", "p6.md", "p7.md"],
  );
});

test("REQ-SCAN-1", "directory symlinks are not followed", () => {
  const root = makeTempDir();
  const outside = makeTempDir();
  writeMemory(outside, "escaped.md", { description: "should not appear" });
  writeMemory(root, "inside.md", { description: "inside" });
  mkdirSync(join(root, "nested"), { recursive: true });
  try {
    symlinkSync(outside, join(root, "link"), "dir");
  } catch {
    return; // symlinks unavailable
  }
  const files = scanDir(root, "private", SCAN_OPTS);
  assertDeepEqual(files.map((f) => f.filename), ["inside.md"]);
});
