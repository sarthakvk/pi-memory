import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { assert, assertEqual, makeTempDir, test, writeFile } from "./harness.ts";
import {
  DEFAULTS,
  disabledByEnv,
  expandHome,
  loadConfig,
  mergeConfig,
  resolveDirs,
} from "../extension/config.ts";

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

test("projectDir resolves relative to cwd", () => {
  const dirs = resolveDirs(
    mergeConfig({ dir: "~/.pi/agent/memory", projectDir: ".pi/memory" }),
    "/work/repo",
    "/home/u",
  );
  assertEqual(dirs.privateDir, "/home/u/.pi/agent/memory");
  assertEqual(dirs.projectDir, "/work/repo/.pi/memory");
  assertEqual(dirs.indexPath, "/home/u/.pi/agent/memory/MEMORY.md");
});

test("an absolute projectDir is used as-is", () => {
  const dirs = resolveDirs(mergeConfig({ projectDir: "/elsewhere/mem" }), "/work/repo", "/home/u");
  assertEqual(dirs.projectDir, "/elsewhere/mem");
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
