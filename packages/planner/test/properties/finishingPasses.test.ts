import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { PACE } from "../../src/config";
import { isOuting, servesMeal, sharesLocation } from "../../src/constraints";
import { daylightEnd } from "../../src/dayRules";
import { fillMissingMeals } from "../../src/mealFill";
import { repairMustIncludes } from "../../src/mustRepair";
import {
  AFTER_NOON_NAME,
  MAX_IDLE_MIN,
  MEAL_WAIT_MAX_MIN,
  OUTING_LATEST_START,
} from "../../src/planPolicy";
import { PoolCache } from "../../src/pools";
import { shortenRoutes } from "../../src/route";
import { type ScheduledDay, scheduleDay } from "../../src/schedule";
import { tripDates } from "../../src/time";
import { chooseTrip, type TripDraft } from "../../src/tripBuilder";
import { transferInto } from "../../src/tripWalk";
import type { DayPlan, Itinerary, Meal, TripRequest } from "../../src/types";
import { anyTripRequest, ctx, PROPERTY_SETTINGS, seedLine } from "./arbitraries";
import { anchorOf, cleanChange, longestIdle, mealsOf, onTheWay, placeOf } from "./dayChecks";
import { planFor } from "./planMemo";

// The passes that change a finished trip (route.ts reorders a day, mealFill.ts adds a meal) run
// after the walk has timed every must-include and meal with care. The failures these properties
// prevent: a polish that moves a requested day trip into the afternoon or past sunset, a day
// that ends with no dinner while an unused meal place of its base could have seated it, a polish
// that leaves the traveler idle for hours to save minutes of walking, and gelato before lunch.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 60;

/** Each day of a draft timed as the plan times it. */
function timedDays(draft: TripDraft, request: TripRequest): ScheduledDay[] {
  const dates = tripDates(request.startDate);
  return draft.days.map((ids, index) => {
    const anchor = anchorOf(draft.anchorIds[index] ?? "");
    const transferMin = transferInto(draft.anchorIds, index, ctx);
    return scheduleDay(ids, dates[index] ?? "", anchor, request, ctx, transferMin);
  });
}

/** Start times of the stops that start an outing after noon or end a daylight place too late. */
function lateStarts(day: ScheduledDay, date: string): Map<string, number> {
  const late = new Map<string, number>();
  for (const stop of day.stops) {
    const place = placeOf(stop.placeId);
    const lateOuting = stop.role === "visit" && isOuting(place) && stop.start > OUTING_LATEST_START;
    if (lateOuting || stop.end > daylightEnd(place, date)) late.set(stop.placeId, stop.start);
  }
  return late;
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

describe("the passes after the walk keep what the walk got right", () => {
  beforeAll(() => {
    console.info(seedLine("finishingPasses"));
  });

  it(
    "never lets the route pass push any stop, a must-include included, past noon or sunset",
    () => {
      fc.assert(
        fc.property(anyTripRequest, (request) => {
          const dates = tripDates(request.startDate);
          const draft = chooseTrip(request, ctx, dates);
          if (!draft) return;
          const before = timedDays(draft, request);
          const after = timedDays(shortenRoutes(draft, request, ctx, dates), request);
          after.forEach((day, index) => {
            const was = lateStarts(before[index] as ScheduledDay, dates[index] ?? "");
            for (const [id, start] of lateStarts(day, dates[index] ?? "")) {
              expect(was.get(id), `${id} newly late on day ${index + 1}`).toBeDefined();
              expect(start, `${id} moved later on day ${index + 1}`).toBeLessThanOrEqual(
                was.get(id) ?? Number.NEGATIVE_INFINITY,
              );
            }
          });
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );

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
    "never lets the route pass or the meal fill leave the traveler waiting for hours to save minutes",
    () => {
      fc.assert(
        fc.property(anyTripRequest, (request) => {
          const dates = tripDates(request.startDate);
          const walked = chooseTrip(request, ctx, dates);
          if (!walked) return;
          const routed = shortenRoutes(walked, request, ctx, dates);
          const repaired = repairMustIncludes(routed, request, ctx, dates);
          const fed = fillMissingMeals(repaired, request, ctx, dates, new PoolCache(request, ctx));
          const [walk, route, repair, fill] = [walked, routed, repaired, fed].map((draft) =>
            timedDays(draft, request),
          );
          dates.forEach((date, index) => {
            const start = PACE[request.pace].dayStart + transferInto(walked.anchorIds, index, ctx);
            const idle = (days: ScheduledDay[] | undefined) =>
              longestIdle(days?.[index]?.stops ?? [], start);
            const routeCap = Math.max(idle(walk), MAX_IDLE_MIN);
            expect(idle(route), `${date}: route pass`).toBeLessThanOrEqual(routeCap);
            const fillCap = Math.max(idle(repair), MEAL_WAIT_MAX_MIN);
            expect(idle(fill), `${date}: meal fill`).toBeLessThanOrEqual(fillCap);
          });
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
