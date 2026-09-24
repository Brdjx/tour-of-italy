import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { TRIP_DAYS } from "../../src/config";
import { placesOfAnchor } from "../../src/context";
import { type DaySelection, scheduleTrip } from "../../src/trip";
import type { Itinerary, Violation } from "../../src/types";
import { validateItinerary } from "../../src/validate";
import { anchorIds, anyTripRequest, ctx, PROPERTY_SETTINGS, seedLine } from "./arbitraries";
import { hardRuleProblems } from "./hardRules";
import { ONE_SIDED, sharedKeys } from "./violationKeys";

// Failure vector F10 prep: the scheduler (scheduleDay, used for AI picks, shared links, and every
// edit in the browser) and the validator (the server's last gate) were written independently.
// If they disagree, either the browser shows a plan the server rejects, or an impossible plan
// passes. Here fast-check times ARBITRARY id orders, most of them infeasible, and asserts the two
// report exactly the same problems, and that both agree with the first-principles re-check.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 50;

/** Up to nine picks per day, as indexes into that day's base; duplicates are skipped. */
const dayPicks = fc.array(fc.nat({ max: 60 }), { maxLength: 9 });

/** A request, one or two bases spread over the days, and an arbitrary order of places per day. */
const anySelection = fc.record({
  request: anyTripRequest,
  bases: fc.uniqueArray(fc.constantFrom(...anchorIds), { minLength: 1, maxLength: 2 }),
  pattern: fc.array(fc.nat({ max: 1 }), { minLength: TRIP_DAYS, maxLength: TRIP_DAYS }),
  picks: fc.array(dayPicks, { minLength: TRIP_DAYS, maxLength: TRIP_DAYS }),
});

type AnySelection = typeof anySelection extends fc.Arbitrary<infer T> ? T : never;

/** The selection as place ids: each day's picks mapped into its base, never reusing an id. */
function selectionOf(input: AnySelection): DaySelection[] {
  const used = new Set<string>();
  return input.pattern.map((which, day) => {
    const anchorId = input.bases[which] ?? input.bases[0] ?? "";
    const pool = placesOfAnchor(ctx, anchorId);
    const placeIds: string[] = [];
    for (const pick of input.picks[day] ?? []) {
      const id = pool[pick % pool.length]?.id;
      if (id === undefined || used.has(id)) continue;
      used.add(id);
      placeIds.push(id);
    }
    return { anchorId, placeIds };
  });
}

/** The selection timed by scheduleTrip, and the same days as an itinerary for the validator. */
function timed(input: AnySelection): { itinerary: Itinerary; scheduler: Violation[] } {
  const trip = scheduleTrip(input.request, selectionOf(input), ctx);
  const itinerary: Itinerary = {
    request: input.request,
    days: trip.days,
    source: "deterministic",
    warnings: [],
    meta: { attempts: 0, latencyMs: 0, generatedAt: "1970-01-01T00:00:00.000Z" },
  };
  return { itinerary, scheduler: trip.violations };
}

describe("scheduleDay and validateItinerary on arbitrary orders of places", () => {
  beforeAll(() => {
    console.info(seedLine("schedulerVsValidator"));
  });

  it(
    "never lets the scheduler and the validator report different problems for the same day",
    () => {
      fc.assert(
        fc.property(anySelection, (input) => {
          const { itinerary, scheduler } = timed(input);
          expect(sharedKeys(validateItinerary(itinerary, ctx))).toEqual(sharedKeys(scheduler));
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "never lets either side accept a day the first-principles re-check rejects, or the reverse",
    () => {
      fc.assert(
        fc.property(anySelection, (input) => {
          const { itinerary, scheduler } = timed(input);
          const validatorErrors = validateItinerary(itinerary, ctx).filter(
            (v) => v.severity === "error" && !ONE_SIDED.has(v.code),
          );
          const schedulerErrors = scheduler.filter((v) => v.severity === "error");
          const problems = hardRuleProblems(itinerary, ctx);
          expect(validatorErrors.length === 0).toBe(problems.length === 0);
          expect(schedulerErrors.length === 0).toBe(problems.length === 0);
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );
});
