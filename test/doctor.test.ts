import { join } from "node:path";
import { assert, assertDeepEqual, assertEqual, assertIncludes, makeTempDir, test, writeFile, writeMemory } from "./harness.ts";
import { DEFAULTS } from "../extension/config.ts";
import { scanAll, type MemoryScope } from "../extension/scan.ts";
import {
  descriptionKey,
  diagnose,
  extractIndexPointers,
  renderFindings,
  type Finding,
} from "../extension/doctor.ts";

interface Fix {
  userDir: string;
  projectDir: string;
  userIndexPath: string;
  projectIndexPath: string;
}

function fix(): Fix {
  const userDir = makeTempDir("pi-memory-doc-user-");
  const projectDir = makeTempDir("pi-memory-doc-proj-");
  return {
    userDir,
    projectDir,
    userIndexPath: join(userDir, "MEMORY.md"),
    projectIndexPath: join(projectDir, "MEMORY.md"),
  };
}

function run(f: Fix, opts: { withProject?: boolean } = {}): Finding[] {
  const roots: Array<{ root: string; scope: MemoryScope }> = [{ root: f.userDir, scope: "user" }];
  const indexes = [{ indexPath: f.userIndexPath, scope: "user" as MemoryScope }];
  if (opts.withProject !== false) {
    roots.push({ root: f.projectDir, scope: "project" });
    indexes.push({ indexPath: f.projectIndexPath, scope: "project" });
  }
  const { files } = scanAll(roots, DEFAULTS);
  return diagnose({ files, indexes });
}

function kinds(findings: Finding[], subject: string): string[] {
  return findings.filter((x) => x.subject === subject).map((x) => x.kind).sort();
}

test("index pointers come from markdown links and bare .md tokens", () => {
  const pointers = extractIndexPointers(
    [
      "- [Testing](testing.md) — how to run tests",
      "- [Nested](topics/policy.md) — the policy",
      "- see also user_role.md for context",
      "- [Anchored](./anchored.md#section) — with an anchor",
    ].join("\n"),
  );
  assert(pointers.has("testing.md"), "markdown link target");
  assert(pointers.has("topics/policy.md"), "nested link target");
  assert(pointers.has("user_role.md"), "bare .md token");
  assert(pointers.has("anchored.md"), "leading ./ and #anchor are stripped");
});

test("descriptionKey collapses phrasing differences", () => {
  assertEqual(
    descriptionKey("How to run THIS project's tests!"),
    descriptionKey("this project tests: how to run"),
  );
  assert(
    descriptionKey("how to run the tests") !== descriptionKey("where the coffee machine lives"),
    "unrelated descriptions must not collide",
  );
});

test("a clean two-scope memory directory produces no findings", () => {
  const f = fix();
  writeMemory(f.userDir, "user-role.md", {
    name: "user-role",
    description: "the user is a staff engineer working on ingest",
    type: "user",
  });
  writeMemory(f.projectDir, "testing.md", {
    name: "testing",
    description: "how to run this project's tests",
    type: "project",
  });
  writeFile(f.userIndexPath, "- [Role](user-role.md) — who the user is");
  writeFile(f.projectIndexPath, "- [Testing](testing.md) — bun test");
  assertDeepEqual(run(f), []);
  assertEqual(renderFindings([])[0], "memory doctor: no findings.");
});

// --- scope routing ----------------------------------------------------------

test("a user memory in the project scope is a scope violation", () => {
  const f = fix();
  writeMemory(f.projectDir, "who.md", {
    name: "who",
    description: "the user prefers terse replies",
    type: "user",
  });
  writeFile(f.projectIndexPath, "- [Who](who.md) — who the user is");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "project/who.md"), ["scope-violation"]);
  assertIncludes(findings[0].message, "`user` memories belong in user memory");
  assertIncludes(findings[0].message, "stay true across projects");
});

test("a project memory in the user scope is a scope violation", () => {
  const f = fix();
  writeMemory(f.userDir, "ingest.md", {
    name: "ingest",
    description: "the ingest rewrite must stay backward compatible",
    type: "project",
  });
  writeFile(f.userIndexPath, "- [Ingest](ingest.md) — the rewrite");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "ingest.md"), ["scope-violation"]);
  assertIncludes(findings[0].message, "`project` memories belong in project memory");
});

test("each memory in its own scope is fine", () => {
  const f = fix();
  writeMemory(f.userDir, "who.md", {
    name: "who",
    description: "the user prefers terse replies",
    type: "user",
  });
  writeMemory(f.projectDir, "ingest.md", {
    name: "ingest",
    description: "the ingest rewrite must stay backward compatible",
    type: "project",
  });
  writeFile(f.userIndexPath, "- [Who](who.md) — who the user is");
  writeFile(f.projectIndexPath, "- [Ingest](ingest.md) — the rewrite");
  assertDeepEqual(run(f), []);
});

test("feedback and reference are routed by judgement, so neither scope is a violation", () => {
  const f = fix();
  writeMemory(f.userDir, "style.md", {
    name: "style",
    description: "the user wants terse commit messages everywhere",
    type: "feedback",
  });
  writeMemory(f.projectDir, "review.md", {
    name: "review",
    description: "this repo squashes before merge",
    type: "feedback",
  });
  writeMemory(f.userDir, "dash.md", { name: "dash", description: "the ops dashboard", type: "reference" });
  writeMemory(f.projectDir, "rfc.md", { name: "rfc", description: "the ingest design doc", type: "reference" });
  writeFile(f.userIndexPath, ["- [Style](style.md) — hook", "- [Dash](dash.md) — hook"].join("\n"));
  writeFile(f.projectIndexPath, ["- [Review](review.md) — hook", "- [RFC](rfc.md) — hook"].join("\n"));
  assertDeepEqual(run(f), []);
});

// --- indexes ----------------------------------------------------------------

test("a memory with no index pointer is reported", () => {
  const f = fix();
  writeMemory(f.userDir, "orphan.md", {
    name: "orphan",
    description: "a memory nobody indexed",
    type: "feedback",
  });
  writeFile(f.userIndexPath, "- [Something else](other.md) — hook");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "orphan.md"), ["unindexed"]);
  assertIncludes(
    findings.find((x) => x.subject === "orphan.md")?.message ?? "",
    "invisible to the model unless recall happens to select it",
  );
});

test("a pointer in the wrong scope's index does not count", () => {
  const f = fix();
  writeMemory(f.projectDir, "testing.md", {
    name: "testing",
    description: "how to run this project's tests",
    type: "project",
  });
  // Indexed from the user scope, which no longer reaches project memories.
  writeFile(f.userIndexPath, "- [Testing](testing.md) — bun test");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "project/testing.md"), ["unindexed"]);
  assertIncludes(
    findings.find((x) => x.subject === "project/testing.md")?.message ?? "",
    "in the project MEMORY.md",
  );
  assertDeepEqual(kinds(findings, "testing.md"), ["dangling-pointer"]);
});

test("an index pointer with no file behind it is reported", () => {
  const f = fix();
  writeMemory(f.userDir, "real.md", { name: "real", description: "a real memory", type: "feedback" });
  writeFile(f.userIndexPath, ["- [Real](real.md) — hook", "- [Ghost](ghost.md) — hook"].join("\n"));
  const findings = run(f);
  assertDeepEqual(kinds(findings, "ghost.md"), ["dangling-pointer"]);
  assertIncludes(findings[0].message, "the user MEMORY.md points at a memory that does not exist");
});

test("a dangling project pointer is named in the project namespace", () => {
  const f = fix();
  writeFile(f.projectIndexPath, "- [Ghost](ghost.md) — hook");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "project/ghost.md"), ["dangling-pointer"]);
});

test("MEMORY.md referring to itself is not a dangling pointer", () => {
  const f = fix();
  writeMemory(f.userDir, "a.md", { name: "a", description: "alpha memory", type: "feedback" });
  writeFile(f.userIndexPath, ["- [A](a.md) — hook", "keep MEMORY.md concise"].join("\n"));
  assertDeepEqual(run(f), []);
});

// --- frontmatter quality ----------------------------------------------------

test("a missing or non-conforming name is reported", () => {
  const f = fix();
  writeMemory(f.userDir, "noname.md", { description: "has no name field", type: "feedback" });
  writeMemory(f.userDir, "badname.md", {
    name: "Not Kebab Case",
    description: "a differently worded memory about builds",
    type: "feedback",
  });
  writeFile(f.userIndexPath, ["- [A](noname.md) — hook", "- [B](badname.md) — hook"].join("\n"));
  const findings = run(f);
  assertDeepEqual(kinds(findings, "noname.md"), ["bad-name"]);
  assertIncludes(findings.find((x) => x.subject === "noname.md")?.message ?? "", "no `name:`");
  assertDeepEqual(kinds(findings, "badname.md"), ["bad-name"]);
  assertIncludes(
    findings.find((x) => x.subject === "badname.md")?.message ?? "",
    "does not match ^[a-z0-9_-]+$",
  );
});

test("a memory with no retrievable description is reported", () => {
  const f = fix();
  // No description and an empty body, so the body-derived fallback yields null.
  writeFile(join(f.userDir, "blank.md"), "---\nname: blank\nmetadata:\n  type: feedback\n---\n\n\n");
  writeFile(f.userIndexPath, "- [Blank](blank.md) — hook");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "blank.md"), ["no-description"]);
  assertIncludes(findings[0].message, "can never be selected");
});

test("two memories restating the same fact are flagged as duplicates", () => {
  const f = fix();
  writeMemory(f.userDir, "tests-a.md", {
    name: "tests-a",
    description: "how to run this project's tests",
    type: "feedback",
  });
  writeMemory(f.userDir, "tests-b.md", {
    name: "tests-b",
    description: "This project tests: how to run!",
    type: "feedback",
  });
  writeFile(f.userIndexPath, ["- [A](tests-a.md) — hook", "- [B](tests-b.md) — hook"].join("\n"));
  const findings = run(f);
  assertDeepEqual(kinds(findings, "tests-a.md"), ["duplicate"]);
  assertDeepEqual(kinds(findings, "tests-b.md"), ["duplicate"]);
  assertIncludes(
    findings.find((x) => x.subject === "tests-a.md")?.message ?? "",
    "probable duplicate of tests-b.md",
  );
});

test("duplicates are caught across scopes, not just within one", () => {
  const f = fix();
  writeMemory(f.userDir, "tests-a.md", {
    name: "tests-a",
    description: "how to run this project's tests",
    type: "feedback",
  });
  writeMemory(f.projectDir, "tests-b.md", {
    name: "tests-b",
    description: "This project tests: how to run!",
    type: "feedback",
  });
  writeFile(f.userIndexPath, "- [A](tests-a.md) — hook");
  writeFile(f.projectIndexPath, "- [B](tests-b.md) — hook");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "tests-a.md"), ["duplicate"]);
  assertDeepEqual(kinds(findings, "project/tests-b.md"), ["duplicate"]);
});

test("findings render with kind, subject and explanation", () => {
  const f = fix();
  writeMemory(f.projectDir, "who.md", { name: "who", description: "user facts", type: "user" });
  const text = renderFindings(run(f)).join("\n");
  assertIncludes(text, "memory doctor: 2 findings");
  assertIncludes(text, "[scope-violation] project/who.md");
  assertIncludes(text, "[unindexed] project/who.md");
});

// --- pinned / index interaction -----------------------------------

test("a pinned memory with no index pointer is clean", () => {
  const f = fix();
  writeMemory(f.userDir, "always.md", {
    name: "always",
    description: "never force-push to main",
    type: "feedback",
    pinned: true,
  });
  writeMemory(f.projectDir, "testing.md", {
    name: "testing",
    description: "how to run this project's tests",
    type: "project",
  });
  writeFile(f.projectIndexPath, "- [Testing](testing.md) — bun test");
  assertDeepEqual(run(f), [], "the pinned memory is correctly absent from the index");
});

test("a pinned memory that still has an index pointer is reported", () => {
  const f = fix();
  writeMemory(f.userDir, "always.md", {
    name: "always",
    description: "never force-push to main",
    type: "feedback",
    pinned: true,
  });
  writeFile(f.userIndexPath, "- [Always](always.md) — never force-push");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "always.md"), ["pinned-and-indexed"]);
  assertIncludes(findings[0].message, "its body is already injected in full");
  assertIncludes(findings[0].message, "truncation cut-off");
});

test("a pinned memory is exempt from the unindexed check", () => {
  const f = fix();
  writeMemory(f.userDir, "always.md", {
    name: "always",
    description: "never force-push to main",
    type: "feedback",
    pinned: true,
  });
  writeFile(f.userIndexPath, "");
  const findings = run(f);
  assertEqual(findings.length, 0, `expected no findings, got ${JSON.stringify(findings)}`);
});

test("the unpin transition without an index edit is caught", () => {
  const f = fix();
  // The state left behind by removing `pinned: true` and forgetting step 2.
  writeMemory(f.userDir, "was-pinned.md", {
    name: "was-pinned",
    description: "never force-push to main",
    type: "feedback",
  });
  writeFile(f.userIndexPath, "- [Other](other.md) — hook");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "was-pinned.md"), ["unindexed"]);
  const message = findings.find((x) => x.subject === "was-pinned.md")?.message ?? "";
  assertIncludes(message, "invisible to the model unless recall happens to select it");
  assertIncludes(message, "If it was just unpinned, add its index pointer");
});

test("both directions of the transition are caught in one run", () => {
  const f = fix();
  writeMemory(f.userDir, "newly-pinned.md", {
    name: "newly-pinned",
    description: "a rule that now applies everywhere",
    type: "feedback",
    pinned: true,
  });
  writeMemory(f.userDir, "newly-unpinned.md", {
    name: "newly-unpinned",
    description: "a rule that is now situational",
    type: "feedback",
  });
  // Stale index: still points at the newly pinned one, not at the newly unpinned one.
  writeFile(f.userIndexPath, "- [Pinned](newly-pinned.md) — stale pointer");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "newly-pinned.md"), ["pinned-and-indexed"]);
  assertDeepEqual(kinds(findings, "newly-unpinned.md"), ["unindexed"]);
});
