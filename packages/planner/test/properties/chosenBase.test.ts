import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { dayOrigin } from "../../src/anchors";
import { PACE, REQUEST_LIMITS, TRIP_DAYS } from "../../src/config";
import { placesOfAnchor } from "../../src/context";
import { latestStartsFor } from "../../src/dayLimits";
import { keepsDayRules } from "../../src/dayRules";
import { planDeterministic } from "../../src/plan";
import { PoolCache } from "../../src/pools";
import { startCursor, timeStep } from "../../src/schedule";
import { addDays, tripDates } from "../../src/time";
import type { Place, TripRequest } from "../../src/types";
import { validateItinerary } from "../../src/validate";
import {
  anchorIds,
  BUDGET_VALUES,
  ctx,
  FIRST_START,
  PACE_VALUES,
  PROPERTY_SETTINGS,
  START_SPAN_DAYS,
  seedLine,
} from "./arbitraries";

// The review's finding: with must-includes and exclusions drawn from the one base the traveler
// chose, the planner put every must-include on day 1, the base ran dry, and days 2 and 3 moved to
// another base although a plan staying put validates. The general generator spreads its ids over
// every base, so it never starved a chosen base this way; this one does it on purpose.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 50;

/** One chosen base, with must-includes and exclusions drawn from that base's own places. */
const starvedBaseRequest: fc.Arbitrary<TripRequest> = fc
  .record({
    base: fc.constantFrom(...anchorIds),
    offset: fc.integer({ min: 0, max: START_SPAN_DAYS }),
    pace: fc.constantFrom(...PACE_VALUES),
    maxPriceLevel: fc.constantFrom(...BUDGET_VALUES),
    picks: fc.uniqueArray(fc.nat({ max: 40 }), { maxLength: 12 }),
    split: fc.nat({ max: 4 }),
  })
  .map(({ base, offset, picks, split, ...rest }) => {
    const pool = placesOfAnchor(ctx, base).map((place) => place.id);
    const ids = [...new Set(picks.map((pick) => pool[pick % pool.length] ?? ""))];
    const cut = Math.min(split, ids.length);
    return {
      startDate: addDays(FIRST_START, offset),
      interests: [],
      anchors: [base],
      mustInclude: ids.slice(0, cut),
      exclude: ids.slice(cut, cut + REQUEST_LIMITS.maxExclude),
      ...rest,
    };
  });

/**
 * True when the place could be the day's only stop under the planner's rules: timed from the
 * day's start (roles are inferred from arrival, so a market reached at 10:00 is a visit), within
 * its latest start, and keeping the day rules as a rescued day would (dayRules.ts).
 */
function fitsAlone(place: Place, date: string, request: TripRequest): boolean {
  const anchor = ctx.anchorById.get(request.anchors === "auto" ? "" : (request.anchors[0] ?? ""));
  if (!anchor) return false;
  const origin = dayOrigin(anchor, request);
  const { mustInclude, pace } = request;
  const input = { date, pace, transferMin: 0, origin, pool: [place], mustInclude };
  const latest = latestStartsFor({ ...input, mealVisits: true }).get(place.id);
  const step = timeStep(place, date, startCursor(anchor, pace, 0, origin));
  const last = latest?.[step.role];
  if (!step.fits || last === undefined || step.start > last) return false;
  const { role, arrive, start, travelMin } = step;
  const next = { place, role, arrive, start, travelMin, latest };
  const day = { mealVisits: true, clock: PACE[pace].dayStart, mealsTaken: [], today: [], anchor };
  return keepsDayRules({ ...next, obligation: mustInclude.includes(place.id) }, day);
}

/** True when every trip day can get its own distinct candidate place of the chosen base. */
function eachDayHasItsOwnPlace(request: TripRequest): boolean {
  const base = request.anchors === "auto" ? "" : (request.anchors[0] ?? "");
  const pool = new PoolCache(request, ctx).strict(base);
  const options = tripDates(request.startDate).map((date) =>
    pool.filter((place) => fitsAlone(place, date, request)).map((place) => place.id),
  );
  const assign = (day: number, taken: ReadonlySet<string>): boolean => {
    if (day === options.length) return true;
    return (options[day] ?? []).some(
      (id) => !taken.has(id) && assign(day + 1, new Set(taken).add(id)),
    );
  };
  return assign(0, new Set());
}

describe("a chosen base starved by its own must-includes and exclusions", () => {
  beforeAll(() => {
    console.info(seedLine("chosenBase"));
  });

  it(
    "never leaves the chosen base while each day could hold a place of its own there",
    () => {
      let starvedAndKept = 0;
      fc.assert(
        fc.property(starvedBaseRequest, (request) => {
          const itinerary = planDeterministic(request, ctx);
          expect(validateItinerary(itinerary, ctx).filter((v) => v.severity === "error")).toEqual(
            [],
          );
          if (!eachDayHasItsOwnPlace(request)) return;
          starvedAndKept++;
          const bases = itinerary.days.map((day) => day.anchorId);
          expect(bases, JSON.stringify(request)).toEqual(Array(TRIP_DAYS).fill(request.anchors[0]));
        }),
        PROPERTY_SETTINGS,
      );
      expect(starvedAndKept).toBeGreaterThan(PROPERTY_SETTINGS.numRuns / 2); // not vacuous
    },
    TIMEOUT_MS,
  );
});
