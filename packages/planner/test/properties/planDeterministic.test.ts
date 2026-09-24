import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_ANCHORS_PER_TRIP, TRIP_DAYS } from "../../src/config";
import { sharesLocation } from "../../src/constraints";
import { compareViolations, planDeterministic } from "../../src/plan";
import { ItinerarySchema, tripRequestSchemaFor } from "../../src/schemas";
import { addDays } from "../../src/time";
import type { Itinerary, TripRequest } from "../../src/types";
import { validateItinerary } from "../../src/validate";
import {
  anchorIds,
  anyTripRequest,
  ctx,
  FIRST_START,
  interestTags,
  LAST_START,
  PROPERTY_SETTINGS,
  placeIds,
  START_SPAN_DAYS,
  seedLine,
} from "./arbitraries";
import { hardRuleProblems, insideOneOpenRange, silentlyDroppedMustIncludes } from "./hardRules";
import { planFor } from "./planMemo";

// Failure vector F1: planDeterministic is the plan whenever the AI is off and the fallback for
// every AI failure, so an invalid plan from it reaches the traveler with nothing left to catch it.
// Each property runs over the same seeded stream of requests; plans are memoized by request
// (planMemo.ts) so one planner call serves every property (determinism uses a fresh call).

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 50;
/** Asserts `check` holds for the plan of every generated request. */
function forEveryPlan(check: (itinerary: Itinerary, request: TripRequest) => void): void {
  fc.assert(
    fc.property(anyTripRequest, (request) => {
      check(planFor(request), request);
    }),
    PROPERTY_SETTINGS,
  );
}

const known = tripRequestSchemaFor({
  tags: new Set(interestTags),
  placeIds: new Set(placeIds),
  anchorIds: new Set(anchorIds),
});

describe("planDeterministic over any valid trip request", () => {
  beforeAll(() => {
    console.info(seedLine("planDeterministic"));
  });

  it("never tests a request the API would reject, and covers 2026-01-01 to 2028-12-31", () => {
    expect(addDays(FIRST_START, START_SPAN_DAYS)).toBe(LAST_START);
    fc.assert(
      fc.property(anyTripRequest, (request) => {
        expect(known.safeParse(request).success).toBe(true);
      }),
      PROPERTY_SETTINGS,
    );
  });

  it(
    "never throws for a request the API accepts",
    () => {
      forEveryPlan((itinerary) => {
        expect(itinerary.source).toBe("deterministic");
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never returns the wrong number of days or days that are not consecutive from the start",
    () => {
      forEveryPlan((itinerary, request) => {
        expect(itinerary.days).toHaveLength(TRIP_DAYS);
        const dates = itinerary.days.map((day) => day.date);
        const expected = Array.from({ length: TRIP_DAYS }, (_, i) => addDays(request.startDate, i));
        expect(dates).toEqual(expected);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never returns a plan the validator rejects",
    () => {
      forEveryPlan((itinerary) => {
        const errors = validateItinerary(itinerary, ctx).filter((v) => v.severity === "error");
        expect(errors).toEqual([]);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never schedules the same place twice, or two places at one spot unless both were asked for",
    () => {
      forEveryPlan((itinerary, request) => {
        const stops = itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
        expect(new Set(stops).size).toBe(stops.length);
        const places = stops.map((id) => ctx.placesById.get(id));
        places.forEach((a, i) => {
          for (const b of places.slice(i + 1)) {
            if (!a || !b || !sharesLocation(a, b)) continue;
            expect([a.id, b.id].every((id) => request.mustInclude.includes(id))).toBe(true);
          }
        });
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never uses more bases than MAX_ANCHORS_PER_TRIP or a base that does not exist",
    () => {
      forEveryPlan((itinerary) => {
        const bases = new Set(itinerary.days.map((day) => day.anchorId));
        expect(bases.size).toBeLessThanOrEqual(MAX_ANCHORS_PER_TRIP);
        for (const base of bases) expect(ctx.anchorById.has(base)).toBe(true);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never schedules a stop outside one open range on its date (hoursOn re-check)",
    () => {
      forEveryPlan((itinerary) => {
        for (const day of itinerary.days) {
          for (const stop of day.stops) {
            const place = ctx.placesById.get(stop.placeId);
            expect(place).toBeDefined();
            if (place) expect(insideOneOpenRange(place, day.date, stop)).toBe(true);
          }
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never overlaps stops, skips travel, or breaks another hard rule (independent re-check)",
    () => {
      forEveryPlan((itinerary) => {
        expect(hardRuleProblems(itinerary, ctx)).toEqual([]);
        for (const day of itinerary.days) {
          day.stops.forEach((stop, i) => {
            const before = day.stops[i - 1];
            if (before) expect(stop.start).toBeGreaterThan(before.end);
          });
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never drops a must-include place without a warning that says why",
    () => {
      forEveryPlan((itinerary) => {
        expect(silentlyDroppedMustIncludes(itinerary)).toEqual([]);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never sends an error as a warning or a plan that fails the response schema",
    () => {
      forEveryPlan((itinerary) => {
        expect(itinerary.warnings.filter((v) => v.severity !== "warning")).toEqual([]);
        expect(ItinerarySchema.safeParse(itinerary).success).toBe(true);
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never shows the traveler other warnings than the validator gives the same plan (F10)",
    () => {
      forEveryPlan((itinerary) => {
        const warnings = validateItinerary(itinerary, ctx).filter((v) => v.severity === "warning");
        expect(itinerary.warnings).toEqual(warnings.sort(compareViolations));
      });
    },
    TIMEOUT_MS,
  );

  it(
    "never gives a different plan for the same request, and never changes the caller's request",
    () => {
      fc.assert(
        fc.property(anyTripRequest, (request) => {
          const before = structuredClone(request);
          const first = planFor(request);
          const second = planDeterministic(structuredClone(request), ctx);
          expect(second).toEqual(first);
          expect(JSON.stringify(second)).toBe(JSON.stringify(first));
          expect(request).toEqual(before);
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );
});
