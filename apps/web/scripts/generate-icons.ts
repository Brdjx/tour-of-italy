// Draws every PNG app icon from public/icons/icon.svg with a headless Chromium screenshot, so
// there is one source image and no image library. Run after changing the SVG, then commit the
// PNGs:  pnpm --filter @italy/web icons

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

// "rounded" icons have transparent corners for places that show the image as is (desktop
// windows, the browser tab). "square" icons are full bleed: the maskable icon, which Android
// crops to its own shape, and the Apple touch icon, which iOS rounds itself and would
// otherwise show with black corners.
export const ICONS = [
  { file: "icon-32.png", size: 32, shape: "rounded" },
  { file: "icon-192.png", size: 192, shape: "rounded" },
  { file: "icon-512.png", size: 512, shape: "rounded" },
  { file: "icon-maskable-512.png", size: 512, shape: "square" },
  { file: "apple-touch-icon-180.png", size: 180, shape: "square" },
] as const;

/** Corner radius of the rounded icons, as a share of the width. */
export const CORNER_RADIUS = 0.2;

export function iconPage(svg: string, size: number, shape: "rounded" | "square"): string {
  const radius = shape === "rounded" ? Math.round(size * CORNER_RADIUS) : 0;
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return `<!doctype html><html><body style="margin:0;background:transparent">
<img src="${src}" width="${size}" height="${size}" style="display:block;border-radius:${radius}px">
</body></html>`;
}

async function main(): Promise<void> {
  const dir = join(import.meta.dirname, "..", "public", "icons");
  const svg = readFileSync(join(dir, "icon.svg"), "utf8");
  const browser = await chromium.launch();
  try {
    for (const icon of ICONS) {
      const page = await browser.newPage({
        viewport: { width: icon.size, height: icon.size },
        deviceScaleFactor: 1,
      });
      await page.setContent(iconPage(svg, icon.size, icon.shape));
      await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
      const png = await page.screenshot({ omitBackground: icon.shape === "rounded" });
      writeFileSync(join(dir, icon.file), png);
      await page.close();
      console.log(`wrote ${icon.file} (${icon.size}x${icon.size})`);
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.main) await main();
