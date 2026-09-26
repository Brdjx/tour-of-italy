import type { Locator, Page } from "@playwright/test";
import { expectNoSeriousA11yIssues, expectSoundLayout, settleAnimations } from "../support/audit";
import { expect, test } from "../support/fixtures";
import { openPlanner, type Press, planTrip, readDay } from "../support/plan";

// Accessibility and layout on every device project, in light and dark: no serious or critical
// axe violation, no horizontal scroll or zoom-out, every visible control at least 44x44 px, and
// field text at least 16 px (support/audit.ts). Each state
// is one a traveler actually reaches: the form, a plan, a map stop's popup, the full-screen map
// and a popup on it, the swap sheet, a rule-breaking edit, the form reopened over a plan with
// More options over it, the data notes with every photo credit, a place's sheet, the places
// failing to load, and the 404 page.

/** How long the edit toast stays up (components/StatusRegion.tsx). */
const TOAST_MS = 5000;

async function auditState(page: Page, state: string): Promise<void> {
  // Decision: audit from the top of the page. Scrolled down, the pinned day tabs cover whatever
  // passes under them, and axe reads a chip half under the tabs as a target too small to press.
  await page.evaluate(() => window.scrollTo(0, 0));
  await settleAnimations(page);
  await expectSoundLayout(page, state);
  await expectNoSeriousA11yIssues(page, state);
}

/**
 * Shows the first stop's popup in `within` the way a traveler does: hovering it, or a tap on
 * touch. The first stop draws above every other, so nothing covers it.
 */
async function showPopup(page: Page, within: Locator, touch: boolean): Promise<void> {
  const stop = within.getByTestId("map-stop").first();
  if (touch) await stop.tap();
  else await stop.hover();
  await expect(page.getByTestId("map-popup")).toBeVisible();
}

/** The map's stops, a popup, and the map full screen with a popup on it. */
async function auditMap(page: Page, press: Press, touch: boolean): Promise<void> {
  // From the top, as auditState does, so no scroll moves the stop from under the pointer.
  await page.evaluate(() => window.scrollTo(0, 0));
  await showPopup(page, page.getByTestId("day-map"), touch);
  await auditState(page, "a map stop's popup");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("map-popup")).toHaveCount(0);

  await press(page.getByTestId("map-expand"));
  const full = page.getByTestId("map-dialog");
  await expect(full).toBeVisible();
  await auditState(page, "the full-screen map");
  await showPopup(page, full, touch);
  await auditState(page, "a popup on the full-screen map");
  // Escape puts the popup away, then closes the map.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("map-popup")).toHaveCount(0);
  await press(page.getByTestId("map-close"));
  await expect(full).toBeHidden();
}

async function breakARule(page: Page, press: Press): Promise<void> {
  await readDay(page, press, 1);
  const rows = page.getByTestId("stop-row");
  const flagged = page.locator('[data-testid="stop-row"][data-flagged="true"]');
  const count = await rows.count();
  // Each stop moves toward the end one place at a time until a move breaks a rule (a sight moved
  // after dinner is closed); a stop that never breaks one has its moves undone.
  for (let index = 0; index < count - 1 && (await flagged.count()) === 0; index++) {
    let moves = 0;
    for (let at = index; at < count - 1 && (await flagged.count()) === 0; at++) {
      const moved = await rows.nth(at).getAttribute("data-place-id");
      await press(rows.nth(at).getByTestId("move-down"));
      await expect(rows.nth(at + 1)).toHaveAttribute("data-place-id", moved ?? "");
      moves++;
    }
    if ((await flagged.count()) > 0) break;
    for (; moves > 0; moves--) await press(page.getByTestId("undo-button"));
  }
  await expect(flagged.first()).toBeVisible();
  // The edit's toast covers the bottom of the screen for 5 s by design; audit the page at rest.
  await page.clock.runFor(TOAST_MS);
  await expect(page.getByTestId("toast")).toHaveCount(0);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("the form, a plan, its map, the swap sheet and a flagged edit pass the audits", async ({
      page,
      press,
      touch,
    }) => {
      await openPlanner(page);
      await auditState(page, "form");

      await planTrip(page, press);
      await auditState(page, "plan");

      await auditMap(page, press, touch);

      await press(page.getByTestId("swap-button").first());
      await expect(page.getByTestId("alternatives-sheet")).toBeVisible();
      await auditState(page, "swap sheet");
      await press(page.getByTestId("alternatives-close"));
      await expect(page.getByTestId("alternatives-sheet")).toHaveCount(0);

      await breakARule(page, press);
      await auditState(page, "edit that breaks a rule");

      await press(page.getByTestId("edit-trip-button"));
      await expect(page.getByTestId("back-to-plan")).toBeVisible();
      await auditState(page, "form reopened over a plan");

      // More options stacks over the Edit trip sheet.
      await press(page.getByTestId("more-options-button"));
      await expect(page.getByTestId("more-options-done")).toBeVisible();
      await auditState(page, "more options over the form");
    });

    test("the data notes, an error, and the 404 page pass the audits", async ({ page, press }) => {
      await openPlanner(page);
      await press(page.getByTestId("data-notes-link"));
      const about = page.getByTestId("about-sheet");
      await expect(about).toBeVisible();
      await auditState(page, "data notes open");
      // Every photo's credit, a long list of links in lines of text.
      const credits = about.getByTestId("about-credit-list");
      await press(about.locator("summary").filter({ hasText: "Show every photo's credit" }));
      await expect(credits).toBeVisible();
      await auditState(page, "every photo credit shown");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("about-sheet")).toBeHidden();

      await press(page.getByTestId("highlight-button").first());
      await expect(page.getByTestId("place-sheet")).toBeVisible();
      await auditState(page, "place sheet open");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("place-sheet")).toBeHidden();

      await page.route("**/api/places", (route) => route.abort("connectionreset"));
      await page.reload();
      await expect(page.getByTestId("options-error")).toBeVisible();
      await auditState(page, "places failed to load");

      await page.goto("/no-such-page/");
      await expect(page.getByTestId("not-found-home")).toBeVisible();
      await auditState(page, "404 page");
    });
  });
}
