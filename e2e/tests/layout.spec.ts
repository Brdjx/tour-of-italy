import type { Page } from "@playwright/test";
import { horizontalOverflow } from "../support/audit";
import { expect, test } from "../support/fixtures";
import { openPlanner, planTrip, readStops } from "../support/plan";

// The responsive layout on each device: what must stay on screen, where the form goes once there
// is a plan, where the day's map sits, and motion under reduced motion.

/** Properties that move something on screen, which reduced motion must never animate. */
const MOTION = new Set([
  "transform",
  "translate",
  "rotate",
  "scale",
  "top",
  "right",
  "bottom",
  "left",
]);

/**
 * The plan's CSS animations (running, or holding their end), each as "class name: properties",
 * and those among them that move something. Under reduced motion the design keeps a short
 * crossfade in place of a movement, and colour changes (an edited row's gold) stay: neither moves.
 */
async function planAnimations(page: Page): Promise<{ all: string[]; moving: string[] }> {
  const found = await page.getByTestId("plan-view").evaluate((plan) =>
    [plan, ...plan.querySelectorAll("*")].flatMap((element) =>
      element.getAnimations().map((animation) => {
        const name =
          animation instanceof CSSAnimation
            ? animation.animationName
            : animation instanceof CSSTransition
              ? `transition of ${animation.transitionProperty}`
              : animation.id;
        const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
        const properties = [
          ...new Set(
            frames.flatMap((frame) =>
              Object.keys(frame).filter(
                (key) => !["offset", "computedOffset", "easing", "composite"].includes(key),
              ),
            ),
          ),
        ];
        return { label: `${element.getAttribute("class") ?? element.tagName} ${name}`, properties };
      }),
    ),
  );
  return {
    all: found.map(({ label, properties }) => `${label}: ${properties.join(" ")}`),
    moving: found
      .filter(({ properties }) => properties.some((property) => MOTION.has(property)))
      .map(({ label, properties }) => `${label}: ${properties.join(" ")}`),
  };
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

  test("opens the form in the Edit trip sheet on every screen, focus follows it both ways, and the plan stays", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const before = await readStops(page);
    const form = page.getByTestId("trip-form");
    const edit = page.getByTestId("edit-trip-button");

    // One column on every screen: the plan takes it, and the form waits in the sheet.
    await expect(form).toBeHidden();
    await press(edit);
    await expect(page.getByTestId("form-heading")).toBeFocused();
    await expect(form).toBeVisible();
    await press(page.getByTestId("back-to-plan"));
    await expect(form).toBeHidden();
    await expect(edit).toBeFocused();
    expect(await readStops(page)).toEqual(before);
  });

  test("keeps the day's map beside the board on iPad landscape and desktop, and under it on phones and iPad portrait", async ({
    page,
    press,
    mapBeside,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const board = await page.getByTestId("day-timetable").boundingBox();
    const map = await page.getByTestId("day-map").boundingBox();
    if (!board || !map) throw new Error("the board or the map has no size");
    if (mapBeside) {
      expect(map.x, "the map is not right of the board").toBeGreaterThanOrEqual(
        board.x + board.width,
      );
      expect(map.y, "the map does not start beside the board").toBeLessThan(board.y + board.height);
    } else {
      expect(map.y, "the map is not under the board").toBeGreaterThanOrEqual(
        board.y + board.height,
      );
      expect(map.x, "the map is not in the board's column").toBeLessThan(board.x + board.width);
    }
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

  test("moves nothing in the plan for a traveler who asked for reduced motion", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await planTrip(page, press);
    // The same plan with motion allowed, so this test cannot pass by finding nothing to stop.
    expect((await planAnimations(page)).moving, "no draw-in movement to stop").not.toEqual([]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const arrival = await planAnimations(page);
    expect(arrival.all, "no crossfade in place of the draw-in").not.toEqual([]);
    expect(arrival.moving, "rows move in under reduced motion").toEqual([]);

    await press(page.getByTestId("stop-row").first().getByTestId("move-down"));
    await expect(page.getByTestId("undo-button")).toBeVisible();
    expect((await planAnimations(page)).moving, "an edit moves under reduced motion").toEqual([]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect((await planAnimations(page)).moving, "no edit movement to stop").not.toEqual([]);
  });
});
