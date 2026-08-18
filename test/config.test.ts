import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { assert, assertEqual, makeTempDir, test, writeFile } from "./harness.ts";
import {
  DEFAULTS,
  disabledByEnv,
  expandHome,
  findProjectRoot,
  loadConfig,
  mergeConfig,
  projectSlug,
  resolveDirs,
} from "../extension/config.ts";
import { mkdirSync } from "node:fs";

test("defaults apply to every unset key", () => {
  const c = mergeConfig({ maxFiles: 7 });
  assertEqual(c.maxFiles, 7);
  assertEqual(c.maxSessionBytes, DEFAULTS.maxSessionBytes);
  assertEqual(c.selector.model, DEFAULTS.selector.model);
  assertEqual(c.indexMaxBytes, 25000);
  assertEqual(c.fileMaxBytes, 4096, "surfacing byte budget is cop=4096, not 65536");
  assertEqual(c.scanMaxBytes, 65536, "scan byte budget is dRt=65536");
});

test("missing config file yields defaults", () => {
  const dir = makeTempDir();
  const c = loadConfig(dir);
  assertEqual(c.enabled, true);
  assertEqual(c.maxFiles, DEFAULTS.maxFiles);
});

test("invalid JSON yields defaults without throwing", () => {
  const dir = makeTempDir();
  writeFileSync(join(dir, "memory-config.json"), "{ not json", "utf8");
  const c = loadConfig(dir);
  assertEqual(c.enabled, true);
  assertEqual(c.selector.timeoutMs, DEFAULTS.selector.timeoutMs);
});

test("a non-object config yields defaults", () => {
  assertEqual(mergeConfig(null).maxFiles, DEFAULTS.maxFiles);
  assertEqual(mergeConfig([1, 2]).maxFiles, DEFAULTS.maxFiles);
  assertEqual(mergeConfig("nope").maxFiles, DEFAULTS.maxFiles);
});

test("a wrongly typed key falls back for that key alone", () => {
  const c = mergeConfig({ enabled: "yes", maxFiles: "lots", maxSessionBytes: 100 });
  assertEqual(c.enabled, DEFAULTS.enabled);
  assertEqual(c.maxFiles, DEFAULTS.maxFiles);
  assertEqual(c.maxSessionBytes, 100);
});

test("unknown keys are ignored", () => {
  const c = mergeConfig({ nonsense: true, selector: { nonsense: 1, maxSelected: 2 } });
  assertEqual(c.selector.maxSelected, 2);
  assert(!("nonsense" in c), "unknown key must not leak into the config");
});

test("a leading ~ expands to the home directory", () => {
  assertEqual(expandHome("~/x/y", "/home/u"), "/home/u/x/y");
  assertEqual(expandHome("~", "/home/u"), "/home/u");
  assertEqual(expandHome("/abs/path", "/home/u"), "/abs/path");
  assertEqual(expandHome("relative/path", "/home/u"), "relative/path");
});

test("a project path gets a readable, stable and collision-resistant slug", () => {
  const slug = projectSlug("/home/u/src/app");
  assert(slug.startsWith("-home-u-src-app--"), "the readable path remains visible");
  assertEqual(projectSlug("/home/u/src/app/"), slug, "trailing separators do not change the key");
  assert(projectSlug("/home/u/my.repo_2").startsWith("-home-u-my-repo-2--"));
  assert(projectSlug("/a/b-c") !== projectSlug("/a-b/c"), "different paths must not share a slug");
  assert(projectSlug("/").length > 0, "the filesystem root still yields a usable name");
});

test("the project root is the nearest ancestor holding .git", () => {
  const repo = makeTempDir("pi-memory-repo-");
  const nested = join(repo, "packages", "web");
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(repo, ".git"));
  assertEqual(findProjectRoot(nested), repo, "a subdirectory resolves to the repo root");
  assertEqual(findProjectRoot(repo), repo);
});

test("outside a repo the project root is cwd itself", () => {
  const plain = makeTempDir("pi-memory-plain-");
  assertEqual(findProjectRoot(plain), plain);
});

test("a worktree or submodule, where .git is a file, still resolves", () => {
  const repo = makeTempDir("pi-memory-wt-");
  writeFile(join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
  assertEqual(findProjectRoot(join(repo, "sub")), repo);
});

test("project memory lives under the agent dir, keyed on the project path", () => {
  const repo = makeTempDir("pi-memory-key-");
  const dirs = resolveDirs(mergeConfig({ dir: "~/.pi/agent/memory" }), repo, "/home/u");
  assertEqual(dirs.userDir, "/home/u/.pi/agent/memory");
  assertEqual(dirs.projectRoot, repo);
  assertEqual(
    dirs.projectDir,
    join("/home/u/.pi/agent/project-memory", projectSlug(repo)),
    "nothing is written inside the project itself",
  );
});

test("two projects get two different project memory directories", () => {
  const a = makeTempDir("pi-memory-a-");
  const b = makeTempDir("pi-memory-b-");
  const dirsA = resolveDirs(mergeConfig({}), a, "/home/u");
  const dirsB = resolveDirs(mergeConfig({}), b, "/home/u");
  assert(dirsA.projectDir !== dirsB.projectDir, "project memory must not be shared between projects");
});

test("an empty projectMemoryRoot switches the project scope off", () => {
  const dirs = resolveDirs(mergeConfig({ projectMemoryRoot: "" }), "/work/repo", "/home/u");
  assertEqual(dirs.projectDir, undefined);
  assertEqual(dirs.projectRoot, undefined);
  assertEqual(dirs.userDir, "/home/u/.pi/agent/memory");
});

test("a projectMemoryRoot colliding with the user dir disables the project scope", () => {
  const repo = makeTempDir("pi-memory-collide-");
  const dirs = resolveDirs(
    mergeConfig({ dir: join("/mem", projectSlug(repo)), projectMemoryRoot: "/mem" }),
    repo,
    "/home/u",
  );
  assertEqual(dirs.projectDir, undefined, "one directory cannot be both scopes");
});

test("PI_MEMORY_DISABLED gates the extension", () => {
  assertEqual(disabledByEnv({} as NodeJS.ProcessEnv), false);
  assertEqual(disabledByEnv({ PI_MEMORY_DISABLED: "" } as NodeJS.ProcessEnv), false);
  assertEqual(disabledByEnv({ PI_MEMORY_DISABLED: "0" } as NodeJS.ProcessEnv), false);
  assertEqual(disabledByEnv({ PI_MEMORY_DISABLED: "1" } as NodeJS.ProcessEnv), true);
  assertEqual(disabledByEnv({ PI_MEMORY_DISABLED: "true" } as NodeJS.ProcessEnv), true);
});

test("selector.enabled false does not disable the extension", () => {
  const c = mergeConfig({ selector: { enabled: false } });
  assertEqual(c.enabled, true);
  assertEqual(c.selector.enabled, false);
});

test("a config file on disk is merged over the defaults", () => {
  const dir = makeTempDir();
  writeFile(
    join(dir, "memory-config.json"),
    JSON.stringify({ maxPinned: 2, selector: { model: "anthropic/claude-haiku-4-5" } }),
  );
  const c = loadConfig(dir);
  assertEqual(c.maxPinned, 2);
  assertEqual(c.selector.model, "anthropic/claude-haiku-4-5");
  assertEqual(c.selector.maxSelected, 5);
});
