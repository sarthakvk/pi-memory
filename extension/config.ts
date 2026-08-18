/**
 * CFG — configuration loading.
 *
 * Every key is optional. A missing, unreadable, or invalid config file yields
 * the full default config. A key of the wrong type is ignored in favour of
 * its default. Unknown keys are ignored.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface SelectorConfig {
  enabled: boolean;
  model: string;
  maxSelected: number;
  timeoutMs: number;
}

export interface MemoryConfig {
  enabled: boolean;
  dir: string;
  projectMemoryRoot: string;
  selector: SelectorConfig;
  maxSessionBytes: number;
  maxFiles: number;
  scanMaxLines: number;
  scanMaxBytes: number;
  fileMaxLines: number;
  fileMaxBytes: number;
  indexMaxLines: number;
  indexMaxBytes: number;
  maxPinned: number;
}

/**
 * Every limit the extension enforces, in one place. Overriding one is a
 * deliberate act, not a tuning accident.
 */
export const DEFAULTS: MemoryConfig = {
  enabled: true,
  dir: "~/.pi/agent/memory",
  projectMemoryRoot: "~/.pi/agent/project-memory",
  selector: {
    enabled: true,
    model: "openai-codex/gpt-5.4-mini",
    maxSelected: 5,
    timeoutMs: 5000,
  },
  maxSessionBytes: 61440,
  maxFiles: 200,
  scanMaxLines: 30,
  scanMaxBytes: 65536,
  fileMaxLines: 200,
  fileMaxBytes: 4096,
  indexMaxLines: 200,
  indexMaxBytes: 25000,
  maxPinned: 8,
};

export const CONFIG_FILENAME = "memory-config.json";
export const INDEX_FILENAME = "MEMORY.md";
export const PROJECT_PREFIX = "project/";

function pickBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function pickString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

/**
 * Like `pickString`, but an explicit empty string is honoured rather than
 * treated as unset. That is how `projectMemoryRoot` is switched off.
 */
function pickPath(v: unknown, fallback: string): string {
  return typeof v === "string" ? v.trim() : fallback;
}

function pickPositiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : fallback;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/** Merge a parsed JSON object over the defaults. Never throws. */
export function mergeConfig(raw: unknown): MemoryConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ...DEFAULTS };
  const o = raw as Record<string, unknown>;
  const rawSelector =
    typeof o.selector === "object" &&
    o.selector !== null &&
    !Array.isArray(o.selector)
      ? (o.selector as Record<string, unknown>)
      : {};

  return {
    enabled: pickBoolean(o.enabled, DEFAULTS.enabled),
    dir: pickString(o.dir, DEFAULTS.dir),
    projectMemoryRoot: pickPath(
      o.projectMemoryRoot,
      DEFAULTS.projectMemoryRoot,
    ),
    selector: {
      enabled: pickBoolean(rawSelector.enabled, DEFAULTS.selector.enabled),
      model: pickString(rawSelector.model, DEFAULTS.selector.model),
      maxSelected: pickPositiveInt(
        rawSelector.maxSelected,
        DEFAULTS.selector.maxSelected,
      ),
      timeoutMs: pickPositiveInt(
        rawSelector.timeoutMs,
        DEFAULTS.selector.timeoutMs,
      ),
    },
    maxSessionBytes: pickPositiveInt(
      o.maxSessionBytes,
      DEFAULTS.maxSessionBytes,
    ),
    maxFiles: pickPositiveInt(o.maxFiles, DEFAULTS.maxFiles),
    scanMaxLines: pickPositiveInt(o.scanMaxLines, DEFAULTS.scanMaxLines),
    scanMaxBytes: pickPositiveInt(o.scanMaxBytes, DEFAULTS.scanMaxBytes),
    fileMaxLines: pickPositiveInt(o.fileMaxLines, DEFAULTS.fileMaxLines),
    fileMaxBytes: pickPositiveInt(o.fileMaxBytes, DEFAULTS.fileMaxBytes),
    indexMaxLines: pickPositiveInt(o.indexMaxLines, DEFAULTS.indexMaxLines),
    indexMaxBytes: pickPositiveInt(o.indexMaxBytes, DEFAULTS.indexMaxBytes),
    maxPinned: pickPositiveInt(o.maxPinned, DEFAULTS.maxPinned),
  };
}

/** Load `<agentDir>/memory-config.json`. Missing or broken → defaults. */
export function loadConfig(agentDir: string): MemoryConfig {
  let text: string;
  try {
    text = readFileSync(join(agentDir, CONFIG_FILENAME), "utf8");
  } catch {
    return { ...DEFAULTS };
  }
  try {
    return mergeConfig(JSON.parse(text));
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * `PI_MEMORY_DISABLED` set to anything other than empty or "0" disables the
 * extension entirely.
 */
export function disabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PI_MEMORY_DISABLED;
  return typeof v === "string" && v !== "" && v !== "0";
}

/**
 * The directory that identifies "this project": the nearest ancestor of `cwd`
 * containing a `.git` entry, or `cwd` itself when there is none.
 *
 * Walking up matters because project memory is keyed on this path. Starting the
 * agent in `repo/packages/web` must reach the same memory as starting it in
 * `repo`, otherwise every subdirectory silently gets its own empty store.
 * `.git` is tested with `existsSync`, not `isDirectory`, so a worktree or
 * submodule — where `.git` is a file — is recognised too.
 */
export function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/**
 * Flatten an absolute path into a readable directory name and append a stable
 * hash. The readable part makes the directory recognisable when browsing, and
 * the hash keeps distinct paths distinct (`/a/b-c` and `/a-b/c` would otherwise
 * both become `-a-b-c`).
 */
export function projectSlug(projectRoot: string): string {
  const normalized = resolve(projectRoot);
  const readable = normalized
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+$/, "");
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${readable === "" ? "root" : readable}--${hash}`;
}

export interface ResolvedDirs {
  /** Absolute user scope root. Always defined; may not exist on disk yet. */
  userDir: string;
  /** Absolute project scope root, or undefined when the project scope is off. */
  projectDir: string | undefined;
  /** The path the project scope is keyed on — the git root, or cwd. */
  projectRoot: string | undefined;
}

// Each scope's MEMORY.md is `<root>/MEMORY.md`. It is derived from the live
// roots at injection time rather than stored here, so there is one source of
// truth for which indexes exist.

/**
 * Resolve both scope roots. Project memory lives under
 * `<projectMemoryRoot>/<project-path-slug>` — inside the agent directory, not
 * inside the repo, so nothing is written into the user's project and nothing is
 * shared. An empty `projectMemoryRoot` switches the project scope off.
 */
export function resolveDirs(
  config: MemoryConfig,
  cwd: string,
  home = homedir(),
): ResolvedDirs {
  const userDir = resolve(expandHome(config.dir, home));
  const projectRoot = config.projectMemoryRoot
    ? findProjectRoot(cwd)
    : undefined;
  const resolved =
    projectRoot === undefined
      ? undefined
      : join(
          resolve(expandHome(config.projectMemoryRoot, home)),
          projectSlug(projectRoot),
        );
  const projectDir = resolved === userDir ? undefined : resolved;
  return {
    userDir,
    projectDir,
    projectRoot: projectDir === undefined ? undefined : projectRoot,
  };
}
