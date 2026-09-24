import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatJson, LINE_WIDTH } from "../src/jsonFile";
import { PATHS } from "../src/paths";
import { filesUnder } from "./helpers";

// Recordings are written by code and committed, and `pnpm lint` runs Biome over them. If the
// writer's layout drifted from Biome's, every live run would leave the repo failing lint.

describe("formatJson", () => {
  it("keeps objects expanded and puts a short array of strings on one line, as Biome does", () => {
    expect(formatJson({ a: { b: 1 }, list: ["x", "y"], empty: [], none: {} })).toBe(
      '{\n  "a": {\n    "b": 1\n  },\n  "list": ["x", "y"],\n  "empty": [],\n  "none": {}\n}\n',
    );
  });

  it("breaks an array that would run past the line width, one item a line", () => {
    const long = Array.from({ length: 12 }, (_, i) => `interest-${i}`);
    const text = formatJson({ interests: long });
    expect(text.split("\n").every((line) => line.length <= LINE_WIDTH)).toBe(true);
    expect(text).toContain('\n    "interest-0",\n');
  });

  it("counts the trailing comma when deciding whether an array fits", () => {
    // Exactly 100 characters with the indent and key: Biome keeps that on one line as the last
    // field, and breaks it when a comma follows (checked against Biome itself).
    const items = ["a".repeat(40), "b".repeat(45)];
    expect(formatJson({ k: items })).toContain('"k": ["');
    expect(formatJson({ k: items, z: 1 })).toContain('"k": [\n');
  });

  it("drops undefined fields and keeps every other value exactly", () => {
    const value = {
      a: 'é €, "quoted"\n',
      b: null,
      c: undefined,
      d: [1, true, "x"],
      e: { f: 0.25 },
    };
    const { c: _dropped, ...rest } = value;
    expect(JSON.parse(formatJson(value))).toEqual(rest);
  });

  it("matches every committed recording byte for byte, so the files are what the writer makes", () => {
    const files = filesUnder(PATHS.recordings);
    expect(files.length).toBeGreaterThan(0);
    for (const { path } of files) {
      const text = readFileSync(path, "utf8");
      expect(formatJson(JSON.parse(text)), path).toBe(text);
    }
  });
});
