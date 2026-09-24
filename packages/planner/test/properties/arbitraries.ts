import fc from "fast-check";
import { INTEREST_EXCLUDED_TAGS, MAX_ANCHORS_PER_TRIP, REQUEST_LIMITS } from "../../src/config";
import type { PlannerContext } from "../../src/context";
import { addDays } from "../../src/time";
import type { Pace, PriceLevel, TripRequest } from "../../src/types";
import { FC_SETTINGS, realContext } from "../plannerFixtures";

// Generators for the planner property tests: any trip request the API could accept against the
// real dataset. Kept in one place so every property file draws from the same space of requests.

export const ctx: PlannerContext = realContext();

/** First and last start dates the properties cover (three full years, leap year included). */
export const FIRST_START = "2026-01-01";
export const LAST_START = "2028-12-31";
/**
 * Days from FIRST_START to LAST_START: 365 in 2026, 365 in 2027, and 365 from 1 January to
 * 31 December of leap 2028. A test asserts addDays(FIRST_START, START_SPAN_DAYS) === LAST_START.
 */
export const START_SPAN_DAYS = 1095;

export const PACE_VALUES: readonly Pace[] = ["relaxed", "balanced", "packed"];
export const BUDGET_VALUES: readonly (PriceLevel | null)[] = [null, 1, 2, 3, 4];

export const placeIds: readonly string[] = ctx.places.map((place) => place.id);
export const anchorIds: readonly string[] = ctx.anchors.map((anchor) => anchor.id);

/** Tags a traveler can pick as interests: every tag in the data minus the non-interest tags. */
export const interestTags: readonly string[] = [
  ...new Set(ctx.places.flatMap((place) => place.tags)),
]
  .filter((tag) => !INTEREST_EXCLUDED_TAGS.includes(tag))
  .sort();

/** Settings every property shares: the fixed seed and the run count (FC_RUNS widens it). */
export const PROPERTY_SETTINGS = { ...FC_SETTINGS };

/** One line naming the seed and runs, so a CI failure can be replayed with FC_SEED. */
export function seedLine(file: string): string {
  return `[${file}] fast-check seed ${PROPERTY_SETTINGS.seed}, ${PROPERTY_SETTINGS.numRuns} runs`;
}

/** Must-include and exclude lists: disjoint, unique, at most REQUEST_LIMITS each. */
const mustAndExclude = fc
  .record({
    picked: fc.uniqueArray(fc.constantFrom(...placeIds), {
      maxLength: REQUEST_LIMITS.maxMustInclude + REQUEST_LIMITS.maxExclude,
    }),
    split: fc.nat({ max: REQUEST_LIMITS.maxMustInclude }),
  })
  .map(({ picked, split }) => {
    // Decision: one unique list split in two, so the lists are disjoint by construction and
    // fast-check shrinks both together toward the smallest failing request.
    const cut = Math.min(split, picked.length);
    return {
      mustInclude: picked.slice(0, cut),
      exclude: picked.slice(cut, cut + REQUEST_LIMITS.maxExclude),
    };
  });

/** "auto" or one to MAX_ANCHORS_PER_TRIP distinct real base ids. */
const anchorsChoice: fc.Arbitrary<TripRequest["anchors"]> = fc.oneof(
  fc.constant("auto" as const),
  fc.uniqueArray(fc.constantFrom(...anchorIds), { minLength: 1, maxLength: MAX_ANCHORS_PER_TRIP }),
);

/**
 * Any valid trip request against the real data: a start date uniform over 2026-01-01 to
 * 2028-12-31, every pace, up to 8 real interests, any budget, "auto" or 1 to 2 real bases, and
 * disjoint must-include and exclude lists of real ids, up to 10 each.
 */
export const anyTripRequest: fc.Arbitrary<TripRequest> = fc
  .record({
    offset: fc.integer({ min: 0, max: START_SPAN_DAYS }),
    pace: fc.constantFrom(...PACE_VALUES),
    interests: fc.uniqueArray(fc.constantFrom(...interestTags), {
      maxLength: REQUEST_LIMITS.maxInterests,
    }),
    maxPriceLevel: fc.constantFrom(...BUDGET_VALUES),
    anchors: anchorsChoice,
    lists: mustAndExclude,
  })
  .map(({ offset, lists, ...rest }) => ({
    startDate: addDays(FIRST_START, offset),
    ...rest,
    mustInclude: lists.mustInclude,
    exclude: lists.exclude,
  }));

/** A request plus a pick of which stop to edit, for the swap properties. */
export const requestAndPick = fc.record({
  request: anyTripRequest,
  day: fc.nat(),
  stop: fc.nat(),
});
