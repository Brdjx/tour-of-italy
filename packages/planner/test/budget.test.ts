import { describe, expect, it } from "vitest";
import { TRIP_DAYS } from "../src/config";
import { planDeterministic } from "../src/plan";
import type { Itinerary } from "../src/types";
import { validateItinerary } from "../src/validate";
import { makeRequest, realContext } from "./plannerFixtures";

// The budget is a filter on suggestions, with two reviewed exceptions: one open-access public
// space may rescue a day nothing within budget can fill (tripRescue.ts), and a meal place one
// price level over may seat a meal no place within budget can (pools.ts, isMealFallback). The
// failures these tests prevent: an over-budget stop a thinner trip avoids, an over-budget visit,
// a budget traveler left with no meal at all, and a fallback meal where one within budget fits.

const ctx = realContext();

const errorsOf = (itinerary: Itinerary) =>
  validateItinerary(itinerary, ctx).filter((v) => v.severity === "error");

/** The over-budget stops of a plan, split into meals and visits. */
function overBudget(itinerary: Itinerary) {
  const limit = itinerary.request.maxPriceLevel ?? 4;
  const stops = itinerary.days.flatMap((day, index) =>
    day.stops.map((stop) => ({ stop, index, place: ctx.placesById.get(stop.placeId) })),
  );
  const over = stops.filter(({ place }) => (place?.priceLevel ?? 0) > limit);
  return {
    meals: over.filter(({ stop }) => stop.role !== "visit"),
    visits: over.filter(({ stop }) => stop.role === "visit"),
  };
}

describe("over-budget stops", () => {
  it("never adds an over-budget public space while a spread trip within budget exists", () => {
    // The review's repro: the rescue ran before fewer visits a day were tried, so Florence at
    // budget 1 got Oltrarno (EUR 2) on day 3 although a spread trip needed no rescue.
    const request = makeRequest({
      startDate: "2027-05-10",
      maxPriceLevel: 1,
      anchors: ["florence"],
    });
    const itinerary = planDeterministic(request, ctx);
    const over = overBudget(itinerary);
    expect(over.visits).toEqual([]);
    // Meals may be one level over (pools.ts, isMealFallback), each with its warning.
    for (const { place } of over.meals) expect(place?.priceLevel).toBe(2);
    const warned = itinerary.warnings.filter((w) => w.code === "OVER_BUDGET");
    expect(warned.map((w) => w.placeId)).toEqual(over.meals.map(({ place }) => place?.id));
    expect(itinerary.days.map((day) => day.anchorId)).toEqual(Array(TRIP_DAYS).fill("florence"));
  });

  it("rescues a day nothing in budget can fill with one open-access public space at most", () => {
    // Milan at budget 1 on a Monday to Wednesday has two places within budget for three days.
    const request = makeRequest({ startDate: "2027-05-10", maxPriceLevel: 1, anchors: ["milan"] });
    const itinerary = planDeterministic(request, ctx);
    const { meals, visits } = overBudget(itinerary);
    const days = new Set(visits.map(({ index }) => index));
    expect(days.size).toBe(visits.length); // never two over-budget visits on one day
    for (const { place } of visits) expect(place?.hoursConfidence).toBe("open_access");
    for (const { place } of meals) expect(place?.priceLevel).toBe(2);
    expect(itinerary.days.map((day) => day.anchorId)).toEqual(Array(TRIP_DAYS).fill("milan"));
  });

  it("never leaves a budget traveler without a meal that a place one level over could seat", () => {
    // Review finding: at budget 1, Rome has one lunch counter and Milan no meal place at all, so
    // 70% of budget days had no meal and case 07 (Rome, 2026-10-06) had five MEAL_MISSING.
    const request = makeRequest({ startDate: "2026-10-06", maxPriceLevel: 1, anchors: ["rome"] });
    const itinerary = planDeterministic(request, ctx);
    const missing = itinerary.warnings.filter((w) => w.code === "MEAL_MISSING");
    expect(missing.length).toBeLessThanOrEqual(1); // five meal places for six meals
    const { meals, visits } = overBudget(itinerary);
    expect(visits).toEqual([]);
    expect(meals.length).toBeGreaterThan(0);
    for (const { place } of meals) expect(place?.priceLevel).toBe(2);
    expect(errorsOf(itinerary)).toEqual([]);
  });

  it("never seats a meal over the budget while a place within it could take that meal", () => {
    // Rome at budget 2 has enough meal places of its own: the fallback must stay unused.
    const request = makeRequest({ startDate: "2026-10-06", maxPriceLevel: 2, anchors: ["rome"] });
    const itinerary = planDeterministic(request, ctx);
    expect(overBudget(itinerary).meals).toEqual([]);
    expect(itinerary.warnings.filter((w) => w.code === "OVER_BUDGET")).toEqual([]);
  });
});
