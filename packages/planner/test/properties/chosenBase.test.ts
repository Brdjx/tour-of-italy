import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { dayOrigin } from "../../src/anchors";
import { PACE, REQUEST_LIMITS } from "../../src/config";
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
// Decision: a bound, not "never". The greedy walk can give one day the only place another day
// could have used; the rescue that moved a stop between days was taken out because it kept the
// chosen base in only 1.3 more thin-base trips in 100 (docs/planner.md). Measured over 20,000
// requests on four seeds, 14 of the 19,962 where every day could hold its own place left the base
// (about 1 in 1400), always with a warning. The claim tested is "at most 1 in 1000", read as a
// Poisson count so that another seed or run count cannot fail by chance (allowedDepartures).

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 50;

/** The departure rate the planner claims: at most 1 chosen-base request in 1000. */
const CLAIMED_RATE = 1 / 1000;
/** How rarely the bound may fail by chance when the planner keeps its claim. */
const FALSE_ALARM = 1e-4;

/**
 * The most departures allowed in `possible` requests: the smallest count that a planner leaving
 * at exactly CLAIMED_RATE would exceed less than once in 1 / FALSE_ALARM runs (Poisson tail).
 * 5 at the default 500 runs, 15 at the nightly 5000; a rate ten times the claim still fails the
 * nightly run.
 */
// Decision: a tail bound instead of ceil(possible / 1000). That allowed 1 departure in 500 runs,
// where the chance of 2 is about 4 in 100, so replaying with FC_SEED=1 failed with no code change.
function allowedDepartures(possible: number): number {
  const expected = possible * CLAIMED_RATE;
  let term = Math.exp(-expected); // P(count = 0)
  let atMost = term;
  let count = 0;
  while (1 - atMost >= FALSE_ALARM) {
    count++;
    term *= expected / count;
    atMost += term;
  }
  return count;
}

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
 * its latest start, and keeping the day rules (dayRules.ts).
 */
function fitsAlone(place: Place, date: string, request: TripRequest): boolean {
  const anchor = ctx.anchorById.get(request.anchors === "auto" ? "" : (request.anchors[0] ?? ""));
  if (!anchor) return false;
  const origin = dayOrigin(anchor, request);
  const { mustInclude, pace } = request;
  const input = { date, pace, transferMin: 0, origin, pool: [place], mustInclude };
  const latest = latestStartsFor(input).get(place.id);
  const step = timeStep(place, date, startCursor(anchor, pace, 0, origin));
  const last = latest?.[step.role];
  if (!step.fits || last === undefined || step.start > last) return false;
  const { role, arrive, start, travelMin } = step;
  const next = { place, role, arrive, start, travelMin, latest };
  const day = { clock: PACE[pace].dayStart, mealsTaken: [], today: [], anchor };
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

  it("never fails a replay by chance at the claimed rate (5 allowed in 500 requests, 15 in 5000)", () => {
    expect(allowedDepartures(500)).toBe(5);
    expect(allowedDepartures(5000)).toBe(15);
    expect(allowedDepartures(0)).toBe(0);
  });

  it(
    "never fails the validator, and leaves the chosen base in at most 1 in 1000 requests where each day could hold a place of its own there",
    () => {
      let possible = 0;
      const left: string[] = [];
      fc.assert(
        fc.property(starvedBaseRequest, (request) => {
          const itinerary = planDeterministic(request, ctx);
          expect(validateItinerary(itinerary, ctx).filter((v) => v.severity === "error")).toEqual(
            [],
          );
          if (!eachDayHasItsOwnPlace(request)) return;
          possible++;
          const bases = itinerary.days.map((day) => day.anchorId);
          const kept = bases.every((id) => id === request.anchors[0]);
          if (!kept) left.push(JSON.stringify(request));
          if (!kept) {
            const warned = itinerary.warnings.some((w) => w.code === "ANCHOR_NOT_CHOSEN");
            expect(warned, "a day away from the chosen base carries a warning").toBe(true);
          }
        }),
        PROPERTY_SETTINGS,
      );
      expect(possible).toBeGreaterThan(PROPERTY_SETTINGS.numRuns / 2); // not vacuous
      expect(left.length, left.join("\n")).toBeLessThanOrEqual(allowedDepartures(possible));
    },
    TIMEOUT_MS,
  );
});
