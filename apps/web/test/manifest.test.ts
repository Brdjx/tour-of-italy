// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import manifest, { dynamic } from "../app/manifest";

// The web app manifest and the committed icons. What would break installation: a missing
// required field, an icon path that 404s, a PNG whose real size differs from what the manifest
// claims (browsers skip it), a maskable icon with transparent corners (Android shows a black or
// white ring), or theme colours that drift from the design tokens.

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const PUBLIC = here("../public");
const m = manifest();

interface Png {
  width: number;
  height: number;
  colorType: number;
  /** The first pixel's channel values (R, G, B and, for RGBA, A). */
  firstPixel: number[];
}

/** Reads a non-interlaced 8-bit PNG far enough to know its size and top-left pixel. */
function readPng(path: string): Png {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25] ?? -1;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  // Row 0, pixel 0 is the same under every PNG filter (its left and upper neighbours are 0).
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, colorType, firstPixel: [...raw.subarray(1, 1 + channels)] };
}

function publicFile(src: string): string {
  return `${PUBLIC}${src}`;
}

describe("web app manifest", () => {
  it("is built at build time so the static export can serve it", () => {
    expect(dynamic).toBe("force-static");
  });

  it("has every field an install prompt needs", () => {
    expect(m).toMatchObject({
      id: "/",
      name: "3 Days in Italy",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    // Launchers cut names longer than about 12 characters.
    expect(m.short_name?.length).toBeGreaterThan(0);
    expect(m.short_name?.length).toBeLessThanOrEqual(12);
  });

  it("uses the Stone page colour from the design tokens", () => {
    const css = readFileSync(here("../app/globals.css"), "utf8");
    const stone = /--page:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
    expect(stone).toBeDefined();
    expect(m.theme_color).toBe(stone);
    expect(m.background_color).toBe(stone);
  });

  it("lists 192 and 512 icons for any use and a 512 maskable icon", () => {
    const icons = m.icons ?? [];
    const has = (sizes: string, purpose: string) =>
      icons.some((icon) => icon.sizes === sizes && icon.purpose === purpose);
    expect(has("192x192", "any")).toBe(true);
    expect(has("512x512", "any")).toBe(true);
    expect(has("512x512", "maskable")).toBe(true);
  });

  it.each((m.icons ?? []).map((icon) => [icon.src, icon] as const))(
    "points %s at a committed PNG of exactly the size it claims",
    (src, icon) => {
      expect(existsSync(publicFile(src))).toBe(true);
      const png = readPng(publicFile(src));
      expect(`${png.width}x${png.height}`).toBe(icon.sizes);
      expect(icon.type).toBe("image/png");
    },
  );
});

describe("icons", () => {
  it("draws the maskable icon full bleed, so Android's crop never shows a transparent ring", () => {
    const png = readPng(publicFile("/icons/icon-maskable-512.png"));
    expect(png.colorType === 2 || png.firstPixel[3] === 255).toBe(true);
  });

  it("draws the Apple touch icon full bleed at 180 px, since iOS turns transparency black", () => {
    const png = readPng(publicFile("/icons/apple-touch-icon-180.png"));
    expect([png.width, png.height]).toEqual([180, 180]);
    expect(png.colorType === 2 || png.firstPixel[3] === 255).toBe(true);
  });

  it("gives the plain icons transparent rounded corners", () => {
    for (const file of ["icon-32.png", "icon-192.png", "icon-512.png"]) {
      const png = readPng(publicFile(`/icons/${file}`));
      expect(png.colorType).toBe(6);
      expect(png.firstPixel[3]).toBe(0);
    }
  });

  it("links the icons the layout names, so browsers never request a missing file", () => {
    const layout = readFileSync(here("../app/layout.tsx"), "utf8");
    const linked = [...layout.matchAll(/url: "(\/icons\/[^"]+)"/g)].map((match) => match[1]);
    expect(linked).toEqual([
      "/icons/icon.svg",
      "/icons/icon-32.png",
      "/icons/apple-touch-icon-180.png",
    ]);
    for (const src of linked) expect(existsSync(publicFile(src ?? ""))).toBe(true);
  });
});
