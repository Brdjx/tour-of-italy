// A Next.js build id derived from the sources, so two builds of the same code produce the same
// files. Next's default id is random; it is written into index.html and a /_next/static folder
// name, so every build changed the service worker's precache list and hash, and every deploy
// (including API-only ones) asked every traveler to reload and re-download the app.
//
// The id hashes everything that shapes the export: the web app's sources and public files, the
// planner's sources, the lockfile (dependency versions, Next itself), the shared TypeScript
// settings, and the NEXT_PUBLIC_* variables baked into the bundle.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Paths hashed, relative to the repo root. Directories are walked; dotfiles are skipped. */
export const BUILD_INPUTS = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/web/public",
  "apps/web/next.config.ts",
  "apps/web/package.json",
  "apps/web/postcss.config.mjs",
  "apps/web/tsconfig.json",
  "packages/planner/src",
  "packages/planner/package.json",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
] as const;

function filesUnder(path: string): string[] {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return [path];
  const out: string[] = [];
  for (const entry of readdirSync(path).sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    out.push(...filesUnder(join(path, entry)));
  }
  return out;
}

/** "NEXT_PUBLIC_API_BASE=..." lines, sorted, for the variables Next inlines into the bundle. */
export function publicEnv(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith("NEXT_PUBLIC_"))
    .sort()
    .map((key) => `${key}=${env[key] ?? ""}`);
}

/** The build id for the repo at `root`: "c" and 20 hex characters. */
export function contentBuildId(
  root: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const hash = createHash("sha256");
  for (const input of BUILD_INPUTS) {
    for (const file of filesUnder(join(root, input))) {
      hash.update(`\0${relative(root, file).split(sep).join("/")}\0`);
      hash.update(readFileSync(file));
    }
  }
  for (const line of publicEnv(env)) hash.update(`\0env\0${line}`);
  return `c${hash.digest("hex").slice(0, 20)}`;
}
