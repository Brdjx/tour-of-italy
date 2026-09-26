import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { sharesLocation } from "../../src/constraints";
import { addMissingMeals } from "../../src/mealFill";
import { mealGaps } from "../../src/mealSupply";
import { type DaySelection, scheduleTrip } from "../../src/trip";
import type { Itinerary, Place, TripRequest } from "../../src/types";
import { validateItinerary, validationErrors } from "../../src/validate";
import { anyTripRequest, ctx, PROPERTY_SETTINGS, seedLine } from "./arbitraries";
import { planFor } from "./planMemo";

// The meal causes (mealSupply.ts) and the meal completion the API gives an AI day
// (addMissingMeals, mealFill.ts). The failures these properties prevent: a "Meal missing" chip
// with no cause, or a cause with no chip; a meal added that breaks a rule, repeats a place, or
// moves one of the model's stops; and a meal added where none could be open. The AI days are the
// rules plan's days with their meals taken out and some visits dropped, as a model that skips
// meals would answer.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 80;

function timed(request: TripRequest, days: readonly DaySelection[]): Itinerary {
  return {
    request,
    days: scheduleTrip(request, days, ctx).days,
    source: "ai",
    warnings: [],
    meta: { attempts: 1, latencyMs: 0, generatedAt: "2026-09-26T00:00:00.000Z" },
  };
}

/** The plan's days with their lunches and dinners out, and a visit out where `keep` says so. */
function aiDays(plan: Itinerary, keep: readonly boolean[]): DaySelection[] {
  let at = 0;
  return plan.days.map((day) => ({
    anchorId: day.anchorId,
    placeIds: day.stops.flatMap((stop) => {
      if (stop.role !== "visit") return [];
      const kept = keep[at++ % keep.length] !== false;
      return kept ? [stop.placeId] : [];
    }),
  }));
}

/** "day|meal" for each MEAL_MISSING the validator gives the plan. */
function warned(plan: Itinerary): string[] {
  return validateItinerary(plan, ctx)
    .filter((v) => v.code === "MEAL_MISSING")
    .map((v) => `${v.day}|${v.detail.includes("no lunch") ? "lunch" : "dinner"}`)
    .sort();
}

const aiAnswer = fc.record({
  request: anyTripRequest,
  keep: fc.array(fc.boolean(), { minLength: 1, maxLength: 24 }),
});

describe("missing meals and the meals code adds", () => {
  beforeAll(() => {
    console.info(seedLine("mealGaps"));
  });

  it(
    "gives every MEAL_MISSING warning exactly one cause, and no cause without one",
    () => {
      fc.assert(
        fc.property(aiAnswer, ({ request, keep }) => {
          const plan = planFor(request);
          for (const trip of [plan, timed(request, aiDays(plan, keep))]) {
            const gaps = mealGaps(trip, ctx).map((gap) => `${gap.day}|${gap.meal}`);
            expect(gaps.sort()).toEqual(warned(trip));
          }
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "adds meals to an AI day with no validator error, no repeat and every stop kept, and none where none is open",
    () => {
      fc.assert(
        fc.property(aiAnswer, ({ request, keep }) => {
          const days = aiDays(planFor(request), keep);
          if (days.some((day) => day.placeIds.length === 0)) return; // an empty day is an error
          const before = timed(request, days);
          if (validationErrors(before, ctx).length > 0) return; // the check would have refused it
          const { days: fed, added } = addMissingMeals(request, days, ctx);
          const after = timed(request, fed);

          expect(validationErrors(after, ctx)).toEqual([]);
          const places = fed.flatMap((day) => day.placeIds);
          expect(new Set(places).size).toBe(places.length);
          const known = places.map((id) => ctx.placesById.get(id) as Place);
          known.forEach((a, i) => {
            for (const b of known.slice(i + 1)) expect(sharesLocation(a, b)).toBe(false);
          });
          fed.forEach((day, index) => {
            const own = day.placeIds.filter((id) => days[index]?.placeIds.includes(id));
            expect(own).toEqual(days[index]?.placeIds);
          });
          const noneOpen = new Set(
            mealGaps(before, ctx)
              .filter((gap) => gap.cause === "none_open")
              .map((gap) => `${gap.day}|${gap.meal}`),
          );
          for (const meal of added) {
            expect(noneOpen.has(`${meal.day}|${meal.meal}`)).toBe(false);
            const stop = after.days[meal.day]?.stops.find((s) => s.placeId === meal.placeId);
            expect(stop?.role).toBe(meal.meal);
          }
          // A meal that was missing and had none open is still missing, for the same cause.
          const still = mealGaps(after, ctx).map((gap) => `${gap.day}|${gap.meal}|${gap.cause}`);
          for (const key of noneOpen) expect(still).toContain(`${key}|none_open`);
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );
});
