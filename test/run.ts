/**
 * Test runner. `node test/run.ts` (Node >= 22.18 strips types natively).
 *
 * Prints one line per case with the REQ ids it covers, then a coverage summary
 * so it is visible at a glance which requirements have a passing test.
 */

import { cleanupTempDirs, getTests } from "./harness.ts";

import "./config.test.ts";
import "./frontmatter.test.ts";
import "./scan.test.ts";
import "./inject.test.ts";
import "./selector.test.ts";
import "./doctor.test.ts";
import "./pipeline.test.ts";
import "./hardening.test.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function compareReq(a: string, b: string): number {
  const pa = /^REQ-([A-Z]+)-(\d+)$/.exec(a);
  const pb = /^REQ-([A-Z]+)-(\d+)$/.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  return pa[1] === pb[1]
    ? Number(pa[2]) - Number(pb[2])
    : pa[1].localeCompare(pb[1]);
}

async function main(): Promise<void> {
  const tests = getTests();
  const covered = new Set<string>();
  const failedReqs = new Set<string>();
  let passed = 0;
  const failures: Array<{ name: string; error: unknown }> = [];

  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      for (const r of t.reqs) covered.add(r);
      console.log(
        `${GREEN}pass${RESET} ${t.name} ${DIM}[${t.reqs.join(", ")}]${RESET}`,
      );
    } catch (error) {
      failures.push({ name: t.name, error });
      for (const r of t.reqs) failedReqs.add(r);
      console.log(
        `${RED}FAIL${RESET} ${t.name} ${DIM}[${t.reqs.join(", ")}]${RESET}`,
      );
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.log(
        message
          .split("\n")
          .map((l) => `       ${l}`)
          .join("\n"),
      );
    }
  }

  cleanupTempDirs();

  const fullyCovered = [...covered]
    .filter((r) => !failedReqs.has(r))
    .sort(compareReq);
  console.log("");
  console.log(`${passed}/${tests.length} cases passed`);
  console.log(
    `REQs covered by passing tests (${fullyCovered.length}): ${fullyCovered.join(", ")}`,
  );
  if (failedReqs.size > 0) {
    console.log(
      `${RED}REQs with failing tests: ${[...failedReqs].sort(compareReq).join(", ")}${RESET}`,
    );
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
