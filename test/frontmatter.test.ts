import { assert, assertEqual, test } from "./harness.ts";
import { NAME_PATTERN, parseMemoryFile } from "../extension/frontmatter.ts";

test("REQ-SCAN-3", "frontmatter fields and nested metadata parse", () => {
  const { frontmatter, body } = parseMemoryFile(
    ["---", "name: testing-scripts", "description: how to run tests", "metadata:", "  type: project", "  pinned: true", "---", "", "bun test", ""].join("\n"),
  );
  assertEqual(frontmatter.name, "testing-scripts");
  assertEqual(frontmatter.description, "how to run tests");
  assertEqual(frontmatter.metadata.type, "project");
  assertEqual(frontmatter.metadata.pinned, true);
  assertEqual(frontmatter.present, true);
  assertEqual(body.trim(), "bun test");
});

test("REQ-SCAN-8", "a file with no frontmatter yields empty frontmatter and full body", () => {
  const { frontmatter, body } = parseMemoryFile("# Just a heading\n\ncontent\n");
  assertEqual(frontmatter.name, null);
  assertEqual(frontmatter.description, null);
  assertEqual(frontmatter.present, false);
  assertEqual(body, "# Just a heading\n\ncontent\n");
});

test("REQ-SCAN-8", "malformed frontmatter body does not throw", () => {
  const { frontmatter } = parseMemoryFile(
    ["---", "name: ok", "  : : broken", "metadata: [1,2,", "---", "", "body"].join("\n"),
  );
  assertEqual(frontmatter.name, "ok");
  assertEqual(frontmatter.present, true);
});

test("REQ-SCAN-7", "unrecognised top-level keys fold into metadata", () => {
  // A top-level `pinned:` behaves like metadata.pinned.
  const { frontmatter } = parseMemoryFile(["---", "name: x", "pinned: true", "---", "", "b"].join("\n"));
  assertEqual(frontmatter.metadata.pinned, true);
});

test("REQ-SCAN-7", "explicit metadata wins over a folded top-level key", () => {
  const { frontmatter } = parseMemoryFile(
    ["---", "pinned: false", "metadata:", "  pinned: true", "---", "", "b"].join("\n"),
  );
  assertEqual(frontmatter.metadata.pinned, true);
});

test("REQ-SCAN-3", "quoted values and comments are handled", () => {
  const { frontmatter } = parseMemoryFile(
    ["---", 'description: "a: colon, and # hash"', "metadata:", "  type: user # trailing comment", "---", "", "b"].join("\n"),
  );
  assertEqual(frontmatter.description, "a: colon, and # hash");
  assertEqual(frontmatter.metadata.type, "user");
});

test("REQ-SCAN-3", "an empty description is treated as absent", () => {
  const { frontmatter } = parseMemoryFile(["---", "description:", "---", "", "b"].join("\n"));
  assertEqual(frontmatter.description, null);
});

test("REQ-SCAN-11", "the name pattern is the documented slug form", () => {
  assert(NAME_PATTERN.test("user-role"), "kebab-case is valid");
  assert(NAME_PATTERN.test("feedback_testing"), "underscores are valid");
  assert(!NAME_PATTERN.test("User-Role"), "uppercase is invalid");
  assert(!NAME_PATTERN.test("has space"), "spaces are invalid");
});
