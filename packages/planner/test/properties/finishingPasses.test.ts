import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { coversMeal, servesMeal, sharesLocation } from "../../src/constraints";
import { dayRuleBreaks, inSatelliteArea } from "../../src/dayRules";
import { AFTER_NOON_NAME } from "../../src/planPolicy";
import { PoolCache } from "../../src/pools";
import { type ScheduledDay, scheduleDay } from "../../src/schedule";
import type { Anchor, DayPlan, Itinerary, Meal, Place, Stop, TripRequest } from "../../src/types";
import { anyTripRequest, ctx, PROPERTY_SETTINGS, seedLine } from "./arbitraries";
import { planFor } from "./planMemo";

// The meal fill (mealFill.ts) runs after the walk and the must-include repair. The failures
// these properties prevent: a day that ends with no lunch or dinner while an unused meal place of
// its base could have seated it, and gelato or a wine bar right before lunch. The checks time
// days with scheduleDay and judge them with the day rules alone, so a bug in the fill's own
// checks cannot hide itself here.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 60;

function placeOf(id: string): Place {
  const place = ctx.placesById.get(id);
  if (!place) throw new Error(`unknown place ${id}`);
  return place;
}

function anchorOf(id: string): Anchor {
  const anchor = ctx.anchorById.get(id);
  if (!anchor) throw new Error(`unknown base ${id}`);
  return anchor;
}

/** The meals a planned day has: a stop in that role, or an outing under way through it. */
function mealsOf(stops: readonly Stop[]): Meal[] {
  return (["lunch", "dinner"] as const).filter((meal) =>
    stops.some((s) => s.role === meal || coversMeal(placeOf(s.placeId), s.start, s.end, meal)),
  );
}

/** True when `place` could sit at `at` without splitting the day's one trip out of town. */
function onTheWay(place: Place, places: readonly Place[], at: number, anchor: Anchor): boolean {
  const away = (other: Place | undefined) => other !== undefined && other.city !== anchor.name;
  const before = places.slice(0, at);
  if (place.city === anchor.name) return !(away(before.at(-1)) && away(places[at]));
  return away(before.at(-1)) && inSatelliteArea(place, before, anchor);
}

/**
 * The day with its stops in `order` timed, when that keeps what the planned day got right: no
 * error, every stop still there in the same role, and no stop newly breaking a day rule (or
 * breaking one later); else null.
 */
function cleanChange(
  day: DayPlan,
  order: readonly string[],
  request: TripRequest,
): ScheduledDay | null {
  const timed = scheduleDay(order, day.date, anchorOf(day.anchorId), request, ctx, day.transferMin);
  if (timed.violations.some((v) => v.severity === "error")) return null;
  const roles = new Map(day.stops.map((stop) => [stop.placeId, stop.role]));
  if (timed.stops.some((s) => roles.has(s.placeId) && roles.get(s.placeId) !== s.role)) {
    return null;
  }
  const breaking = new Map<string, number>();
  const ids = day.stops.map((stop) => stop.placeId);
  for (const i of dayRuleBreaks(day.stops, ids.map(placeOf), day.date, [])) {
    breaking.set(ids[i] ?? "", day.stops[i]?.start ?? 0);
  }
  const after = timed.stops.map((stop) => placeOf(stop.placeId));
  const newBreak = dayRuleBreaks(timed.stops, after, day.date, []).some((i) => {
    const stop = timed.stops[i];
    const was = stop ? breaking.get(stop.placeId) : undefined;
    return stop === undefined || was === undefined || stop.start > was;
  });
  return newBreak ? null : timed;
}

/** A meal place that could still seat `meal` on the planned day with nothing else changing. */
function seatableMeal(itinerary: Itinerary, day: DayPlan, meal: Meal): string | null {
  const { request } = itinerary;
  const anchor = anchorOf(day.anchorId);
  const inTrip = itinerary.days.flatMap((d) => d.stops.map((s) => placeOf(s.placeId)));
  const ids = day.stops.map((stop) => stop.placeId);
  const places = ids.map(placeOf);
  for (const place of new PoolCache(request, ctx).strict(anchor.id)) {
    if (!servesMeal(place, meal)) continue;
    if (inTrip.some((other) => other.id === place.id || sharesLocation(other, place))) continue;
    for (let at = 0; at <= ids.length; at++) {
      if (!onTheWay(place, places, at, anchor)) continue;
      const order = [...ids.slice(0, at), place.id, ...ids.slice(at)];
      const timed = cleanChange(day, order, request);
      if (!timed || timed.stops[at]?.role !== meal) continue;
      if (mealsOf(timed.stops).length > mealsOf(day.stops).length) {
        return `${place.id} as ${meal} at position ${at}`;
      }
    }
  }
  return null;
}

describe("the meal fill after the walk", () => {
  beforeAll(() => {
    console.info(seedLine("finishingPasses"));
  });

  it(
    "never ends a day without lunch or dinner that an unused meal place could still seat",
    () => {
      fc.assert(
        fc.property(anyTripRequest, (request) => {
          const itinerary = planFor(request);
          for (const day of itinerary.days) {
            const had = mealsOf(day.stops);
            for (const meal of ["lunch", "dinner"] as const) {
              if (had.includes(meal)) continue;
              expect(seatableMeal(itinerary, day, meal), `${day.date} ${meal}`).toBeNull();
            }
          }
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "never plans gelato or a wine bar the traveler did not ask for right before lunch",
    () => {
      fc.assert(
        fc.property(anyTripRequest, (request) => {
          for (const day of planFor(request).days) {
            day.stops.forEach((stop, index) => {
              const place = placeOf(stop.placeId);
              if (!AFTER_NOON_NAME.test(place.name) || request.mustInclude.includes(place.id)) {
                return;
              }
              expect(day.stops[index + 1]?.role, `${day.date} ${place.name}`).not.toBe("lunch");
            });
          }
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );
});
