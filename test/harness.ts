/**
 * Minimal headless test harness.
 *
 * No dependencies: the pure extension modules import nothing but `node:*`, so
 * `node test/run.ts` exercises every requirement outside SPEC.md §11's
 * interactive list without a pi process and without network access.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TestCase {
  /** REQ ids this case covers. Printed with the result. */
  reqs: string[];
  name: string;
  fn: () => void | Promise<void>;
}

const registry: TestCase[] = [];

export function test(reqs: string | string[], name: string, fn: TestCase["fn"]): void {
  registry.push({ reqs: Array.isArray(reqs) ? reqs : [reqs], name, fn });
}

export function getTests(): TestCase[] {
  return registry;
}

export class AssertionError extends Error {}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionError(message);
}

export function assertEqual<T>(actual: T, expected: T, message = ""): void {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(
      `${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

export function assertDeepEqual(actual: unknown, expected: unknown, message = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new AssertionError(`${message}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

export function assertIncludes(haystack: string, needle: string, message = ""): void {
  if (!haystack.includes(needle)) {
    throw new AssertionError(
      `${message}\n  expected to find: ${JSON.stringify(needle)}\n  in: ${JSON.stringify(
        haystack.length > 600 ? `${haystack.slice(0, 600)}…` : haystack,
      )}`,
    );
  }
}

export function assertNotIncludes(haystack: string, needle: string, message = ""): void {
  if (haystack.includes(needle)) {
    throw new AssertionError(`${message}\n  expected NOT to find: ${JSON.stringify(needle)}`);
  }
}

export async function assertThrows(fn: () => unknown, message = ""): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new AssertionError(`${message}\n  expected the call to throw`);
}

// ---------------------------------------------------------------------------
// Temp-directory fixtures
// ---------------------------------------------------------------------------

const created: string[] = [];

export function makeTempDir(prefix = "pi-memory-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Write a file, creating parent directories, and optionally back-date it. */
export function writeFile(path: string, content: string, ageDays?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  if (ageDays !== undefined) backdate(path, ageDays);
}

/** Set a file's mtime/atime `days` in the past. */
export function backdate(path: string, days: number): void {
  const when = new Date(Date.now() - days * 86400000);
  utimesSync(path, when, when);
}

export function writeMemory(
  root: string,
  relPath: string,
  opts: {
    name?: string;
    description?: string;
    type?: string;
    pinned?: unknown;
    body?: string;
    ageDays?: number;
    /** Raw content overriding all frontmatter fields. */
    raw?: string;
  } = {},
): string {
  const path = join(root, relPath);
  if (opts.raw !== undefined) {
    writeFile(path, opts.raw, opts.ageDays);
    return path;
  }
  const fm: string[] = ["---"];
  if (opts.name !== undefined) fm.push(`name: ${opts.name}`);
  if (opts.description !== undefined) fm.push(`description: ${opts.description}`);
  if (opts.type !== undefined || opts.pinned !== undefined) {
    fm.push("metadata:");
    if (opts.type !== undefined) fm.push(`  type: ${opts.type}`);
    if (opts.pinned !== undefined) fm.push(`  pinned: ${String(opts.pinned)}`);
  }
  fm.push("---", "");
  writeFile(path, `${fm.join("\n")}\n${opts.body ?? "body text"}\n`, opts.ageDays);
  return path;
}
