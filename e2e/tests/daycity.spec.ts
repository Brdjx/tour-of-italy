import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  BADGE,
  CHECKED,
  expectTimesInOrder,
  openPlanner,
  type Press,
  placeIds,
  planTrip,
  readDay,
  readTrip,
  type StopData,
} from "../support/plan";

// Changing a day's city (F13), against the local API with the scripted model (fixture mode):
// the city on a day's line opens Change city, choosing a city plans that day again through
// POST /api/plan/day, and the result is one edit. The fixture plan for the pinned date is two
// days in Rome and one in Florence, so day 2 can move to Florence at once and a third city is
// refused with its reason. What would break the product: a place on two days, a day the page
// did not check, an edit Undo cannot take back, or a saved link that loses the new day.

/** Opens Change city for a day (1-based) and returns the sheet. */
async function openCityFor(page: Page, press: Press, day: number) {
  await readDay(page, press, day);
  await press(page.getByTestId("city-button"));
  const sheet = page.getByTestId("city-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: `Change city for day ${day}` })).toBeFocused();
  return sheet;
}

/** Every place id of the trip, in day order. */
function allIds(trip: readonly (readonly StopData[])[]): string[] {
  return trip.flatMap((day) => placeIds(day));
}

test.describe("changing a day's city", () => {
  test.beforeEach(async ({ page, press }) => {
    await openPlanner(page);
    await planTrip(page, press);
  });

  test("moves day 2 to Florence with new stops, none repeated anywhere, and Undo brings the trip back", async ({
    page,
    press,
  }) => {
    const before = await readTrip(page, press);
    const sheet = await openCityFor(page, press, 2);
    const current = sheet.getByTestId("city-current");
    await expect(current).toContainText("Rome");
    await expect(current).toContainText("This day");
    // A third city would break the two-city limit: shown, dimmed in place, with its reason.
    const milan = sheet.locator('[data-testid="city-option"][data-anchor-id="milan"]');
    await expect(milan).toHaveAttribute("aria-disabled", "true");
    await expect(milan).toContainText("A trip can use at most 2 cities");
    const florence = sheet.locator('[data-testid="city-option"][data-anchor-id="florence"]');
    await expect(florence).toHaveAttribute("data-allowed", "true");
    await expect(florence).toContainText("from Rome");

    await press(florence);
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("day-source")).toHaveText("Planned again with AI");
    await expect(page.getByTestId("day-subtitle")).toContainText("Day 2 in Florence");
    await expect(page.getByTestId("live-region")).toContainText("Day 2 now in Florence.");
    await expect(page.getByTestId("source-badge")).toContainText(BADGE.edited);

    const after = await readTrip(page, press);
    const [day1, day2, day3] = after;
    // Day 2's stops are all new; day 1 is untouched; day 3 keeps its places.
    expect(placeIds(day2 ?? []).some((id) => placeIds(before[1] ?? []).includes(id))).toBe(false);
    expect(day1).toEqual(before[0]);
    expect(placeIds(day3 ?? [])).toEqual(placeIds(before[2] ?? []));
    // No place on two days, and every day still runs in order with nothing flagged.
    const ids = allIds(after);
    expect(new Set(ids).size, "a place appears on two days").toBe(ids.length);
    for (const day of after) expectTimesInOrder(day);
    await expect(page.locator('[data-flagged="true"]')).toHaveCount(0);

    await readDay(page, press, 2);
    await press(page.getByTestId("undo-button"));
    await expect(page.getByTestId("day-subtitle")).toContainText("Day 2 in Rome");
    await expect(page.getByTestId("day-source")).toHaveCount(0);
    expect(await readTrip(page, press)).toEqual(before);
    await expect(page.getByTestId("source-badge")).toHaveText(BADGE.ai + CHECKED);
  });

  test("gives new ideas for a day, and the saved link reopens the trip with them", async ({
    page,
    press,
  }) => {
    const before = await readTrip(page, press);
    const sheet = await openCityFor(page, press, 1);
    await press(sheet.getByTestId("city-new-ideas"));
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("day-source")).toHaveText("Planned again with AI");
    await expect(page.getByTestId("live-region")).toContainText("New ideas for day 1.");
    const after = await readTrip(page, press);
    expect(placeIds(after[0] ?? []).some((id) => placeIds(before[0] ?? []).includes(id))).toBe(
      false,
    );
    const ids = allIds(after);
    expect(new Set(ids).size, "a place appears on two days").toBe(ids.length);

    await press(page.getByTestId("share-button"));
    await expect(page.getByTestId("share-button")).toHaveText(/Link copied/);
    await expect(page.getByTestId("share-note")).toHaveText(
      "Day 1 was planned again, so the saved trip shows the rules' why lines for it.",
    );
    const link = await page.evaluate(
      () => (window as unknown as { __copiedText?: string }).__copiedText ?? "",
    );
    expect(link).toMatch(/\?t=[0-9A-Za-z]{10}$/);
    await page.evaluate(() => localStorage.clear());
    const other = await page.context().newPage();
    await other.goto(link);
    await expect(other.getByTestId("plan-view")).toBeVisible();
    await expect(other.getByTestId("source-badge")).toContainText(`${BADGE.savedAi}`);
    await expect(other.getByTestId("source-badge")).toContainText("edited");
    expect(await readTrip(other, press)).toEqual(after);
  });

  test("plans the day on this device when the API cannot be reached, and says so", async ({
    page,
    press,
  }) => {
    const before = await readTrip(page, press);
    await page.route("**/api/plan/day*", (route) => route.abort("connectionreset"));
    const sheet = await openCityFor(page, press, 2);
    await press(sheet.locator('[data-testid="city-option"][data-anchor-id="florence"]'));
    await expect(page.getByTestId("day-source")).toHaveText(
      "Planned again on this device, offline",
    );
    await expect(page.getByTestId("day-subtitle")).toContainText("Day 2 in Florence");
    const after = await readTrip(page, press);
    expect(placeIds(after[1] ?? []).some((id) => placeIds(before[1] ?? []).includes(id))).toBe(
      false,
    );
    const ids = allIds(after);
    expect(new Set(ids).size, "a place appears on two days").toBe(ids.length);
    await expect(page.locator('[data-flagged="true"]')).toHaveCount(0);
  });
});
