// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Rules jsdom cannot see because it has no layout: colour contrast of the design tokens in both
// schemes, focus kept clear of pinned bars, and the toast kept off the "Plan my trip" button.
// Each guards a failure found in a real browser.

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../app/${path}`, import.meta.url)), "utf8");
const globals = read("globals.css");

/** Token values from a block of CSS custom properties. */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)) {
    out[match[1] as string] = (match[2] as string).toLowerCase();
  }
  return out;
}

const light = tokens(globals.slice(globals.indexOf(":root {"), globals.indexOf("@media")));
const dark = {
  ...light,
  ...tokens(
    globals.slice(
      globals.indexOf("@media (prefers-color-scheme: dark)"),
      globals.indexOf("@theme"),
    ),
  ),
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r as number) + 0.7152 * f(g as number) + 0.0722 * f(b as number);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("design tokens", () => {
  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("keep text, borders and focus rings readable in %s mode", (_scheme, t) => {
    const pairs: Array<[string, string, number]> = [
      ["fg", "page", 4.5],
      ["muted", "page", 4.5],
      ["muted", "surface", 4.5],
      ["accent", "page", 4.5],
      ["danger", "page", 4.5],
      ["line-strong", "page", 3],
      ["line-strong", "surface", 3], // input borders on the input fill
      ["focus", "page", 3],
      ["toast-fg", "toast-bg", 4.5],
      ["toast-accent", "toast-bg", 4.5],
      ["toast-focus", "toast-bg", 3], // the Undo focus ring on the toast
    ];
    for (const [fore, back, min] of pairs) {
      const ratio = contrast(t[fore] as string, t[back] as string);
      expect(ratio, `${fore} on ${back}`).toBeGreaterThanOrEqual(min);
    }
  });

  it("paints the installed iOS status bar strip dark enough for its white text in light mode", () => {
    expect(contrast("#ffffff", light["status-bar"] as string)).toBeGreaterThanOrEqual(4.5);
    expect(read("styles/pwa.css")).toMatch(
      /@media \(display-mode: standalone\)\s*{\s*\.status-scrim\s*{\s*background: var\(--status-bar\)/,
    );
  });
});

describe("layout rules", () => {
  it("keeps focused controls clear of the pinned day tabs, the sticky form bar and the toast", () => {
    const html = globals.slice(globals.indexOf("html {"));
    expect(html).toMatch(/scroll-padding-top: calc\(var\(--safe-top\) \+ \d+px\)/);
    expect(html).toMatch(/scroll-padding-bottom: calc\(var\(--safe-bottom\) \+ \d+px\)/);
  });

  it("centres the toast over the plan pane from 1024 px, off the form's Plan button", () => {
    const overlays = read("styles/overlays.css");
    const wide = overlays.slice(overlays.indexOf("@media (min-width: 1024px)"));
    expect(wide).toMatch(/\.toast\s*{\s*left: calc\(var\(--form-pane-width\) \+ \d+px\)/);
    expect(read("styles/layout.css")).toContain("minmax(340px, var(--form-pane-width))");
  });

  it("uses a softer edit flash in dark mode so text on it stays readable", () => {
    const darkBlock = globals.slice(globals.indexOf("@media (prefers-color-scheme: dark)"));
    expect(darkBlock).toMatch(/--changed-bg: color-mix\(in srgb, var\(--warn\) 18%/);
    expect(read("styles/timetable.css")).toContain("background: var(--changed-bg)");
  });
});
