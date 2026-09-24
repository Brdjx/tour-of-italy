// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentBuildId, publicEnv } from "../scripts/build-id";

// Next's random build id made every rebuild of the same code look new to the service worker,
// so every deploy asked every traveler to reload. The id must follow the sources, all of them.

let root = "";

function write(path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "build-id-"));
  write("apps/web/app/page.tsx", "export default 1;");
  write("apps/web/public/sw.js", "// worker");
  write("packages/planner/src/plan.ts", "export const x = 1;");
  write("pnpm-lock.yaml", "lockfileVersion: 9");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("contentBuildId", () => {
  it("is the same for two builds of the same sources", () => {
    expect(contentBuildId(root, {})).toBe(contentBuildId(root, {}));
    expect(contentBuildId(root, {})).toMatch(/^c[0-9a-f]{20}$/);
  });

  it.each([
    ["the web app", "apps/web/app/page.tsx"],
    ["the worker template", "apps/web/public/sw.js"],
    ["the planner", "packages/planner/src/plan.ts"],
    ["a dependency version", "pnpm-lock.yaml"],
  ])("changes when %s changes", (_label, path) => {
    const before = contentBuildId(root, {});
    write(path, "changed");
    expect(contentBuildId(root, {})).not.toBe(before);
  });

  it("changes when a NEXT_PUBLIC variable baked into the bundle changes", () => {
    const before = contentBuildId(root, { NEXT_PUBLIC_API_BASE: "" });
    expect(contentBuildId(root, { NEXT_PUBLIC_API_BASE: "https://x" })).not.toBe(before);
    expect(contentBuildId(root, { NEXT_PUBLIC_API_BASE: "", SECRET: "y" })).toBe(before);
  });

  it("ignores tests, docs and dotfiles, which never reach the export", () => {
    const before = contentBuildId(root, {});
    write("apps/web/test/a.test.ts", "x");
    write("README.md", "x");
    write("apps/web/app/.DS_Store", "x");
    expect(contentBuildId(root, {})).toBe(before);
  });

  it("lists only NEXT_PUBLIC variables, sorted", () => {
    expect(publicEnv({ B: "1", NEXT_PUBLIC_Z: "z", NEXT_PUBLIC_A: "a" })).toEqual([
      "NEXT_PUBLIC_A=a",
      "NEXT_PUBLIC_Z=z",
    ]);
  });
});
