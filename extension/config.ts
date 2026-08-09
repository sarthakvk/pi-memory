/**
 * CFG — configuration loading.
 *
 * Every key is optional. A missing, unreadable, or invalid config file yields
 * the full default config. A key of the wrong type is ignored in favour of
 * its default. Unknown keys are ignored.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";

export interface SelectorConfig {
  enabled: boolean;
  model: string;
  maxSelected: number;
  timeoutMs: number;
}

export interface MemoryConfig {
  enabled: boolean;
  dir: string;
  projectDir: string;
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
  citeMemories: boolean;
}

/**
 * Every limit the extension enforces, in one place. Overriding one is a
 * deliberate act, not a tuning accident.
 */
export const DEFAULTS: MemoryConfig = {
  enabled: true,
  dir: "~/.pi/agent/memory",
  projectDir: ".pi/memory",
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
  // Citation tags are an internal channel: they only work if something strips
  // them before the user sees the reply. Pi has no render hook that can, so
  // leaving this on would surface raw XML in replies. Default off.
  citeMemories: false,
};

export const CONFIG_FILENAME = "memory-config.json";
export const INDEX_FILENAME = "MEMORY.md";
export const TEAM_PREFIX = "team/";

function pickBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function pickString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

function pickPositiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/** Merge a parsed JSON object over the defaults. Never throws. */
export function mergeConfig(raw: unknown): MemoryConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULTS };
  const o = raw as Record<string, unknown>;
  const rawSelector =
    typeof o.selector === "object" && o.selector !== null && !Array.isArray(o.selector)
      ? (o.selector as Record<string, unknown>)
      : {};

  return {
    enabled: pickBoolean(o.enabled, DEFAULTS.enabled),
    dir: pickString(o.dir, DEFAULTS.dir),
    projectDir: pickString(o.projectDir, DEFAULTS.projectDir),
    selector: {
      enabled: pickBoolean(rawSelector.enabled, DEFAULTS.selector.enabled),
      model: pickString(rawSelector.model, DEFAULTS.selector.model),
      maxSelected: pickPositiveInt(rawSelector.maxSelected, DEFAULTS.selector.maxSelected),
      timeoutMs: pickPositiveInt(rawSelector.timeoutMs, DEFAULTS.selector.timeoutMs),
    },
    maxSessionBytes: pickPositiveInt(o.maxSessionBytes, DEFAULTS.maxSessionBytes),
    maxFiles: pickPositiveInt(o.maxFiles, DEFAULTS.maxFiles),
    scanMaxLines: pickPositiveInt(o.scanMaxLines, DEFAULTS.scanMaxLines),
    scanMaxBytes: pickPositiveInt(o.scanMaxBytes, DEFAULTS.scanMaxBytes),
    fileMaxLines: pickPositiveInt(o.fileMaxLines, DEFAULTS.fileMaxLines),
    fileMaxBytes: pickPositiveInt(o.fileMaxBytes, DEFAULTS.fileMaxBytes),
    indexMaxLines: pickPositiveInt(o.indexMaxLines, DEFAULTS.indexMaxLines),
    indexMaxBytes: pickPositiveInt(o.indexMaxBytes, DEFAULTS.indexMaxBytes),
    maxPinned: pickPositiveInt(o.maxPinned, DEFAULTS.maxPinned),
    citeMemories: pickBoolean(o.citeMemories, DEFAULTS.citeMemories),
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

export interface ResolvedDirs {
  /** Absolute private scope root. Always defined; may not exist on disk yet. */
  privateDir: string;
  /** Absolute project scope root, or undefined when the project scope is off. */
  projectDir: string | undefined;
  /** Absolute path to MEMORY.md, which always lives in the private dir. */
  indexPath: string;
}

/**
 * Resolve scope roots. `projectDir` is relative to cwd unless absolute; the
 * caller decides whether it exists.
 */
export function resolveDirs(config: MemoryConfig, cwd: string, home = homedir()): ResolvedDirs {
  const privateDir = resolve(expandHome(config.dir, home));
  const projectRaw = expandHome(config.projectDir, home);
  const projectDir = config.projectDir
    ? isAbsolute(projectRaw)
      ? projectRaw
      : resolve(cwd, projectRaw)
    : undefined;
  return {
    privateDir,
    projectDir: projectDir === privateDir ? undefined : projectDir,
    indexPath: join(privateDir, INDEX_FILENAME),
  };
}
