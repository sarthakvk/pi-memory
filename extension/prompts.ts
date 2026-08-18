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

/**
 * Markdown template variables are resolved below. Double-underscore tokens are
 * literal placeholders whose values come from `buildPolicyPrompt` options or
 * runtime constants:
 * - `__DISPLAY_NAME__`, `__USER_DIR__`, and `__PROJECT_DIR__` are the heading
 *   and scope paths.
 * - `__INDEX_FILENAME__`, `__INDEX_MAX_LINES__`, and `__MAX_PINNED__` are
 *   config values used in the index and pinning instructions.
 * - `__FRONTMATTER_TEMPLATE__` and `__PINNING_BULLETS__` insert Markdown
 *   fragments loaded from their respective prompt files.
 * - `__SCOPE_GUIDANCE__` and `__PROJECT_INDEX_GUIDANCE__` insert the text that
 *   only applies when there are two scopes.
 * The `{{#project}}...{{/project}}` section is included when `projectDir`
 * exists; `{{^project}}...{{/project}}` is its single-scope alternative. Keep
 * these names synchronized with `renderPolicyTemplate` when editing the
 * Markdown prompts.
 */
const POLICY_TEMPLATE = readPrompt("policy.md");
const FRONTMATTER_TEMPLATE = readPrompt("frontmatter.md");
const PINNING_BULLETS = readPrompt("pinning-bullets.md");
const PROJECT_INDEX_GUIDANCE = readPrompt("project-index-guidance.md");
const PROJECT_SCOPE_GUIDANCE = readPrompt("project-scope.md");

function replaceLine(template: string, token: string, value: string): string {
  return value
    ? template.replace(token, () => value)
    : template.replace(`${token}\n`, "");
}

function renderPolicyTemplate(values: {
  displayName: string;
  userDir: string;
  projectDir?: string;
  indexMaxLines: number;
  maxPinned: number;
}): string {
  const hasProject = Boolean(values.projectDir);
  let prompt = POLICY_TEMPLATE
    .replace(/\{\{#project\}\}([\s\S]*?)\{\{\/project\}\}/g, hasProject ? "$1" : "")
    .replace(/\{\{\^project\}\}([\s\S]*?)\{\{\/project\}\}/g, hasProject ? "" : "$1");

  // Inserted before the token loop below, so the tokens these fragments carry
  // are resolved along with the rest.
  prompt = replaceLine(prompt, "__SCOPE_GUIDANCE__", hasProject ? PROJECT_SCOPE_GUIDANCE : "");
  prompt = replaceLine(
    prompt,
    "__PROJECT_INDEX_GUIDANCE__",
    hasProject ? PROJECT_INDEX_GUIDANCE : "",
  );

  const replacements: Record<string, string> = {
    __DISPLAY_NAME__: values.displayName,
    __USER_DIR__: values.userDir,
    __PROJECT_DIR__: values.projectDir ?? "",
    __INDEX_FILENAME__: INDEX_FILENAME,
    __INDEX_MAX_LINES__: String(values.indexMaxLines),
    __MAX_PINNED__: String(values.maxPinned),
    __FRONTMATTER_TEMPLATE__: FRONTMATTER_TEMPLATE,
    __PINNING_BULLETS__: PINNING_BULLETS
      .replaceAll("__INDEX_FILENAME__", INDEX_FILENAME)
      .replaceAll("__MAX_PINNED__", String(values.maxPinned)),
  };
  for (const [token, value] of Object.entries(replacements)) {
    prompt = prompt.replaceAll(token, () => value);
  }
  return prompt;
}

export interface PolicyPromptOptions {
  /** Absolute user memory directory. */
  userDir: string;
  /** Absolute project memory directory, or undefined when that scope is off. */
  projectDir?: string;
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
    userDir: opts.userDir,
    projectDir: opts.projectDir,
    indexMaxLines: opts.indexMaxLines,
    maxPinned: opts.maxPinned,
  });
}
