import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Where the eval package keeps its inputs and outputs. Resolved from this file, so every command
// works from any working directory (pnpm runs package scripts from the package folder, vitest
// from the repo root).

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const PATHS = {
  cases: join(PACKAGE_ROOT, "cases"),
  recordings: join(PACKAGE_ROOT, "recordings"),
  results: join(PACKAGE_ROOT, "results"),
} as const;

/** The report every run regenerates. */
export const LATEST_REPORT = "latest.md";
