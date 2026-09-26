import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  BADGE,
  CHECKED,
  closeMoreOptions,
  expectTimesInOrder,
  openMoreOptions,
  openPlanner,
  type Press,
  placeIds,
  planTrip,
  readDay,
  readTrip,
  type StopData,
} from "../support/plan";

// A city for each day, set by hand (F13, decision 16), against the local API with the scripted
// model (fixture mode): the city on a day's line opens the route sheet on that day's cities over
// the route; a city sets that day in the route, which says what it does; its one action plans the
// days it names one request at a time, and the result is one edit. The fixture plan for the
// pinned date is two days in Rome and one in Florence. What would break the product: a city
// refused for its travel, a place on two days, a day the page did not check, an edit Undo cannot
// take back, or a saved link that loses the new days.

/** Opens the route sheet from a day's city (1-based): that day's cities, over the route. */
async function openCitiesFor(page: Page, press: Press, day: number): Promise<Locator> {
  await readDay(page, press, day);
  await press(page.getByTestId("city-button"));
  const sheet = page.getByTestId("route-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: `City for day ${day}` })).toBeFocused();
  return sheet;
}

/** A city in the day's list. */
function city(sheet: Locator, anchorId: string): Locator {
  return sheet.locator(`[data-testid="city-option"][data-anchor-id="${anchorId}"]`);
}

/** A day (1-based) in the route view. */
function routeDay(sheet: Locator, day: number): Locator {
  return sheet.locator(`[data-testid="route-day"][data-day="${day - 1}"]`);
}

/** Every place id of the trip, in day order. */
function allIds(trip: readonly (readonly StopData[])[]): string[] {
  return trip.flatMap((day) => placeIds(day));
}

/** Waits for a run's one edit to land, by its message in the live region. */
async function routeDone(page: Page, message: string): Promise<void> {
  await expect(page.getByTestId("live-region")).toContainText(message, { timeout: 30_000 });
}

test.describe("setting a city for each day", () => {
  test("gives every day a new city, with no place anywhere twice, and Undo brings the trip back", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const before = await readTrip(page, press);
    const sheet = await openCitiesFor(page, press, 1);
    // Travel is the traveler's choice: every city can take day 1 and points onward.
    for (const anchorId of ["florence", "milan", "venice", "bologna"]) {
      await expect(city(sheet, anchorId)).toHaveAttribute("data-allowed", "true");
      await expect(city(sheet, anchorId).locator(".city-option-chevron")).toBeVisible();
    }
    await press(city(sheet, "florence"));
    await expect(sheet.getByRole("heading", { name: "Your route" })).toBeVisible();
    await expect(routeDay(sheet, 1)).toBeFocused();
    await press(routeDay(sheet, 2));
    await press(city(sheet, "venice"));
    await press(routeDay(sheet, 3));
    await press(city(sheet, "milan"));
    await expect(routeDay(sheet, 3)).toContainText("was Florence");
    // Each day's start in its column, and what the travel leaves of it under its city.
    await expect(routeDay(sheet, 2).getByTestId("route-day-start")).toHaveText("Starts at 11:30");
    await expect(routeDay(sheet, 2)).toContainText("Leaves about 7 h 30 min before dinner.");
    await expect(sheet.getByTestId("route-travel")).toContainText("Travel between cities:");

    // Held, so the progress can be read: day 1 plans, days 2 and 3 wait their turn.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/plan/day*", async (route) => {
      await held;
      await route.continue();
    });
    await press(sheet.getByRole("button", { name: "Plan all three days" }));
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("day-planning")).toHaveText(
      "Planning day 1 in Florence (1 of 3)",
    );
    await expect(page.getByTestId("day-tab-3")).toHaveAttribute("data-busy", "waiting");
    release();
    await routeDone(page, "Route changed: Florence, Venice, Milan.");
    await page.unroute("**/api/plan/day*");

    const after = await readTrip(page, press);
    // Day 1 may take the Florence places day 3 gave up; no place is on two days.
    const ids = allIds(after);
    expect(new Set(ids).size, "a place appears on two days").toBe(ids.length);
    for (const [index, name] of ["Florence", "Venice", "Milan"].entries()) {
      await readDay(page, press, index + 1);
      await expect(page.getByTestId("day-subtitle")).toContainText(`Day ${index + 1} in ${name}`);
      await expect(page.getByTestId("day-source")).toHaveText("Planned again with AI");
      expectTimesInOrder(after[index] ?? []);
    }
    await expect(page.locator('[data-flagged="true"]')).toHaveCount(0);
    await expect(page.getByTestId("source-badge")).toContainText(BADGE.edited);

    await press(page.getByTestId("undo-button"));
    await expect(page.getByTestId("day-source")).toHaveCount(0);
    expect(await readTrip(page, press)).toEqual(before);
    await expect(page.getByTestId("source-badge")).toHaveText(BADGE.ai + CHECKED);
  });

  test("moves one day and plans the next again for its travel, while the rest waits", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const before = await readTrip(page, press);
    const sheet = await openCitiesFor(page, press, 1);
    // The travel on to day 2 once, on the city's line; its warning says what it does.
    await expect(city(sheet, "florence")).toContainText("2 h 10 min on to Rome for day");
    await expect(city(sheet, "florence")).toContainText("Day 2 will be planned again.");
    await expect(city(sheet, "florence")).not.toContainText("it now starts after");
    await press(city(sheet, "florence"));
    await expect(routeDay(sheet, 2)).toContainText(
      "Day 2 will be planned again: it now starts after 2 h 10 min of travel.",
    );
    await press(sheet.getByRole("button", { name: "Plan day 1 and day 2" }));
    await routeDone(page, "Day 1 now in Florence. Day 2 planned again.");

    const after = await readTrip(page, press);
    expect(placeIds(after[0] ?? []).some((id) => placeIds(before[0] ?? []).includes(id))).toBe(
      false,
    );
    expect(placeIds(after[2] ?? [])).toEqual(placeIds(before[2] ?? []));
    const ids = allIds(after);
    expect(new Set(ids).size, "a place appears on two days").toBe(ids.length);
    for (const day of after) expectTimesInOrder(day);
    // Day 2 now starts with the train from Florence, and says what that leaves of it.
    await readDay(page, press, 2);
    await expect(page.getByTestId("transfer-note")).toContainText("from Florence");
    await expect(page.getByTestId("transfer-left")).toHaveText(/^Leaves about \d+ h/);
    await expect(page.getByTestId("day-source")).toHaveText("Planned again with AI");
    await expect(page.locator('[data-flagged="true"]')).toHaveCount(0);
  });

  test("goes back a level with Back and Escape, and closing leaves the trip as it was", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const before = await readTrip(page, press);
    const sheet = await openCitiesFor(page, press, 2);
    const tall = await sheet.boundingBox();
    await press(sheet.getByTestId("route-back"));
    await expect(sheet.getByRole("heading", { name: "Your route" })).toBeVisible();
    await expect(routeDay(sheet, 2)).toBeFocused();
    // The route has its foot before any change, dimmed, at the bottom of a sheet that kept its
    // height.
    const action = sheet.getByTestId("route-confirm");
    await expect(action).toHaveText("No changes to plan");
    await expect(action).toHaveAttribute("aria-disabled", "true");
    const below = await action.evaluate((pill) => {
      const box = pill.closest("dialog")?.getBoundingClientRect();
      return {
        height: box?.height ?? 0,
        gap: (box?.bottom ?? 0) - pill.getBoundingClientRect().bottom,
      };
    });
    expect(below.height).toBeGreaterThanOrEqual((tall?.height ?? 0) - 1);
    expect(below.gap).toBeLessThan(60);
    await press(routeDay(sheet, 3));
    await expect(sheet.getByRole("heading", { name: "City for day 3" })).toBeFocused();
    await press(city(sheet, "venice"));
    await expect(action).toHaveText("Plan day 3");
    // The changed day's wash stays inside the board's rules. Both measured at one instant: the
    // level is still sliding in.
    const edges = await routeDay(sheet, 3).evaluate((row) => {
      const board = row.closest(".route-days")?.getBoundingClientRect();
      const wash = row.getBoundingClientRect();
      return { left: wash.left - (board?.left ?? 0), right: (board?.right ?? 0) - wash.right };
    });
    expect(edges.left).toBeGreaterThanOrEqual(-0.5);
    expect(edges.right).toBeGreaterThanOrEqual(-0.5);
    await press(routeDay(sheet, 3));
    await page.keyboard.press("Escape");
    await expect(sheet.getByRole("heading", { name: "Your route" })).toBeVisible();
    await expect(routeDay(sheet, 3)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("city-button")).toBeFocused();
    expect(await readTrip(page, press)).toEqual(before);
  });

  test("refuses a city that would lose a place asked for, says why and the way out, and takes it once that is done", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    // The Uffizi as a must-see: the fixture plan puts it on day 1, the trip's only Florence day.
    const mustSee = (await openMoreOptions(page, press)).getByTestId("must-see-field");
    await mustSee.getByRole("combobox").fill("Uffizi");
    await press(mustSee.getByRole("option", { name: "Uffizi Gallery" }).first());
    await closeMoreOptions(page, press);
    await planTrip(page, press);
    const sheet = await openCitiesFor(page, press, 1);
    const rome = city(sheet, "rome");
    await expect(rome).toHaveAttribute("data-allowed", "false");
    await expect(rome.locator(".city-option-chevron")).toHaveCount(0);
    await expect(rome).toContainText(
      "Day 1 has Uffizi Gallery, which you asked for, and no other day of this route is in Florence. Keep day 1 in Florence, or remove Uffizi Gallery from day 1 first.",
    );
    await expect(city(sheet, "milan")).toContainText("This day has a place you asked for.");
    await rome.scrollIntoViewIfNeeded();
    await press(rome, { force: true });
    await expect(sheet.getByRole("heading", { name: "City for day 1" })).toBeVisible();

    // The way out: day 2 in Florence can hold the Uffizi, so day 1 can then go to Rome.
    await press(sheet.getByTestId("route-back"));
    await press(routeDay(sheet, 2));
    await press(city(sheet, "florence"));
    await press(routeDay(sheet, 1));
    await expect(city(sheet, "rome")).toHaveAttribute("data-allowed", "true");
    await press(city(sheet, "rome"));
    await expect(routeDay(sheet, 1)).toContainText("was Florence");
    await press(sheet.getByTestId("route-confirm"));
    await routeDone(page, "Route changed: Rome, Florence, Rome.");
    const trip = await readTrip(page, press);
    expect(allIds(trip)).toContain("place_026");
    const ids = allIds(trip);
    expect(new Set(ids).size, "a place appears on two days").toBe(ids.length);
  });

  test("plans the days on this device when the API cannot be reached, and says so", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const before = await readTrip(page, press);
    await page.route("**/api/plan/day*", (route) => route.abort("connectionreset"));
    const sheet = await openCitiesFor(page, press, 1);
    await press(city(sheet, "venice"));
    await press(sheet.getByTestId("route-confirm"));
    await routeDone(page, "Planned without AI on this device.");
    await readDay(page, press, 1);
    await expect(page.getByTestId("day-source")).toHaveText(
      "Planned again on this device, offline",
    );
    await expect(page.getByTestId("day-subtitle")).toContainText("Day 1 in Venice");
    const after = await readTrip(page, press);
    expect(placeIds(after[0] ?? []).some((id) => placeIds(before[0] ?? []).includes(id))).toBe(
      false,
    );
    const ids = allIds(after);
    expect(new Set(ids).size, "a place appears on two days").toBe(ids.length);
    await expect(page.locator('[data-flagged="true"]')).toHaveCount(0);
  });

  test("gives new ideas for a day, with none of its places back", async ({ page, press }) => {
    await openPlanner(page);
    await planTrip(page, press);
    const before = await readTrip(page, press);
    const sheet = await openCitiesFor(page, press, 2);
    await press(sheet.getByTestId("city-new-ideas"));
    await expect(sheet).toBeHidden();
    await routeDone(page, "New ideas for day 2.");
    await expect(page.getByTestId("day-source")).toHaveText("Planned again with AI");
    const ideas = await readTrip(page, press);
    expect(placeIds(ideas[1] ?? []).some((id) => placeIds(before[1] ?? []).includes(id))).toBe(
      false,
    );
    const ids = allIds(ideas);
    expect(new Set(ids).size, "a place appears on two days").toBe(ids.length);
  });

  // The owner's report (decision 17, 2026-09-26): "I selected 2 different cities and ai missed a
  // meal for day 3". Rome, Venice, Bologna from Saturday 10 October: day 3 is a Monday, when none
  // of Bologna's dinner places opens, so the route says so before Bologna is chosen and the day
  // says why once planned, with another city as the way out, never a swap.
  test("warns before a city leaves a Monday with no dinner, and explains the day once planned", async ({
    page,
    press,
  }) => {
    await openPlanner(page);
    await page.getByTestId("start-date").fill("2026-10-10");
    await planTrip(page, press);
    const sheet = await openCitiesFor(page, press, 2);
    await press(city(sheet, "venice"));
    await press(routeDay(sheet, 3));
    const bologna = city(sheet, "bologna");
    await expect(bologna).toHaveAttribute("data-allowed", "true");
    await expect(bologna.locator(".city-warning")).toHaveText([
      "2 h 25 min by train or car from Venice, so the day starts at 11:55.",
      "No dinner in Bologna on Mondays.",
    ]);
    await press(bologna);
    await expect(routeDay(sheet, 3).locator(".city-warning")).toHaveText([
      "No dinner in Bologna on Mondays.",
    ]);
    await press(sheet.getByTestId("route-confirm"));
    await routeDone(page, "Route changed: Rome, Venice, Bologna.");

    await readDay(page, press, 3);
    await expect(page.getByTestId("day-subtitle")).toContainText("Day 3 in Bologna");
    await expect(page.getByTestId("transfer-left")).toHaveCount(0);
    await press(page.getByTestId("warning-chip").filter({ hasText: "No dinner open" }));
    const panel = page.locator('[data-testid="chip-explanation"]:not([hidden])');
    await expect(panel).toContainText("Bologna's three dinner places are all closed on Mondays.");
    await expect(panel.getByRole("listitem")).toHaveText([
      "Osteria Francescana",
      "Tagliatelle al Ragù at Trattoria Anna Maria",
      "Enoteca Italiana, Bologna",
    ]);
    await expect(panel).not.toContainText(/swap/i);
    await press(panel.getByTestId("chip-city"));
    await expect(sheet.getByRole("heading", { name: "City for day 3" })).toBeFocused();
  });

  // Decision: its own test, apart from new ideas. Together they read the trip four times on two
  // pages with a map each, which took up to 66 s on CI's WebKit tablets (11 s on a laptop) and
  // ran into the 60 s test limit.
  test("a saved link of a three-city trip reopens it", async ({ page, press }) => {
    await openPlanner(page);
    await planTrip(page, press);
    // Day 2 to Venice and day 3 to Milan: with day 1 in Rome, three cities.
    const sheet = await openCitiesFor(page, press, 2);
    await press(city(sheet, "venice"));
    await press(routeDay(sheet, 3));
    await press(city(sheet, "milan"));
    await press(sheet.getByTestId("route-confirm"));
    await routeDone(page, "Route changed: Rome, Venice, Milan.");
    const after = await readTrip(page, press);
    const ids = allIds(after);
    expect(new Set(ids).size, "a place appears on two days").toBe(ids.length);

    await press(page.getByTestId("share-button"));
    await expect(page.getByTestId("share-button")).toHaveText(/Link copied/);
    await expect(page.getByTestId("share-note")).toHaveText(
      "Days 2 and 3 were planned again, so the saved trip shows the rules' why lines for them.",
    );
    const link = await page.evaluate(
      () => (window as unknown as { __copiedText?: string }).__copiedText ?? "",
    );
    expect(link).toMatch(/\?t=[0-9A-Za-z]{10}$/);
    await page.evaluate(() => localStorage.clear());
    const other = await page.context().newPage();
    await other.goto(link);
    await expect(other.getByTestId("plan-view")).toBeVisible();
    await expect(other.getByTestId("source-badge")).toContainText(BADGE.savedAi);
    await expect(other.getByTestId("source-badge")).toContainText("edited");
    for (const [index, name] of ["Rome", "Venice", "Milan"].entries()) {
      expect(await readDay(other, press, index + 1)).toEqual(after[index]);
      await expect(other.getByTestId("day-subtitle")).toContainText(`Day ${index + 1} in ${name}`);
    }
  });
});
