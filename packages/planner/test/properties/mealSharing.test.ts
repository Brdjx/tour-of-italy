import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { sharesLocation } from "../../src/constraints";
import type { DayPlan, Itinerary } from "../../src/types";
import { anyTripRequest, ctx, PROPERTY_SETTINGS, seedLine } from "./arbitraries";
import { anchorOf, cleanChange, mealsOf, onTheWay, placeOf } from "./dayChecks";
import { planFor } from "./planMemo";

// Two failures of a finished plan that one move would have fixed. A day with no meal next to a
// day of the same base with two, when moving one of those meal places over feeds both (budget
// Florence: day 1 lunch and dinner, day 3 nothing). And a day with meals but no visit while a
// free public space of the base city could still be added (budget Milan: a lone 12:00 lunch).
// Each check here times the changed days itself and keeps the rules the passes keep.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 60;

/** A move of a meal from `rich` to `hungry` that feeds `hungry` and leaves `rich` one meal. */
function sharableMeal(itinerary: Itinerary, hungry: DayPlan, rich: DayPlan): string | null {
  const { request } = itinerary;
  const anchor = anchorOf(hungry.anchorId);
  const ids = hungry.stops.map((stop) => stop.placeId);
  const places = ids.map(placeOf);
  for (const stop of rich.stops) {
    if (stop.role === "visit" || request.mustInclude.includes(stop.placeId)) continue;
    const kept = rich.stops.map((s) => s.placeId).filter((id) => id !== stop.placeId);
    const left = cleanChange(rich, kept, request);
    if (!left || mealsOf(left.stops).length === 0) continue;
    const place = placeOf(stop.placeId);
    for (let at = 0; at <= ids.length; at++) {
      if (!onTheWay(place, places, at, anchor)) continue;
      const fed = cleanChange(hungry, [...ids.slice(0, at), place.id, ...ids.slice(at)], request);
      if (fed && fed.stops[at]?.role !== "visit" && mealsOf(fed.stops).length > 0) {
        return `${place.id} from ${rich.date} to ${hungry.date} at position ${at}`;
      }
    }
  }
  return null;
}

/** An open-access place of the base city that the visitless day could add as a visit. */
function addableVisit(itinerary: Itinerary, day: DayPlan): string | null {
  const { request } = itinerary;
  const anchor = anchorOf(day.anchorId);
  const inTrip = itinerary.days.flatMap((d) => d.stops.map((s) => placeOf(s.placeId)));
  const ids = day.stops.map((stop) => stop.placeId);
  for (const place of ctx.places) {
    if (place.hoursConfidence !== "open_access" || place.city !== anchor.name) continue;
    if (ctx.anchorIdByPlaceId.get(place.id) !== anchor.id) continue;
    if (request.exclude.includes(place.id)) continue;
    if (inTrip.some((other) => other.id === place.id || sharesLocation(other, place))) continue;
    for (let at = 0; at <= ids.length; at++) {
      const timed = cleanChange(day, [...ids.slice(0, at), place.id, ...ids.slice(at)], request);
      if (timed?.stops[at]?.role === "visit") return `${place.id} at position ${at}`;
    }
  }
  return null;
}

describe("meals and visits shared out between the days of a base", () => {
  beforeAll(() => {
    console.info(seedLine("mealSharing"));
  });

  it(
    "never leaves a day with no meal next to a day with two when moving one over feeds both",
    () => {
      fc.assert(
        fc.property(anyTripRequest, (request) => {
          const itinerary = planFor(request);
          for (const hungry of itinerary.days) {
            if (mealsOf(hungry.stops).length > 0) continue;
            for (const rich of itinerary.days) {
              if (rich.anchorId !== hungry.anchorId || mealsOf(rich.stops).length < 2) continue;
              const move = sharableMeal(itinerary, hungry, rich);
              expect(move, `${hungry.date} has no meal`).toBeNull();
            }
          }
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "never leaves a day with meals and no visit while a public space of the city could join it",
    () => {
      fc.assert(
        fc.property(anyTripRequest, (request) => {
          const itinerary = planFor(request);
          for (const day of itinerary.days) {
            if (day.stops.length === 0 || day.stops.some((s) => s.role === "visit")) continue;
            expect(addableVisit(itinerary, day), `${day.date} has no visit`).toBeNull();
          }
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );
});
