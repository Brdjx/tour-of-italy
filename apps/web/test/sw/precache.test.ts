// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIdFor,
  fileForUrl,
  injectPrecache,
  precacheUrls,
  sha256Hex,
  writePrecache,
} from "../../scripts/write-precache";
import { loadWorker, SW_PATH } from "./harness";

// The post-build step that fills in out/sw.js. What would break the product: precaching the
// worker itself or a page payload that goes stale, shipping a worker with an empty list (no
// offline shell), a cache name that does not change when the files change (travelers stuck on
// old scripts), or a file name that corrupts the worker's source.

const TEMPLATE = readFileSync(SW_PATH, "utf8");
const HASH = "a".repeat(64);
const dirs: string[] = [];

/** A fake export folder with the given files, plus the untouched worker template. */
function exportDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "italy-precache-"));
  dirs.push(dir);
  for (const [path, body] of Object.entries({ ...files, "sw.js": TEMPLATE })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const EXPORT = {
  "index.html": "<html>shell</html>",
  "index.txt": "rsc payload",
  "404.html": "not found",
  "404/index.html": "not found",
  "_not-found/index.html": "not found",
  "__next._tree.txt": "tree",
  "_next/static/chunks/app.js": "app",
  "_next/static/chunks/app.js.map": "map",
  "_next/static/chunks/style.css": "css",
  "_next/static/media/font.woff2": "font",
  "_next/static/BUILD/_buildManifest.js": "manifest",
  "manifest.webmanifest": "{}",
  "icons/icon-192.png": "png",
  "icons/icon.svg": "<svg/>",
  "icons/notes.txt": "not an icon",
  ".DS_Store": "junk",
  "_next/static/.hidden": "junk",
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The BUILD_ID and PRECACHE_URLS of a written worker, read by running it. */
function written(dir: string) {
  return loadWorker({ source: readFileSync(join(dir, "sw.js"), "utf8") }).constants;
}

describe("precacheUrls", () => {
  it("lists the shell, hashed files, manifest and icons, and nothing that would go stale or leak", () => {
    expect(precacheUrls(Object.keys(EXPORT))).toEqual([
      "/",
      "/_next/static/BUILD/_buildManifest.js",
      "/_next/static/chunks/app.js",
      "/_next/static/chunks/style.css",
      "/_next/static/media/font.woff2",
      "/icons/icon-192.png",
      "/icons/icon.svg",
      "/manifest.webmanifest",
    ]);
  });

  it("precaches the map's worker and glyphs, encoded as MapLibre asks for them, never the tiles", () => {
    expect(
      precacheUrls([
        "map/maplibre/maplibre-gl-worker.mjs",
        "map/fonts/Noto Sans Regular/0-255.pbf",
        "map/fonts/OFL.txt",
        "tiles/italy-20260924.pmtiles",
        "photos/place_001-960.jpg",
      ]),
    ).toEqual([
      "/map/fonts/Noto%20Sans%20Regular/0-255.pbf",
      "/map/maplibre/maplibre-gl-worker.mjs",
    ]);
    expect(fileForUrl("/map/fonts/Noto%20Sans%20Regular/0-255.pbf")).toBe(
      "map/fonts/Noto Sans Regular/0-255.pbf",
    );
  });

  it("skips MapLibre's module copies the bundler emits, which the page never requests", () => {
    expect(
      precacheUrls([
        "_next/static/media/maplibre-gl-dev.1a7yrl5a26dr.mjs",
        "_next/static/media/maplibre-gl-shared.1r29hqy9wgt8.mjs",
        "_next/static/media/5c3f0cbfabc360d6.p.2y0k55p9r2gow.woff2",
        "_next/static/chunks/28xiaqih7u8.js",
      ]),
    ).toEqual([
      "/_next/static/chunks/28xiaqih7u8.js",
      "/_next/static/media/5c3f0cbfabc360d6.p.2y0k55p9r2gow.woff2",
    ]);
  });

  it("never precaches the worker itself, whatever folder it is in", () => {
    expect(precacheUrls(["sw.js", "_next/static/sw.js.map", "icons/sw.js"])).toEqual([]);
  });
});

describe("writePrecache", () => {
  it("writes a worker that precaches the export under a hash-based cache name", () => {
    const dir = exportDir(EXPORT);
    const result = writePrecache(dir);
    const worker = written(dir);
    expect(worker.PRECACHE_URLS).toEqual(result.urls);
    expect(worker.BUILD_ID).toBe(result.buildId);
    expect(worker.BUILD_ID).toMatch(/^[0-9a-f]{16}$/);
    expect(worker.SHELL_CACHE).toBe(`italy-planner-shell-${result.buildId}`);
    expect(worker.SHELL_SHA256).toBe(sha256Hex(new TextEncoder().encode(EXPORT["index.html"])));
  });

  it("changes the cache name when any precached file changes, and only then", () => {
    const first = writePrecache(exportDir(EXPORT)).buildId;
    const same = writePrecache(exportDir(EXPORT)).buildId;
    const newScript = writePrecache(
      exportDir({ ...EXPORT, "_next/static/chunks/app.js": "app v2" }),
    ).buildId;
    const newShell = writePrecache(
      exportDir({ ...EXPORT, "index.html": "<html>v2</html>" }),
    ).buildId;
    const payloadOnly = writePrecache(exportDir({ ...EXPORT, "index.txt": "other" })).buildId;
    expect(same).toBe(first);
    expect(newScript).not.toBe(first);
    expect(newShell).not.toBe(first);
    expect(payloadOnly).toBe(first);
  });

  it("refuses an export with no app shell, so a worker can never ship without offline support", () => {
    const { "index.html": _shell, ...rest } = EXPORT;
    expect(() => writePrecache(exportDir(rest))).toThrow(/index.html/);
  });

  it("refuses an export with no hashed scripts", () => {
    expect(() => writePrecache(exportDir({ "index.html": "<html></html>" }))).toThrow(
      /_next\/static/,
    );
  });

  it("refuses to run twice on the same worker instead of writing a second list", () => {
    const dir = exportDir(EXPORT);
    writePrecache(dir);
    expect(() => writePrecache(dir)).toThrow(/already be written/);
  });
});

describe("injectPrecache", () => {
  it("copies a dollar sign in a file name as is instead of expanding it", () => {
    const source = injectPrecache(TEMPLATE, "abc123", ["/", "/_next/static/chunks/$&$1.js"], HASH);
    const worker = loadWorker({ source }).constants;
    expect(worker.PRECACHE_URLS).toEqual(["/", "/_next/static/chunks/$&$1.js"]);
  });

  it("rejects a URL that could break out of the worker's source", () => {
    for (const bad of ['/a".js', "/a'.js", "/a\\.js", "/a b.js", "relative.js", "/a\n.js"]) {
      expect(() => injectPrecache(TEMPLATE, "abc123", [bad], HASH)).toThrow(/Bad precache URL/);
    }
  });

  it("rejects a shell hash that is not a SHA-256 in hex", () => {
    for (const bad of ["", "abc", HASH.toUpperCase(), `${HASH}"`]) {
      expect(() => injectPrecache(TEMPLATE, "abc123", ["/"], bad)).toThrow(/Bad shell hash/);
    }
  });

  it("rejects a build id that is not a short lowercase token", () => {
    for (const bad of ["", "ABC", 'x";alert(1);"', "a".repeat(65)]) {
      expect(() => injectPrecache(TEMPLATE, bad, ["/"], HASH)).toThrow(/Bad build id/);
    }
  });

  it("leaves the rest of the worker byte for byte", () => {
    const source = injectPrecache(TEMPLATE, "abc123", ["/"], HASH);
    const strip = (text: string) =>
      text.replace(/^const (BUILD_ID|PRECACHE_URLS|SHELL_SHA256) = .*$/gm, "");
    expect(strip(source)).toBe(strip(TEMPLATE));
  });
});

describe("buildIdFor", () => {
  it("depends on file names as well as contents, so a rename is a new build", () => {
    const bytes = new TextEncoder().encode("same");
    expect(buildIdFor("t", [{ url: "/a.js", bytes }])).not.toBe(
      buildIdFor("t", [{ url: "/b.js", bytes }]),
    );
  });

  it("depends on the worker template, so a worker change is a new cache", () => {
    const entries = [{ url: "/", bytes: new TextEncoder().encode("x") }];
    expect(buildIdFor("v1", entries)).not.toBe(buildIdFor("v2", entries));
  });
});
