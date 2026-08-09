/**
 * Test runner. `node test/run.ts` (Node >= 22.18 strips types natively).
 *
 * Prints one line per case and a summary of the passing cases.
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
const RESET = "\x1b[0m";

async function main(): Promise<void> {
  const tests = getTests();
  let passed = 0;
  const failures: Array<{ name: string; error: unknown }> = [];

  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`${GREEN}pass${RESET} ${t.name}`);
    } catch (error) {
      failures.push({ name: t.name, error });
      console.log(`${RED}FAIL${RESET} ${t.name}`);
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

  console.log("");
  console.log(`${passed}/${tests.length} cases passed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
