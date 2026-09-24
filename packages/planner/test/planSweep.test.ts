import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REQUEST_LIMITS } from "../src/config";
import { planDeterministic } from "../src/plan";
import { scheduleDay } from "../src/schedule";
import { addDays, weekdayOf } from "../src/time";
import type { Itinerary, Pace, PriceLevel, TripRequest } from "../src/types";
import { validateItinerary } from "../src/validate";
import { invariantProblems } from "./itineraryInvariants";
import { FC_SETTINGS, makeRequest, realContext } from "./plannerFixtures";

// Failure vector F1: the rules-only planner is the fallback for every AI failure, so an invalid
// plan from it reaches the traveler with nothing left to catch it. These sweeps run it over
// seasons, weekdays, paces, interests, budgets, bases, exclusions, and must-includes, and check
// every hard rule independently (itineraryInvariants.ts) plus the validator.

const ctx = realContext();
const ids = ctx.places.map((place) => place.id);
const tags = [...new Set(ctx.places.flatMap((place) => place.tags))].sort();

// A Monday (museum closures), January (seasonal closures), peak summer, Easter Sunday, New
// Year's Eve (year wrap), leap day, and both Italian DST weekends.
const DATES = [
  "2026-10-19",
  "2027-01-11",
  "2027-01-15",
  "2026-08-14",
  "2026-07-18",
  "2026-04-05",
  "2026-12-31",
  "2028-02-28",
  "2026-03-28",
  "2026-10-24",
];
const PACES: Pace[] = ["relaxed", "balanced", "packed"];
const INTERESTS = [
  [],
  ["food", "wine"],
  ["art", "historic"],
  ["views", "outdoors"],
  tags.slice(0, 8),
];
const BUDGETS: (PriceLevel | null)[] = [null, 1, 2, 3, 4];

/** 30 fixed requests: every date with every pace, interests and budgets rotating. */
function sweepRequests(): TripRequest[] {
  const requests: TripRequest[] = [];
  DATES.forEach((startDate, d) => {
    PACES.forEach((pace, p) => {
      const n = d * PACES.length + p;
      const mustInclude = n % 4 === 1 ? ["place_077", "place_026"] : [];
      const excluded = n % 5 === 2 ? ids.slice(n, n + REQUEST_LIMITS.maxExclude) : [];
      requests.push(
        makeRequest({
          startDate,
          pace,
          interests: INTERESTS[n % INTERESTS.length] ?? [],
          maxPriceLevel: BUDGETS[n % BUDGETS.length] ?? null,
          anchors: n % 7 === 3 ? ["venice"] : n % 7 === 5 ? ["milan", "bologna"] : "auto",
          mustInclude,
          exclude: excluded.filter((id) => !mustInclude.includes(id)),
        }),
      );
    });
  });
  return requests;
}

/** Each day timed again from its ids alone, as a shared link or an edit would do. */
function retimedStops(itinerary: Itinerary) {
  return itinerary.days.map((day) => {
    const anchor = ctx.anchorById.get(day.anchorId);
    if (!anchor) throw new Error(`unknown base ${day.anchorId}`);
    const ids = day.stops.map((stop) => stop.placeId);
    return scheduleDay(ids, day.date, anchor, itinerary.request, ctx, day.transferMin);
  });
}

function withoutReasons(itinerary: Itinerary) {
  return itinerary.days.map((day) => day.stops.map(({ reason, reasonSource, ...stop }) => stop));
}

describe("30-request sweep of planDeterministic on the real data", () => {
  const requests = sweepRequests();

  it("covers a Monday, a January date, and a peak summer date with all three paces", () => {
    expect(requests).toHaveLength(30);
    expect(weekdayOf("2026-10-19")).toBe(1);
    expect(new Set(requests.map((request) => request.pace))).toEqual(new Set(PACES));
  });

  it.each(requests.map((request, n) => [n, request] as const))(
    "request %i: never breaks a hard rule, never fails the validator, never retimes differently",
    (_n, request) => {
      const itinerary = planDeterministic(request, ctx);
      expect(invariantProblems(itinerary, ctx)).toEqual([]);
      expect(validateItinerary(itinerary, ctx).filter((v) => v.severity === "error")).toEqual([]);
      const retimed = retimedStops(itinerary);
      expect(
        retimed.flatMap((day) => day.violations.filter((v) => v.severity === "error")),
      ).toEqual([]);
      expect(retimed.map((day) => day.stops)).toEqual(withoutReasons(itinerary));
      expect(JSON.stringify(planDeterministic(request, ctx))).toBe(JSON.stringify(itinerary));
    },
  );
});

/** Any request the API could accept: known ids, interests, and bases, within the limits. */
const anyRequest: fc.Arbitrary<TripRequest> = fc
  .record({
    offset: fc.integer({ min: 0, max: 1100 }),
    pace: fc.constantFrom<Pace>(...PACES),
    interests: fc.uniqueArray(fc.constantFrom(...tags), { maxLength: REQUEST_LIMITS.maxInterests }),
    maxPriceLevel: fc.constantFrom<PriceLevel | null>(...BUDGETS),
    anchors: fc.oneof(
      fc.constant("auto" as const),
      fc.uniqueArray(fc.constantFrom(...ctx.anchors.map((a) => a.id)), {
        minLength: 1,
        maxLength: 2,
      }),
    ),
    mustInclude: fc.uniqueArray(fc.constantFrom(...ids), {
      maxLength: REQUEST_LIMITS.maxMustInclude,
    }),
    exclude: fc.uniqueArray(fc.constantFrom(...ids), { maxLength: REQUEST_LIMITS.maxExclude }),
  })
  .map(({ offset, mustInclude, exclude, ...rest }) =>
    makeRequest({
      ...rest,
      startDate: addDays("2026-01-01", offset),
      mustInclude,
      exclude: exclude.filter((id) => !mustInclude.includes(id)),
    }),
  );

describe("planDeterministic property sweep (fixed seed)", () => {
  it("never throws, never breaks a hard rule, and never fails the validator for any valid request", () => {
    fc.assert(
      fc.property(anyRequest, (request) => {
        const itinerary = planDeterministic(request, ctx);
        const errors = validateItinerary(itinerary, ctx).filter((v) => v.severity === "error");
        return invariantProblems(itinerary, ctx).length === 0 && errors.length === 0;
      }),
      FC_SETTINGS,
    );
  }, 60_000);
});
