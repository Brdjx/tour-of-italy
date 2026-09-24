import { describe, expect, it } from "vitest";
import { coversMeal } from "../src/constraints";
import { shareMeals } from "../src/mealShare";
import { planDeterministic } from "../src/plan";
import { PoolCache } from "../src/pools";
import { scheduleDay } from "../src/schedule";
import { tripDates } from "../src/time";
import type { TripDraft } from "../src/tripBuilder";
import type { DayPlan, Stop, TripRequest } from "../src/types";
import { validateItinerary } from "../src/validate";
import { makeRequest, realContext } from "./plannerFixtures";

// Meal sharing (mealShare.ts) runs after the meal fill. The failure it prevents: a day with no
// meal at all while another day of the same base has two, when moving one over (and, if that
// day then lacks one, seating an unused place there) feeds both. The failures it must never
// cause: a must-include moved, a day left with an error, or a day that loses its only meal.

const ctx = realContext();

function mealCount(stops: readonly Stop[]): number {
  let count = 0;
  for (const meal of ["lunch", "dinner"] as const) {
    const fed = stops.some((stop) => {
      const place = ctx.placesById.get(stop.placeId);
      return stop.role === meal || (place && coversMeal(place, stop.start, stop.end, meal));
    });
    if (fed) count++;
  }
  return count;
}

const meals = (days: readonly DayPlan[]) => days.map((day) => mealCount(day.stops));

function share(request: TripRequest, draft: TripDraft): TripDraft {
  const dates = tripDates(request.startDate);
  return shareMeals(draft, request, ctx, dates, new PoolCache(request, ctx));
}

function timedMeals(request: TripRequest, draft: TripDraft): number[] {
  const dates = tripDates(request.startDate);
  return draft.days.map((ids, index) => {
    const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
    if (!anchor) throw new Error("unknown base");
    return mealCount(scheduleDay(ids, dates[index] ?? "", anchor, request, ctx, 0).stops);
  });
}

// Every Rome meal place but Da Enzo and Roscioli is excluded, so nothing is left to fill with.
const TWO_MEAL_PLACES = ["place_009", "place_015", "place_020", "place_042", "place_099"];
const rome = (overrides: Partial<TripRequest> = {}) =>
  makeRequest({
    startDate: "2026-10-20",
    anchors: ["rome"],
    exclude: TWO_MEAL_PLACES,
    ...overrides,
  });
const ROME_DRAFT: TripDraft = {
  anchorIds: ["rome", "rome", "rome"],
  days: [["place_005", "place_003", "place_001", "place_022"], ["place_018"], ["place_007"]],
  score: 0,
};

describe("shareMeals", () => {
  it("never leaves a day with no meal while another day has two and could give one away", () => {
    const request = rome();
    expect(timedMeals(request, ROME_DRAFT)).toEqual([2, 0, 0]);
    const shared = share(request, ROME_DRAFT);
    // Day 2 ends at 10:10 at the Trevi Fountain, too early for lunch without a long wait; day 3's
    // Borghese Gallery ends at 11:40 and leads straight into it.
    expect(timedMeals(request, shared)).toEqual([1, 0, 1]);
    expect(shared.days.flat().sort()).toEqual(ROME_DRAFT.days.flat().sort()); // only moved
  });

  it("never moves a meal place the traveler asked for", () => {
    const request = rome({ mustInclude: ["place_003", "place_022"] });
    expect(share(request, ROME_DRAFT)).toBe(ROME_DRAFT);
  });

  it.each([
    [{ startDate: "2027-02-20", interests: ["food"], maxPriceLevel: 1, anchors: ["florence"] }],
    [{ startDate: "2027-05-10", maxPriceLevel: 1, anchors: ["florence"] }],
    [{ startDate: "2027-12-31", pace: "packed", anchors: ["bologna"] }],
  ] as Partial<TripRequest>[][])(
    "never plans a day with no meal next to a day with two when a swap feeds both (%o)",
    (overrides) => {
      // Review finding: day 1 had lunch and dinner at two places over the budget while day 3,
      // a Monday, ended at 12:50 with nothing, because day 2 took the only dinner place open.
      const itinerary = planDeterministic(makeRequest(overrides), ctx);
      const counts = meals(itinerary.days);
      expect(counts, JSON.stringify(counts)).not.toContain(0);
      const errors = validateItinerary(itinerary, ctx).filter((v) => v.severity === "error");
      expect(errors).toEqual([]);
    },
  );

  it("never gives the market visit the spot of the food hall that feeds a budget traveler", () => {
    // At budget 1 the food hall is one level over, a fallback meal; it still wins the spot.
    const pool = new PoolCache(makeRequest({ maxPriceLevel: 1 }), ctx).strict("florence");
    const ids = pool.map((place) => place.id);
    expect(ids).toContain("place_031");
    expect(ids).not.toContain("place_030");
  });
});
