import type { Page } from "@playwright/test";
import { horizontalOverflow } from "../support/audit";
import { expect, test } from "../support/fixtures";
import { openPlanner, planTrip, readStops } from "../support/plan";

// The responsive layout on each device: what must stay on screen, and how the form and the plan
// share the screen before and after planning.

/** Elements in the timetable that run a CSS animation, as "class animation-name". */
async function timetableAnimations(page: Page): Promise<string[]> {
  return page.getByTestId("day-timetable").evaluate((timetable) =>
    [...timetable.querySelectorAll<HTMLElement>("*")]
      .map((element) => ({ element, name: getComputedStyle(element).animationName }))
      .filter(({ name }) => name !== "none" && name !== "")
      .map(({ element, name }) => `${element.className} ${name}`),
  );
}

test.describe("layout", () => {
  test("keeps Plan my trip on screen without scrolling, on every screen size", async ({ page }) => {
    await openPlanner(page);
    const button = await page.getByTestId("plan-button").boundingBox();
    const viewport = page.viewportSize();
    expect(button && viewport, "no size for the plan button or the viewport").toBeTruthy();
    if (!button || !viewport) return;
    expect(button.y, "Plan my trip starts above the screen").toBeGreaterThanOrEqual(0);
    expect(button.y + button.height, "Plan my trip is below the screen").toBeLessThanOrEqual(
      viewport.height,
    );
  });

  test("keeps the day tabs pinned in view while the timetable scrolls", async ({ page, press }) => {
    await openPlanner(page);
    await planTrip(page, press);
    await page.getByTestId("stop-row").last().scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const tabs = await page.getByTestId("day-tabs").boundingBox();
    expect(tabs, "the day tabs are not rendered").toBeTruthy();
    expect(tabs?.y ?? -1, "the day tabs scrolled off the top").toBeGreaterThanOrEqual(0);
    expect(tabs?.y ?? 999, "the day tabs are not pinned to the top").toBeLessThan(80);
  });

  test("never loses the two panes on iPad landscape and desktop, or the Edit trip button on phones and iPad portrait", async ({
    page,
    press,
    twoPane,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const before = await readStops(page);
    const form = page.getByTestId("trip-form");
    const edit = page.getByTestId("edit-trip-button");

    if (twoPane) {
      await expect(edit).toBeHidden();
      await expect(form).toBeVisible();
      const formBox = await form.boundingBox();
      const planBox = await page.getByTestId("plan-view").boundingBox();
      if (!formBox || !planBox) throw new Error("the form or the plan has no size");
      expect(formBox.x + formBox.width, "the form is not left of the plan").toBeLessThanOrEqual(
        planBox.x,
      );
      const sideBySide =
        formBox.y < planBox.y + planBox.height && planBox.y < formBox.y + formBox.height;
      expect(sideBySide, "the form and the plan are stacked, not side by side").toBe(true);
    } else {
      // The plan takes the screen, the form opens on request and focus follows it both ways.
      await expect(form).toBeHidden();
      await press(edit);
      await expect(page.getByTestId("form-heading")).toBeFocused();
      await expect(form).toBeVisible();
      await press(page.getByTestId("back-to-plan"));
      await expect(form).toBeHidden();
      await expect(edit).toBeFocused();
    }
    expect(await readStops(page)).toEqual(before);
  });

  test("never lets a block wider than the screen pass the overflow audit, even where the browser zooms out to fit it", async ({
    page,
  }) => {
    await openPlanner(page);
    expect(await horizontalOverflow(page), "overflow before anything was added").toBe(0);
    const tooWide = (page.viewportSize()?.width ?? 0) + 300;
    await page.getByTestId("trip-form").evaluate((form, width) => {
      const block = document.createElement("div");
      block.style.width = `${width}px`;
      block.style.height = "8px";
      form.append(block);
    }, tooWide);
    expect(await horizontalOverflow(page), "a block 300 px too wide went unseen").toBeGreaterThan(
      200,
    );
  });

  test("stops every timetable animation for a traveler who asked for reduced motion", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await planTrip(page, press);
    // The same rows with motion allowed, so this test cannot pass by finding nothing to stop.
    expect(await timetableAnimations(page), "no draw-in animation to stop").not.toEqual([]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await timetableAnimations(page), "rows draw in under reduced motion").toEqual([]);

    await press(page.getByTestId("stop-row").first().getByTestId("move-down"));
    await expect(page.getByTestId("undo-button")).toBeVisible();
    expect(await timetableAnimations(page), "an edit flashes under reduced motion").toEqual([]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await timetableAnimations(page), "no edit highlight to stop").not.toEqual([]);
  });
});
