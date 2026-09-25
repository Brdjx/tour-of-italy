import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

// Page audits shared by the accessibility and layout specs: axe, horizontal overflow, zoom,
// touch target size, and the text size of fields.

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * An axe finding that WCAG itself exempts: a map stop under target-size. Where a day's stops
 * crowd together, their 44 px targets overlap one another. WCAG 2.5.8 exempts them twice over: a
 * stop's place on the map is the information it gives (Essential), and every stop's details open
 * from its Details button on the board, a full-size target (Equivalent). The full-screen map
 * spreads them apart too.
 */
function exempt(rule: string, node: { html: string }): boolean {
  return rule === "target-size" && node.html.includes('data-testid="map-stop"');
}

/** Fails on any serious or critical axe violation, listing each rule with its first targets. */
export async function expectNoSeriousA11yIssues(page: Page, state: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const serious = result.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      ...violation,
      nodes: violation.nodes.filter((node) => !exempt(violation.id, node)),
    }))
    .filter((violation) => violation.nodes.length > 0)
    .map((violation) => {
      const targets = violation.nodes
        .slice(0, 3)
        .map((node) => `${node.target.join(" ")} [${node.failureSummary?.replace(/\s+/g, " ")}]`);
      return `${violation.id} (${violation.impact}): ${targets.join(" | ")}`;
    });
  expect(serious, `serious or critical accessibility issues: ${state}`).toEqual([]);
}

/** The project's screen width in CSS px. */
function screenWidth(page: Page): number {
  const viewport = page.viewportSize();
  expect(viewport, "the project has no viewport size").not.toBeNull();
  return viewport?.width ?? 0;
}

/**
 * Pixels the page is wider than the screen (0 when there is no horizontal scroll).
 * Decision: measured against the layout width (the root's clientWidth, capped at the screen
 * width), never window.innerWidth. Mobile Chromium zooms a page out to fit anything too wide,
 * and innerWidth grows with it, so on the Pixel 7 a 700 px block measured as no overflow at all.
 */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate((screen) => {
    const root = document.documentElement;
    const widest = Math.max(root.scrollWidth, document.body.scrollWidth);
    return Math.max(0, widest - Math.min(root.clientWidth, screen));
  }, screenWidth(page));
}

/** How far the browser zoomed the page out to fit it: the visible width minus the screen's. */
export async function zoomedOutBy(page: Page): Promise<number> {
  const inner = await page.evaluate(() => window.innerWidth);
  return Math.max(0, inner - screenWidth(page));
}

/**
 * Visible text fields, selects and text areas whose text is under 16 px, as "id size". iOS
 * zooms the page in when such a field takes focus, and does not zoom back out.
 */
export async function smallFieldText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector =
      'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]), select, textarea';
    const small: string[] = [];
    for (const field of document.querySelectorAll<HTMLElement>(selector)) {
      if (field.getClientRects().length === 0) continue; // not rendered
      const size = Number.parseFloat(getComputedStyle(field).fontSize);
      if (size < 16) small.push(`${field.id || field.tagName.toLowerCase()} ${size}px`);
    }
    return small;
  });
}

/**
 * Visible interactive elements smaller than `min` px in either direction, as "name WxH".
 * Radio buttons and checkboxes are drawn as their whole label, so the label is measured. The
 * map's stops, a stop's popup and Expand map count like any other control. MapLibre's own
 * credits button is left out: it is out of the tab order and hidden from screen readers, and
 * the caption under the map has the same credits as links.
 */
export async function smallTargets(page: Page, min = 44): Promise<string[]> {
  return page.evaluate((size) => {
    const selector =
      'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="tab"], [role="option"], [tabindex="0"]';
    const small: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (element.closest(".maplibregl-control-container, [hidden], [inert]")) continue;
      const input = element instanceof HTMLInputElement ? element : null;
      const drawn =
        input && (input.type === "radio" || input.type === "checkbox")
          ? (input.closest("label") ?? input)
          : element;
      const style = getComputedStyle(drawn);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const box = drawn.getBoundingClientRect();
      // Visually hidden until focused (the skip link) or not rendered at all.
      if (box.width <= 1 || box.height <= 1) continue;
      if (box.width < size - 0.5 || box.height < size - 0.5) {
        const name =
          drawn.getAttribute("data-testid") ??
          drawn.getAttribute("aria-label") ??
          (drawn.textContent ?? "").trim().slice(0, 30);
        small.push(
          `${drawn.tagName.toLowerCase()} "${name}" ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
      }
    }
    return small;
  }, min);
}

/**
 * Waits until every finite CSS animation and transition has finished, so the audits see the
 * page as it rests (a row drawing in is briefly transparent, which axe would read as low
 * contrast).
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
}

/** Every layout check for one state of the page. */
export async function expectSoundLayout(page: Page, state: string): Promise<void> {
  expect(await horizontalOverflow(page), `horizontal scroll: ${state}`).toBe(0);
  expect(await zoomedOutBy(page), `zoomed out to fit something wide: ${state}`).toBe(0);
  expect(await smallTargets(page), `targets under 44x44 px: ${state}`).toEqual([]);
  expect(await smallFieldText(page), `field text under 16 px (iOS zooms): ${state}`).toEqual([]);
}
