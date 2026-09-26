import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { withReplannedDays } from "../../src/alternatives";
import { MAX_BASES_PER_TRIP, TRIP_DAYS } from "../../src/config";
import { sharesLocation } from "../../src/constraints";
import { checkDayBase } from "../../src/dayBases";
import { planRoute, routeStartDays } from "../../src/dayRoute";
import { type DaySelection, scheduleTrip } from "../../src/trip";
import type { Itinerary } from "../../src/types";
import { validationErrors } from "../../src/validate";
import { anchorIds, anyTripRequest, ctx, PROPERTY_SETTINGS, seedLine } from "./arbitraries";
import { hardRuleProblems } from "./hardRules";
import { planFor } from "./planMemo";

// A route set by hand (dayRoute.ts) on any request the API accepts and any city for each day:
// planning the days it names with the rules, in day order, gives a trip with no place twice, no
// place at the spot of another, no excluded place, every must-include it had, zero validator
// errors, and the independent hard-rule check passing, while the days it keeps are unchanged; or
// the route is refused, only ever for a place asked for or a day where nothing fits, with a reason
// and a way out. Planned one request at a time (the page and the API), each day's check agrees.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 200;

const routeCase = fc.record({
  request: anyTripRequest,
  route: fc.array(fc.constantFrom(...anchorIds), { minLength: TRIP_DAYS, maxLength: TRIP_DAYS }),
});

function selectionOf(itinerary: Itinerary): DaySelection[] {
  return itinerary.days.map((day) => ({
    anchorId: day.anchorId,
    placeIds: day.stops.map((stop) => stop.placeId),
  }));
}

/** Every rule the planned route breaks that the validator might share a blind spot on. */
function tripProblems(itinerary: Itinerary, days: readonly DaySelection[]): string[] {
  const { request } = itinerary;
  const problems: string[] = [];
  const ids = days.flatMap((day) => day.placeIds);
  if (new Set(ids).size !== ids.length) problems.push("a place twice");
  const places = ids.flatMap((id) => {
    const place = ctx.placesById.get(id);
    return place ? [place] : [];
  });
  places.forEach((place, at) => {
    if (places.slice(at + 1).some((other) => sharesLocation(place, other))) {
      problems.push(`${place.id} shares a spot with another stop`);
    }
    if (request.exclude.includes(place.id)) problems.push(`${place.id} is excluded`);
  });
  days.forEach((day, index) => {
    for (const id of day.placeIds) {
      if (ctx.anchorIdByPlaceId.get(id) !== day.anchorId)
        problems.push(`${id} not in day ${index}`);
    }
  });
  return problems;
}

describe("a route set by hand", () => {
  beforeAll(() => {
    console.info(seedLine("dayRoute"));
  });

  it(
    "plans to a valid trip with no place twice, or is refused for a place asked for or an empty day",
    () => {
      let allowed = 0;
      let threeCities = 0;
      let refused = 0;
      fc.assert(
        fc.property(routeCase, ({ request, route }) => {
          const itinerary = planFor(request);
          const days = selectionOf(itinerary);
          const plan = planRoute(request, days, route, ctx);
          if (!plan.allowed) {
            refused++;
            const refusal = plan.refusal;
            expect(["holds_must_include", "nothing_fits"]).toContain(refusal?.code);
            expect(refusal?.reason.length ?? 0).toBeGreaterThan(0);
            expect(refusal?.fix.length ?? 0).toBeGreaterThan(0);
            expect(plan.days[refusal?.day ?? -1]?.refusal?.reason).toBe(refusal?.reason);
            expect(plan.rulesDays).toBeNull();
            return;
          }
          allowed++;
          if (new Set(route).size === 3) threeCities++;
          const planned = plan.rulesDays as DaySelection[];
          expect(planned.map((day) => day.anchorId)).toEqual(route);
          const timed = scheduleTrip(request, planned, ctx).days;
          const applied = withReplannedDays(
            itinerary,
            timed.map((dayPlan, day) => ({ day, dayPlan })),
            ctx,
          );
          expect(tripProblems(applied, planned)).toEqual([]);
          expect(validationErrors(applied, ctx)).toEqual([]);
          expect(hardRuleProblems(applied, ctx, MAX_BASES_PER_TRIP)).toEqual([]);
          const had = new Set(days.flatMap((day) => day.placeIds));
          const kept = new Set(planned.flatMap((day) => day.placeIds));
          for (const id of request.mustInclude) {
            if (had.has(id)) expect(kept.has(id), `${id} was lost`).toBe(true);
          }
          days.forEach((day, index) => {
            if (!plan.replan.includes(index)) expect(planned[index]).toEqual(day);
            else expect(planned[index]?.placeIds.length ?? 0).toBeGreaterThan(0);
          });
          // One request at a time, as the page and the API plan it: the same days.
          const working = routeStartDays(days, plan);
          for (const index of plan.replan) {
            const check = checkDayBase(request, working, index, route[index] as string, ctx);
            expect(check.option.reason).toBeUndefined();
            working[index] = check.day as DaySelection;
          }
          expect(working).toEqual(planned);
        }),
        PROPERTY_SETTINGS,
      );
      console.info(
        `[dayRoute] allowed ${allowed}, three cities ${threeCities}, refused ${refused}`,
      );
      // Not vacuous: most routes plan, many of them with three cities.
      expect(allowed).toBeGreaterThan(PROPERTY_SETTINGS.numRuns / 2);
      expect(threeCities).toBeGreaterThan(PROPERTY_SETTINGS.numRuns / 10);
    },
    TIMEOUT_MS * 2,
  );
});
