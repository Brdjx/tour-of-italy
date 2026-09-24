import type { Page } from "@playwright/test";
import { expectNoSeriousA11yIssues, expectSoundLayout, settleAnimations } from "../support/audit";
import { expect, test } from "../support/fixtures";
import { openPlanner, type Press, planTrip, readDay } from "../support/plan";

// Accessibility and layout on every device project, in light and dark: no serious or critical
// axe violation, no horizontal scroll or zoom-out, every visible control at least 44x44 px, and
// field text at least 16 px (support/audit.ts). Each state
// is one a traveler actually reaches: the form, a plan, the swap sheet, a rule-breaking edit,
// the form reopened over a plan, the data notes, an error, and the 404 page.

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

    test("the form, a plan, the swap sheet and a flagged edit pass the audits", async ({
      page,
      press,
      twoPane,
    }) => {
      await openPlanner(page);
      await auditState(page, "form");

      await planTrip(page, press);
      await auditState(page, "plan");

      await press(page.getByTestId("swap-button").first());
      await expect(page.getByTestId("alternatives-sheet")).toBeVisible();
      await auditState(page, "swap sheet");
      await press(page.getByTestId("alternatives-close"));
      await expect(page.getByTestId("alternatives-sheet")).toHaveCount(0);

      await breakARule(page, press);
      await auditState(page, "edit that breaks a rule");

      // Two-pane screens show the form beside the plan all along, so it was audited above.
      if (!twoPane) {
        await press(page.getByTestId("edit-trip-button"));
        await expect(page.getByTestId("back-to-plan")).toBeVisible();
        await auditState(page, "form reopened over a plan");
      }
    });

    test("the data notes, an error, and the 404 page pass the audits", async ({ page, press }) => {
      await openPlanner(page);
      await press(page.getByTestId("data-notes").locator("summary"));
      await expect(page.getByTestId("data-notes")).toHaveAttribute("open", "");
      await auditState(page, "data notes open");

      await page.route("**/api/places", (route) => route.abort("connectionreset"));
      await page.reload();
      await expect(page.getByTestId("error-state")).toBeVisible();
      await auditState(page, "places failed to load");

      await page.goto("/no-such-page/");
      await expect(page.getByTestId("not-found-home")).toBeVisible();
      await auditState(page, "404 page");
    });
  });
}
