// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
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

/** `fore` at `alpha` over `back`, as a hex colour. */
function blend(fore: string, back: string, alpha: number): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5]
    .map((at) => Math.round(channel(fore, at) * alpha + channel(back, at) * (1 - alpha)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
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

/** The declarations of the first rule whose selector ends with `selector`. */
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`No rule for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

describe("loading skeletons", () => {
  const skeleton = read("styles/skeleton.css");

  it("draws skeletons in the Rule token, so they follow the scheme and never look like content", () => {
    expect(globals).toMatch(/--skeleton: var\(--line\);/);
    expect(block(skeleton, ".skeleton {")).toContain("background: var(--skeleton)");
  });

  it("pulses gently, each cycle under 1.5 s", () => {
    const durations = [...skeleton.matchAll(/animation: skeleton-pulse ([\d.]+)s/g)].map((m) =>
      Number(m[1]),
    );
    expect(durations.length).toBeGreaterThan(0);
    for (const seconds of durations) expect(seconds).toBeLessThan(1.5);
  });

  it("stops every skeleton animation for a traveler who asked for reduced motion", () => {
    const reduced = skeleton.slice(skeleton.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.skeleton,\s*\.skeleton-dot\s*{\s*animation: none;/);
    // Every class that animates is listed in that block.
    const animated = [...skeleton.matchAll(/\.([\w-]+)\s*{[^}]*animation: skeleton-pulse/g)];
    for (const match of animated) expect(reduced).toContain(`.${match[1]}`);
  });

  it("reserves the real sizes: chips and buttons 44 px, fields 48 px, the map its frame", () => {
    expect(block(skeleton, ".skeleton--chip {")).toContain("height: 44px");
    expect(block(skeleton, ".skeleton--button {")).toContain("height: 44px");
    expect(block(skeleton, ".skeleton--field {")).toContain("height: 48px");
    expect(block(skeleton, ".skeleton--fill {")).toContain("height: 100%");
  });
});

describe("layout rules", () => {
  it("keeps focused controls clear of the pinned day tabs, the sticky form bar and the toast", () => {
    const html = globals.slice(globals.indexOf("html {"));
    expect(html).toMatch(/scroll-padding-top: calc\(var\(--safe-top\) \+ \d+px\)/);
    expect(html).toMatch(/scroll-padding-bottom: calc\(var\(--safe-bottom\) \+ \d+px\)/);
  });

  it("keeps the page still behind a sheet where the scrollbar takes room", () => {
    // A sheet stops the page scrolling, which takes a classic scrollbar away; the gutter stays.
    expect(read("styles/sheet.css")).toMatch(
      /html:has\(> body > \.form-sheet\[open\]\) {\s*overflow: hidden;/,
    );
    expect(block(globals, "\nhtml {")).toContain("scrollbar-gutter: stable");
  });

  it("keeps the toast inside the screen and centred on every screen size", () => {
    // It only shows while the form is folded (PlannerApp.fold.test), so it never needs to dodge
    // the sticky Plan my trip bar; a leftover offset for the old side pane would push it off.
    const toast = block(read("styles/overlays.css"), ".toast {");
    expect(toast).toMatch(/left: var\(--gutter-x-left\)/);
    expect(toast).toMatch(/right: var\(--gutter-x-right\)/);
    expect(toast).toContain("margin-inline: auto");
    expect(read("styles/overlays.css")).not.toContain("--form-pane-width");
  });

  it("keeps the header, the content and the footer in one centred column inside the safe areas", () => {
    const layout = read("styles/layout.css");
    const column = block(layout, ".app-footer {");
    expect(column).toContain("max(var(--gutter-x-left), calc((100% - var(--content-max)) / 2))");
    expect(column).toContain("max(var(--gutter-x-right), calc((100% - var(--content-max)) / 2))");
    expect(layout).toMatch(/\.app {\s*--content-max: 560px/);
  });

  it("paints an empty page, never the form, while a shared or saved plan is expected", () => {
    const skeleton = read("styles/skeleton.css");
    expect(skeleton).toMatch(
      /html\[data-expect-plan\] \.app\[data-view="compose"\] \.app-body,[^{]*{\s*display: none;/,
    );
  });

  it.each([
    ["light", light, globals.slice(globals.indexOf(":root {"), globals.indexOf("@media"))],
    [
      "dark",
      dark,
      globals.slice(
        globals.indexOf("@media (prefers-color-scheme: dark)"),
        globals.indexOf("@theme"),
      ),
    ],
  ] as const)("keeps text readable on the edit flash in %s mode", (_scheme, t, css) => {
    // The flash is a token mixed with transparent over the page: blend it, then check the text.
    const mix = css.match(
      /--changed-bg: color-mix\(in srgb, var\(--([\w-]+)\) (\d+)%, transparent\)/,
    );
    expect(mix, "--changed-bg is a color-mix of a token with transparent").not.toBeNull();
    const flash = blend(t[mix?.[1] as string] as string, t.page as string, Number(mix?.[2]) / 100);
    for (const text of ["fg", "muted", "accent"]) {
      expect(contrast(t[text] as string, flash), `${text} on the flash`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
    expect(read("styles/timetable.css")).toContain("background: var(--changed-bg)");
  });
});

describe("the Tricolore Rule", () => {
  // The Italian government's specification (DPCM 14 April 2006, art. 31) gives the flag's
  // colours as Pantone textile 17-6153 (Fern Green), 11-0601 (Bright White) and 18-1662 (Flame
  // Scarlet); these are Pantone's own sRGB values for them.
  const FLAG = { "flag-green": "#008c45", "flag-white": "#f4f5f0", "flag-red": "#cd212a" };

  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("keeps the flag's official colours in %s mode", (_scheme, t) => {
    for (const [token, value] of Object.entries(FLAG)) expect(t[token], token).toBe(value);
  });

  it("uses the flag's colours in the band and the flag mark only", () => {
    const styles = readdirSync(fileURLToPath(new URL("../app/styles/", import.meta.url)));
    expect(styles).toContain("tricolore.css");
    for (const file of styles.filter((name) => name !== "tricolore.css")) {
      expect(read(`styles/${file}`), file).not.toContain("--flag-");
    }
    const tricolore = read("styles/tricolore.css");
    for (const token of Object.keys(FLAG)) expect(tricolore).toContain(`var(--${token})`);
    expect(globals.match(/var\(--flag-/g)).toBeNull();
  });

  it("shows the band and the flag mark at rest for a traveler who asked for reduced motion", () => {
    const tricolore = read("styles/tricolore.css");
    const reduced = tricolore.slice(tricolore.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.tricolore::after\s*{\s*display: none;\s*animation: none;/);
    expect(reduced).toMatch(/\.flag-mark-band\s*{\s*animation: none;/);
    // The band draws with transform alone.
    expect(block(tricolore, "@keyframes tricolore-draw {")).toContain("transform: scaleX(1)");
  });
});

describe("the trip header while a plan is on its way", () => {
  it("dims Edit trip and Copy link to the disabled 40% and lets no press through", () => {
    const rule = block(read("styles/plan.css"), '.head-pill[aria-disabled="true"] {');
    expect(rule).toContain("opacity: 0.4");
    expect(rule).toContain("pointer-events: none");
  });

  it("does not press or light a dimmed pill, from the keyboard either", () => {
    // pointer-events stops the mouse only; a held Space still makes the pill :active.
    const plan = read("styles/plan.css");
    expect(plan).toContain('.head-pill:active:not([aria-disabled="true"]) {');
    expect(plan).toContain('.head-pill:hover:not([aria-disabled="true"]) {');
    expect(plan).not.toMatch(/\.head-pill:(active|hover) {/);
    // Reduced motion stills the press with a rule as specific as the press, or it would lose.
    const reduced = plan.slice(plan.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block(reduced, '.head-pill:active:not([aria-disabled="true"]) {')).toContain(
      "transform: none",
    );
  });
});

describe("a stop's photo", () => {
  const timetable = read("styles/timetable.css");

  it("says it opens something under a pointer: an ink hairline, the photo leaning in", () => {
    const hover = timetable.slice(timetable.indexOf("@media (hover: hover) {\n    .stop-thumb {"));
    expect(block(hover, ".stop-thumb {")).toContain("outline: 1px solid transparent");
    expect(block(hover, ".stop-thumb:hover {")).toContain("outline-color: var(--fg)");
    expect(block(hover, ".stop-thumb:hover .place-photo-img {")).toContain(
      "transform: scale(1.04)",
    );
    expect(block(timetable, ".stop-thumb {")).toContain("cursor: pointer");
    // The focus ring comes after, so a focused photo under the pointer keeps its ring.
    expect(timetable.indexOf(".stop-thumb:focus-visible {")).toBeGreaterThan(
      timetable.indexOf(".stop-thumb:hover {"),
    );
  });

  it("keeps the photo still for a traveler who asked for reduced motion", () => {
    const reduced = timetable.slice(
      timetable.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(block(reduced, ".stop-thumb:hover .place-photo-img {")).toContain("transform: none");
    expect(reduced).toMatch(/\.stop-thumb,[^{]*{\s*transition: none;/);
  });
});
