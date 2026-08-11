/**
 * WRITE — the memory policy prompt, and the SELECT system prompt.
 *
 * Prompt prose lives in the Markdown files under ../prompt. This module only
 * loads those files and fills in values that are known at runtime.
 */

import { readFileSync } from "node:fs";

import { INDEX_FILENAME } from "./config.ts";

const PROMPT_DIR = new URL("../prompt/", import.meta.url);

function readPrompt(filename: string): string {
  return readFileSync(new URL(filename, PROMPT_DIR), "utf8");
}

const SELECTOR_SYSTEM_PROMPT = readPrompt("selector-system.md");
export { SELECTOR_SYSTEM_PROMPT };

const POLICY_TEMPLATE = readPrompt("policy.md");
const FRONTMATTER_TEMPLATE = readPrompt("frontmatter.md");
const PINNING_BULLETS = readPrompt("pinning-bullets.md");
const TEAM_INDEX_GUIDANCE = readPrompt("team-index-guidance.md");
const TEAM_SCOPE_GUIDANCE = readPrompt("team-scope.md");

function replaceLine(template: string, token: string, value: string): string {
  return value ? template.replace(token, value) : template.replace(`${token}\n`, "");
}

function renderPolicyTemplate(values: {
  displayName: string;
  privateDir: string;
  teamDir?: string;
  indexMaxLines: number;
  maxPinned: number;
}): string {
  const hasTeam = Boolean(values.teamDir);
  let prompt = POLICY_TEMPLATE
    .replace(/\{\{#team\}\}([\s\S]*?)\{\{\/team\}\}/g, hasTeam ? "$1" : "")
    .replace(/\{\{\^team\}\}([\s\S]*?)\{\{\/team\}\}/g, hasTeam ? "" : "$1");

  prompt = replaceLine(prompt, "__SCOPE_GUIDANCE__", hasTeam ? TEAM_SCOPE_GUIDANCE : "");
  prompt = replaceLine(
    prompt,
    "__TEAM_INDEX_GUIDANCE__",
    hasTeam ? TEAM_INDEX_GUIDANCE.replaceAll("__INDEX_FILENAME__", INDEX_FILENAME) : "",
  );

  const replacements: Record<string, string> = {
    __DISPLAY_NAME__: values.displayName,
    __PRIVATE_DIR__: values.privateDir,
    __TEAM_DIR__: values.teamDir ?? "",
    __INDEX_FILENAME__: INDEX_FILENAME,
    __INDEX_MAX_LINES__: String(values.indexMaxLines),
    __MAX_PINNED__: String(values.maxPinned),
    __FRONTMATTER_TEMPLATE__: FRONTMATTER_TEMPLATE,
    __PINNING_BULLETS__: PINNING_BULLETS
      .replaceAll("__INDEX_FILENAME__", INDEX_FILENAME)
      .replaceAll("__MAX_PINNED__", String(values.maxPinned)),
  };
  for (const [token, value] of Object.entries(replacements)) {
    prompt = prompt.replaceAll(token, value);
  }
  return prompt;
}

export interface PolicyPromptOptions {
  /** Absolute private memory directory. */
  privateDir: string;
  /** Absolute team memory directory, or undefined when there is no project scope. */
  teamDir?: string;
  /** Index line cap, quoted into the "lines after N will be truncated" bullet. */
  indexMaxLines: number;
  /** Pinned cap, quoted into the pinning bullet. */
  maxPinned: number;
  /** Section title. Defaults to "Memory". */
  displayName?: string;
}

/**
 * Build the memory policy prompt: the index-based save flow and the
 * two-scope directory sentences.
 *
 * Deterministic: same options in, byte-identical string out.
 */
export function buildPolicyPrompt(opts: PolicyPromptOptions): string {
  return renderPolicyTemplate({
    displayName: opts.displayName ?? "Memory",
    privateDir: opts.privateDir,
    teamDir: opts.teamDir,
    indexMaxLines: opts.indexMaxLines,
    maxPinned: opts.maxPinned,
  });
}
