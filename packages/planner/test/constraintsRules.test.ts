import { describe, expect, it } from "vitest";
import { MEALS, PACE } from "../src/config";
import {
  belongsToAnchor,
  dayWindow,
  earliestMealStart,
  earliestOpenStart,
  isCandidate,
  isExcluded,
  isMealPlace,
  isOpenDuring,
  isSuggestable,
  mealWindowAllows,
  servesMeal,
  sharesLocation,
  withinBudget,
  withinDayWindow,
} from "../src/constraints";
import { buildPlannerContext } from "../src/context";
import { tripDates } from "../src/time";
import type { Meal, Pace, PriceLevel } from "../src/types";
import { makePlace, makeRequest, realContext, realPlace } from "./plannerFixtures";

// Day windows, meal windows, and the place filters (base, budget, rating, exclusions, shared
// spots). A wrong answer here lets the planner put a stop outside the traveler's day, a lunch at
// 16:00, a place from another city, or the same fountain twice in one trip.

const PACES: Pace[] = ["relaxed", "balanced", "packed"];

describe("day window", () => {
  it.each(PACES)("accepts a %s stop exactly on both window edges and nothing outside", (pace) => {
    const { dayStart, dayEnd } = PACE[pace];
    expect(dayWindow(pace)).toEqual({ start: dayStart, end: dayEnd });
    expect(withinDayWindow(dayStart, dayStart + 60, pace)).toBe(true);
    expect(withinDayWindow(dayEnd - 60, dayEnd, pace)).toBe(true);
    expect(withinDayWindow(dayStart - 1, dayStart + 59, pace)).toBe(false);
    expect(withinDayWindow(dayEnd - 59, dayEnd + 1, pace)).toBe(false);
  });

  it("deducts a transfer from the start of the day, never from the end", () => {
    expect(dayWindow("balanced", 130)).toEqual({ start: 700, end: 1350 });
    expect(withinDayWindow(700, 760, "balanced", 130)).toBe(true);
    expect(withinDayWindow(699, 760, "balanced", 130)).toBe(false);
  });

  it("fits nothing when the transfer eats the whole day", () => {
    const window = dayWindow("relaxed", 900);
    expect(window.start).toBeGreaterThan(window.end);
    expect(withinDayWindow(1300, 1320, "relaxed", 900)).toBe(false);
  });

  it.each([-10, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws on a %s-minute transfer instead of widening the day",
    (transfer) => {
      expect(() => dayWindow("balanced", transfer)).toThrow(RangeError);
      expect(() => withinDayWindow(600, 660, "balanced", transfer)).toThrow(RangeError);
    },
  );

  it.each([
    [600, 600],
    [700, 600],
    [Number.NaN, 700],
  ])("rejects an invalid stop %s to %s", (start, end) => {
    expect(withinDayWindow(start, end, "packed")).toBe(false);
  });

  it("fits Piazza del Popolo at Dawn only on a pace that starts before its window closes", () => {
    const dawn = realPlace("place_023");
    const date = "2026-10-20";
    const packed = earliestOpenStart(dawn, date, PACE.packed.dayStart, dawn.durationMin);
    expect(packed).toBe(PACE.packed.dayStart);
    expect(earliestOpenStart(dawn, date, PACE.relaxed.dayStart, dawn.durationMin)).toBeNull();
  });
});

describe("meal windows", () => {
  it.each<[number, Meal | null]>([
    [719, null], // 11:59
    [720, "lunch"], // 12:00, first lunch start
    [870, "lunch"], // 14:30, last lunch start
    [871, null], // 14:31
    [1139, null], // 18:59
    [1140, "dinner"], // 19:00, first dinner start
    [1290, "dinner"], // 21:30, last dinner start
    [1291, null], // 21:31
    [Number.NaN, null],
  ])(
    "gives a stop starting at minute %s the meal role %s (both window ends inclusive)",
    (start, role) => {
      expect(mealWindowAllows("lunch", start)).toBe(role === "lunch");
      expect(mealWindowAllows("dinner", start)).toBe(role === "dinner");
    },
  );

  it("seats lunch and dinner at the first start both the meal window and the hours allow", () => {
    const enzo = realPlace("place_003"); // 12:30-14:30 and 19:30-22:30, 90 min
    expect(earliestMealStart(enzo, "2026-10-20", 600, "lunch", 90)).toBe(750);
    expect(earliestMealStart(enzo, "2026-10-20", 600, "dinner", 90)).toBe(1170);
    expect(earliestMealStart(enzo, "2026-10-20", 781, "lunch", 90)).toBeNull(); // no room left
    expect(earliestMealStart(realPlace("place_009"), "2026-10-20", 600, "lunch", 100)).toBeNull();
  });

  it("never seats an unknown-hours meal after the meal's last start", () => {
    const unknown = makePlace({ hours: null, hoursConfidence: "unknown" });
    expect(earliestMealStart(unknown, "2026-10-20", 600, "lunch", 60)).toBe(720);
    expect(earliestMealStart(unknown, "2026-10-20", 870, "lunch", 60)).toBe(870);
    expect(earliestMealStart(unknown, "2026-10-20", 871, "lunch", 60)).toBeNull();
  });

  it("never accepts a dinner-time start as lunch or a lunch-time start as dinner", () => {
    expect(mealWindowAllows("lunch", MEALS.dinner.earliestStart)).toBe(false);
    expect(mealWindowAllows("dinner", MEALS.lunch.latestStart)).toBe(false);
  });

  it("can seat every meal the data offers on some day, so no meal place is a dead end", () => {
    const dates = [...tripDates("2026-06-15", 7), ...tripDates("2026-10-19", 7)];
    for (const place of realContext().places) {
      for (const meal of place.meals) {
        const { earliestStart, latestStart } = MEALS[meal];
        const seatable = dates.some((date) => {
          for (let start = earliestStart; start <= latestStart; start += 5) {
            if (isOpenDuring(place, date, start, start + place.durationMin) !== "no") return true;
          }
          return false;
        });
        expect({ id: place.id, meal, seatable }).toEqual({ id: place.id, meal, seatable: true });
      }
    }
  });
});

describe("place filters", () => {
  it.each<[PriceLevel | null, PriceLevel | null, boolean]>([
    [2, 2, true],
    [3, 2, false],
    [1, 1, true],
    [null, 1, true], // unknown price passes
    [4, null, true], // no budget
  ])("treats price %s under budget %s as within budget: %s", (price, budget, expected) => {
    expect(withinBudget({ priceLevel: price }, budget)).toBe(expected);
  });

  it("offers Osteria Fernanda for dinner only and Cantina di Parma for lunch only, as their hours allow", () => {
    expect(isMealPlace(realPlace("place_009"))).toBe(true);
    expect(servesMeal(realPlace("place_009"), "lunch")).toBe(false);
    expect(servesMeal(realPlace("place_009"), "dinner")).toBe(true);
    expect(servesMeal(realPlace("place_092"), "lunch")).toBe(true);
    expect(servesMeal(realPlace("place_092"), "dinner")).toBe(false);
  });

  it("treats allowlisted food places as meal places and a museum as not", () => {
    expect(isMealPlace(realPlace("place_031"))).toBe(true);
    expect(servesMeal(realPlace("place_015"), "lunch")).toBe(true);
    expect(isMealPlace(realPlace("place_001"))).toBe(false);
    expect(servesMeal(realPlace("place_001"), "lunch")).toBe(false);
  });

  it("never suggests Hard Rock Cafe Rome (rated 2.1) unless the traveler asks for it", () => {
    const hardRock = realPlace("place_025");
    expect(isSuggestable(hardRock, makeRequest())).toBe(false);
    expect(isSuggestable(hardRock, makeRequest({ mustInclude: ["place_025"] }))).toBe(true);
  });

  it.each<[number | null, boolean]>([
    [3.5, true],
    [3.49, false],
    [null, true],
  ])("treats a rating of %s as suggestable: %s", (rating, expected) => {
    expect(isSuggestable(makePlace({ rating }), makeRequest())).toBe(expected);
  });

  it("never misses a place the traveler excluded", () => {
    expect(isExcluded(realPlace("place_001"), makeRequest({ exclude: ["place_001"] }))).toBe(true);
    expect(isExcluded(realPlace("place_001"), makeRequest())).toBe(false);
  });

  it.each([
    ["place_018", "place_077"], // Trevi Fountain by day and by night
    ["place_030", "place_031"], // the two Mercato Centrale listings
    ["place_044", "place_083"], // the same balsamic tasting
  ])("never lets %s and %s share a trip, in either order", (a, b) => {
    expect(sharesLocation(realPlace(a), realPlace(b))).toBe(true);
    expect(sharesLocation(realPlace(b), realPlace(a))).toBe(true);
  });

  it("treats a one-way link as two-way, and a place as not sharing with itself", () => {
    const a = makePlace({ id: "a", sharedLocationWith: ["b"] });
    const b = makePlace({ id: "b" });
    expect(sharesLocation(b, a)).toBe(true);
    expect(sharesLocation(a, a)).toBe(false);
    expect(sharesLocation(realPlace("place_001"), realPlace("place_005"))).toBe(false);
  });

  it("keeps a day inside its base: Siena belongs to Florence, never to Rome", () => {
    const ctx = realContext();
    expect(belongsToAnchor("place_038", "florence", ctx)).toBe(true);
    expect(belongsToAnchor("place_038", "rome", ctx)).toBe(false);
    expect(belongsToAnchor("place_999", "rome", ctx)).toBe(false);
    expect(belongsToAnchor("place_001", "atlantis", ctx)).toBe(false);
  });
});

describe("isCandidate", () => {
  const ctx = realContext();

  it("accepts a well-rated place in its own base and rejects it in another base", () => {
    expect(isCandidate(realPlace("place_026"), makeRequest(), "florence", ctx)).toBe(true);
    expect(isCandidate(realPlace("place_026"), makeRequest(), "rome", ctx)).toBe(false);
  });

  it("rejects an excluded place even when it would score well", () => {
    const request = makeRequest({ exclude: ["place_026"] });
    expect(isCandidate(realPlace("place_026"), request, "florence", ctx)).toBe(false);
  });

  it("rejects a low-rated place unless it is a must-include", () => {
    const hardRock = realPlace("place_025");
    expect(isCandidate(hardRock, makeRequest(), "rome", ctx)).toBe(false);
    expect(isCandidate(hardRock, makeRequest({ mustInclude: ["place_025"] }), "rome", ctx)).toBe(
      true,
    );
  });

  it("rejects an over-budget place unless the traveler named it", () => {
    const enoteca = realPlace("place_041"); // price level 4
    const cheap = makeRequest({ maxPriceLevel: 2 });
    expect(isCandidate(enoteca, cheap, "florence", ctx)).toBe(false);
    const named = makeRequest({ maxPriceLevel: 2, mustInclude: ["place_041"] });
    expect(isCandidate(enoteca, named, "florence", ctx)).toBe(true);
  });

  it("lets a place with no listed price through any budget", () => {
    const unpriced = makePlace({ id: "unpriced", priceLevel: null });
    const small = buildPlannerContext([unpriced]);
    const request = makeRequest({ maxPriceLevel: 1 });
    expect(isCandidate(unpriced, request, small.anchors[0]?.id ?? "", small)).toBe(true);
  });
});
