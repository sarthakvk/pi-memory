import { join } from "node:path";
import { assert, assertDeepEqual, assertEqual, assertIncludes, makeTempDir, test, writeFile, writeMemory } from "./harness.ts";
import { DEFAULTS } from "../extension/config.ts";
import { scanAll } from "../extension/scan.ts";
import {
  descriptionKey,
  diagnose,
  extractIndexPointers,
  renderFindings,
  type Finding,
} from "../extension/doctor.ts";

interface Fix {
  privateDir: string;
  projectDir: string;
  indexPath: string;
}

function fix(): Fix {
  const privateDir = makeTempDir("pi-memory-doc-priv-");
  const projectDir = makeTempDir("pi-memory-doc-proj-");
  return { privateDir, projectDir, indexPath: join(privateDir, "MEMORY.md") };
}

function run(f: Fix, opts: { withProject?: boolean } = {}): Finding[] {
  const roots: Array<{ root: string; scope: "private" | "project" }> = [
    { root: f.privateDir, scope: "private" },
  ];
  if (opts.withProject !== false) roots.push({ root: f.projectDir, scope: "project" });
  const { files } = scanAll(roots, DEFAULTS);
  return diagnose({ files, indexPath: f.indexPath });
}

function kinds(findings: Finding[], subject: string): string[] {
  return findings.filter((x) => x.subject === subject).map((x) => x.kind).sort();
}

test("REQ-WRITE-14", "index pointers come from markdown links and bare .md tokens", () => {
  const pointers = extractIndexPointers(
    [
      "- [Testing](testing.md) — how to run tests",
      "- [Team thing](team/policy.md) — the policy",
      "- see also user_role.md for context",
      "- [Anchored](./anchored.md#section) — with an anchor",
    ].join("\n"),
  );
  assert(pointers.has("testing.md"), "markdown link target");
  assert(pointers.has("team/policy.md"), "nested link target");
  assert(pointers.has("user_role.md"), "bare .md token");
  assert(pointers.has("anchored.md"), "leading ./ and #anchor are stripped");
});

test("REQ-WRITE-17", "descriptionKey collapses phrasing differences", () => {
  assertEqual(
    descriptionKey("How to run THIS project's tests!"),
    descriptionKey("this project tests: how to run"),
  );
  assert(
    descriptionKey("how to run the tests") !== descriptionKey("where the coffee machine lives"),
    "unrelated descriptions must not collide",
  );
});

test("REQ-WRITE-18", "a clean memory directory produces no findings", () => {
  const f = fix();
  writeMemory(f.privateDir, "user-role.md", {
    name: "user-role",
    description: "the user is a staff engineer working on ingest",
    type: "user",
  });
  writeMemory(f.projectDir, "testing.md", {
    name: "testing",
    description: "how to run this project's tests",
    type: "project",
  });
  writeFile(
    f.indexPath,
    ["- [Role](user-role.md) — who the user is", "- [Testing](team/testing.md) — bun test"].join("\n"),
  );
  assertDeepEqual(run(f), []);
  assertEqual(renderFindings([])[0], "memory doctor: no findings.");
});

test("REQ-WRITE-13", "a user memory in the team scope is a scope violation", () => {
  const f = fix();
  writeMemory(f.projectDir, "who.md", {
    name: "who",
    description: "the user prefers terse replies",
    type: "user",
  });
  writeFile(f.indexPath, "- [Who](team/who.md) — who the user is");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "team/who.md"), ["scope-violation"]);
  assertIncludes(findings[0].message, "`user` memories are always private");
});

test("REQ-WRITE-13", "the same user memory in the private scope is fine", () => {
  const f = fix();
  writeMemory(f.privateDir, "who.md", {
    name: "who",
    description: "the user prefers terse replies",
    type: "user",
  });
  writeFile(f.indexPath, "- [Who](who.md) — who the user is");
  assertDeepEqual(run(f), []);
});

test("REQ-WRITE-14", "a memory with no index pointer is reported", () => {
  const f = fix();
  writeMemory(f.privateDir, "orphan.md", {
    name: "orphan",
    description: "a memory nobody indexed",
    type: "project",
  });
  writeFile(f.indexPath, "- [Something else](other.md) — hook");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "orphan.md"), ["unindexed"]);
  assertIncludes(
    findings.find((x) => x.subject === "orphan.md")?.message ?? "",
    "invisible to the model unless recall happens to select it",
  );
});

test("REQ-WRITE-14", "an index pointer with no file behind it is reported", () => {
  const f = fix();
  writeMemory(f.privateDir, "real.md", { name: "real", description: "a real memory", type: "project" });
  writeFile(f.indexPath, ["- [Real](real.md) — hook", "- [Ghost](ghost.md) — hook"].join("\n"));
  const findings = run(f);
  assertDeepEqual(kinds(findings, "ghost.md"), ["dangling-pointer"]);
});

test("REQ-WRITE-14", "MEMORY.md referring to itself is not a dangling pointer", () => {
  const f = fix();
  writeMemory(f.privateDir, "a.md", { name: "a", description: "alpha memory", type: "project" });
  writeFile(f.indexPath, ["- [A](a.md) — hook", "keep MEMORY.md concise"].join("\n"));
  assertDeepEqual(run(f), []);
});

test("REQ-WRITE-15", "a missing or non-conforming name is reported", () => {
  const f = fix();
  writeMemory(f.privateDir, "noname.md", { description: "has no name field", type: "project" });
  writeMemory(f.privateDir, "badname.md", {
    name: "Not Kebab Case",
    description: "a differently worded memory about builds",
    type: "project",
  });
  writeFile(f.indexPath, ["- [A](noname.md) — hook", "- [B](badname.md) — hook"].join("\n"));
  const findings = run(f);
  assertDeepEqual(kinds(findings, "noname.md"), ["bad-name"]);
  assertIncludes(findings.find((x) => x.subject === "noname.md")?.message ?? "", "no `name:`");
  assertDeepEqual(kinds(findings, "badname.md"), ["bad-name"]);
  assertIncludes(
    findings.find((x) => x.subject === "badname.md")?.message ?? "",
    "does not match ^[a-z0-9_-]+$",
  );
});

test("REQ-WRITE-16", "a memory with no retrievable description is reported", () => {
  const f = fix();
  // No description and an empty body, so the body-derived fallback yields null.
  writeFile(join(f.privateDir, "blank.md"), "---\nname: blank\nmetadata:\n  type: project\n---\n\n\n");
  writeFile(f.indexPath, "- [Blank](blank.md) — hook");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "blank.md"), ["no-description"]);
  assertIncludes(findings[0].message, "can never be selected");
});

test("REQ-WRITE-17", "two memories restating the same fact are flagged as duplicates", () => {
  const f = fix();
  writeMemory(f.privateDir, "tests-a.md", {
    name: "tests-a",
    description: "how to run this project's tests",
    type: "project",
  });
  writeMemory(f.privateDir, "tests-b.md", {
    name: "tests-b",
    description: "This project tests: how to run!",
    type: "project",
  });
  writeFile(f.indexPath, ["- [A](tests-a.md) — hook", "- [B](tests-b.md) — hook"].join("\n"));
  const findings = run(f);
  assertDeepEqual(kinds(findings, "tests-a.md"), ["duplicate"]);
  assertDeepEqual(kinds(findings, "tests-b.md"), ["duplicate"]);
  assertIncludes(
    findings.find((x) => x.subject === "tests-a.md")?.message ?? "",
    "probable duplicate of tests-b.md",
  );
});

test("REQ-CMD-3", "findings render with kind, subject and explanation", () => {
  const f = fix();
  writeMemory(f.projectDir, "who.md", { name: "who", description: "user facts", type: "user" });
  const text = renderFindings(run(f)).join("\n");
  assertIncludes(text, "memory doctor: 2 findings");
  assertIncludes(text, "[scope-violation] team/who.md");
  assertIncludes(text, "[unindexed] team/who.md");
});

// --- pinned / index interaction (SPEC.md §7.1, REQ-WRITE-19..21) -------------

test("REQ-WRITE-19", "a pinned memory with no index pointer is clean", () => {
  const f = fix();
  writeMemory(f.privateDir, "always.md", {
    name: "always",
    description: "never force-push to main",
    type: "feedback",
    pinned: true,
  });
  writeMemory(f.privateDir, "testing.md", {
    name: "testing",
    description: "how to run this project's tests",
    type: "project",
  });
  writeFile(f.indexPath, "- [Testing](testing.md) — bun test");
  assertDeepEqual(run(f), [], "the pinned memory is correctly absent from the index");
});

test(["REQ-WRITE-21", "REQ-WRITE-19"], "a pinned memory that still has an index pointer is reported", () => {
  const f = fix();
  writeMemory(f.privateDir, "always.md", {
    name: "always",
    description: "never force-push to main",
    type: "feedback",
    pinned: true,
  });
  writeFile(f.indexPath, "- [Always](always.md) — never force-push");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "always.md"), ["pinned-and-indexed"]);
  assertIncludes(findings[0].message, "its body is already injected in full");
  assertIncludes(findings[0].message, "truncation cut-off");
});

test("REQ-WRITE-14", "a pinned memory is exempt from the unindexed check", () => {
  const f = fix();
  writeMemory(f.privateDir, "always.md", {
    name: "always",
    description: "never force-push to main",
    type: "feedback",
    pinned: true,
  });
  writeFile(f.indexPath, "");
  const findings = run(f);
  assertEqual(findings.length, 0, `expected no findings, got ${JSON.stringify(findings)}`);
});

test(["REQ-WRITE-20", "REQ-WRITE-14"], "the unpin transition without an index edit is caught", () => {
  const f = fix();
  // The state left behind by removing `pinned: true` and forgetting step 2.
  writeMemory(f.privateDir, "was-pinned.md", {
    name: "was-pinned",
    description: "never force-push to main",
    type: "feedback",
  });
  writeFile(f.indexPath, "- [Other](other.md) — hook");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "was-pinned.md"), ["unindexed"]);
  const message = findings.find((x) => x.subject === "was-pinned.md")?.message ?? "";
  assertIncludes(message, "invisible to the model unless recall happens to select it");
  assertIncludes(message, "If it was just unpinned, add its index pointer");
});

test("REQ-WRITE-20", "both directions of the transition are caught in one run", () => {
  const f = fix();
  writeMemory(f.privateDir, "newly-pinned.md", {
    name: "newly-pinned",
    description: "a rule that now applies everywhere",
    type: "feedback",
    pinned: true,
  });
  writeMemory(f.privateDir, "newly-unpinned.md", {
    name: "newly-unpinned",
    description: "a rule that is now situational",
    type: "project",
  });
  // Stale index: still points at the newly pinned one, not at the newly unpinned one.
  writeFile(f.indexPath, "- [Pinned](newly-pinned.md) — stale pointer");
  const findings = run(f);
  assertDeepEqual(kinds(findings, "newly-pinned.md"), ["pinned-and-indexed"]);
  assertDeepEqual(kinds(findings, "newly-unpinned.md"), ["unindexed"]);
});
