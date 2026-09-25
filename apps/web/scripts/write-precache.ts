// Runs after `next build`: writes the precache list, the build id, and the SHA-256 of the app
// shell into out/sw.js.
// Usage: node scripts/write-precache.ts [outDir]   (defaults to apps/web/out)
//
// The list is an allowlist: the app shell ("/" for index.html), everything under
// /_next/static except source maps, the web app manifest, and the app icons. Never the worker
// itself, React Server Component payloads (*.txt), 404 pages, or dotfiles.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

export const SW_FILE = "sw.js";

const BUILD_ID_LINE = /^const BUILD_ID = "[^"\n]*";$/m;
const PRECACHE_LINE = /^const PRECACHE_URLS = \[\];$/m;
const SHELL_LINE = /^const SHELL_SHA256 = "";$/m;

/** The URL a file in out/ is precached under, or null when it is not precached. */
export function precacheUrlFor(file: string): string | null {
  if (file === "index.html") return "/";
  if (file.split("/").some((part) => part.startsWith("."))) return null;
  // Decision: not MapLibre's own .mjs files, which the bundler copies into _next/static/media
  // because the package names its worker by URL (about 3.5 MB, development builds included). The
  // page never requests them: the map runs its worker from the copies under /map/maplibre/,
  // which are precached below.
  if (file.startsWith("_next/static/media/") && file.endsWith(".mjs")) return null;
  if (file.startsWith("_next/static/")) return file.endsWith(".map") ? null : `/${file}`;
  if (file === "manifest.webmanifest") return "/manifest.webmanifest";
  if (file.startsWith("icons/") && /\.(png|svg)$/.test(file)) return `/${file}`;
  // The map's worker and its glyphs, so an offline plan still draws its route and stops (the
  // basemap tiles are never precached: 140 MB). Glyph folders have spaces in their names, and
  // MapLibre asks for them percent-encoded, so the URL is encoded the same way.
  if (file.startsWith("map/maplibre/") && file.endsWith(".mjs")) return `/${file}`;
  if (file.startsWith("map/fonts/") && file.endsWith(".pbf")) {
    return `/${file.split("/").map(encodeURIComponent).join("/")}`;
  }
  return null;
}

/** Sorted, de-duplicated precache URLs for a list of out/-relative POSIX paths. */
export function precacheUrls(files: readonly string[]): string[] {
  const urls = new Set<string>();
  for (const file of files) {
    const url = precacheUrlFor(file);
    if (url !== null) urls.add(url);
  }
  return [...urls].sort();
}

/** The out/-relative file behind a precache URL. */
export function fileForUrl(url: string): string {
  return url === "/" ? "index.html" : decodeURIComponent(url.slice(1));
}

// Decision: the build id is a hash of the worker template and every precached file. It changes
// exactly when something the worker serves changes. Identical rebuilds do not ask anyone to
// reload because Next's own build id (written into index.html) is also derived from the sources
// (scripts/build-id.ts, next.config.ts), so the exported files are byte-identical.
export function buildIdFor(
  template: string,
  entries: readonly { url: string; bytes: Uint8Array }[],
): string {
  const hash = createHash("sha256");
  hash.update(template);
  for (const entry of entries) {
    hash.update(`\0${entry.url}\0`);
    hash.update(entry.bytes);
  }
  return hash.digest("hex").slice(0, 16);
}

/** SHA-256 of the shell, which the worker checks before it caches "/". */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The worker source with the build id, list and shell hash written in. Throws on missing markers. */
export function injectPrecache(
  source: string,
  buildId: string,
  urls: readonly string[],
  shellSha256: string,
): string {
  if (!BUILD_ID_LINE.test(source) || !PRECACHE_LINE.test(source) || !SHELL_LINE.test(source)) {
    throw new Error(
      `${SW_FILE} has no empty BUILD_ID, PRECACHE_URLS and SHELL_SHA256 lines to fill in. It may already be written; run next build again.`,
    );
  }
  if (!/^[a-z0-9-]{1,64}$/.test(buildId)) throw new Error(`Bad build id: ${buildId}`);
  if (!/^[0-9a-f]{64}$/.test(shellSha256)) throw new Error(`Bad shell hash: ${shellSha256}`);
  for (const url of urls) {
    if (!url.startsWith("/") || /["'\\\s]/.test(url)) throw new Error(`Bad precache URL: ${url}`);
  }
  // Replacer functions, so a "$" in a file name is copied as is.
  return source
    .replace(BUILD_ID_LINE, () => `const BUILD_ID = ${JSON.stringify(buildId)};`)
    .replace(PRECACHE_LINE, () => `const PRECACHE_URLS = ${JSON.stringify(urls)};`)
    .replace(SHELL_LINE, () => `const SHELL_SHA256 = "${shellSha256}";`);
}

/** Every file under `dir`, as POSIX paths relative to it. */
export function listFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  return entries
    .filter((entry) => statSync(join(dir, entry)).isFile())
    .map((entry) => entry.split(sep).join("/"));
}

export interface PrecacheResult {
  buildId: string;
  urls: string[];
  bytes: number;
}

/** Reads `outDir`, fills in out/sw.js, and returns what was written. */
export function writePrecache(outDir: string): PrecacheResult {
  const urls = precacheUrls(listFiles(outDir));
  if (!urls.includes("/")) throw new Error(`${outDir} has no index.html to use as the app shell`);
  if (!urls.some((url) => url.startsWith("/_next/static/"))) {
    throw new Error(`${outDir} has no /_next/static files; is this a Next.js export?`);
  }
  const entries = urls.map((url) => ({ url, bytes: readFileSync(join(outDir, fileForUrl(url))) }));
  const swPath = join(outDir, SW_FILE);
  const template = readFileSync(swPath, "utf8");
  const buildId = buildIdFor(template, entries);
  const shell = readFileSync(join(outDir, fileForUrl("/")));
  writeFileSync(swPath, injectPrecache(template, buildId, urls, sha256Hex(shell)));
  const bytes = entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
  return { buildId, urls, bytes };
}

if (import.meta.main) {
  const outDir = process.argv[2] ?? join(import.meta.dirname, "..", "out");
  const result = writePrecache(outDir);
  const size = (result.bytes / 1024).toFixed(0);
  console.log(`${SW_FILE}: build ${result.buildId}, ${result.urls.length} files (${size} KB)`);
}
