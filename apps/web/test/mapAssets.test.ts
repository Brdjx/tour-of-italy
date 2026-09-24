import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLYPHS_PATH, mapStyle, WORKER_PATH } from "../lib/mapStyle";

// The map's files served from public/: MapLibre's worker and the label glyphs. Both are copies of
// files from elsewhere, so these checks fail when a copy is missing or out of date.

const PUBLIC = join(import.meta.dirname, "..", "public");
const DIST = join(import.meta.dirname, "..", "node_modules", "maplibre-gl", "dist");

describe("MapLibre's worker", () => {
  // To refresh after upgrading maplibre-gl, from apps/web:
  //   cp node_modules/maplibre-gl/dist/maplibre-gl-{worker,shared}.mjs public/map/maplibre/
  it.each(["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"])(
    "public/map/maplibre/%s matches the installed maplibre-gl",
    (file) => {
      const copy = readFileSync(join(PUBLIC, "map", "maplibre", file));
      const installed = readFileSync(join(DIST, file));
      expect(copy.equals(installed)).toBe(true);
    },
  );

  it("is where the map looks for it", () => {
    expect(existsSync(join(PUBLIC, WORKER_PATH))).toBe(true);
  });
});

describe("label glyphs", () => {
  it("has every font and range the style asks for, with the font license", () => {
    const style = mapStyle("light", "", { type: "FeatureCollection", features: [] });
    const fonts = new Set<string>();
    for (const layer of style.layers) {
      if (layer.type !== "symbol") continue;
      const font = layer.layout?.["text-font"];
      if (Array.isArray(font)) for (const name of font) fonts.add(String(name));
    }
    expect([...fonts].sort()).toEqual(["Noto Sans Medium", "Noto Sans Regular"]);
    // Latin, Latin Extended (Italian and nearby names) and punctuation such as curly quotes.
    for (const font of fonts) {
      for (const range of ["0-255", "256-511", "8192-8447"]) {
        const path = GLYPHS_PATH.replace("{fontstack}", font).replace("{range}", range);
        expect(existsSync(join(PUBLIC, path)), path).toBe(true);
      }
    }
    expect(readFileSync(join(PUBLIC, "map", "fonts", "OFL.txt"), "utf8")).toContain(
      "SIL Open Font License",
    );
  });
});
