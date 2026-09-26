import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { withReplannedDay, withReplannedDays } from "../../src/alternatives";
import { MAX_BASES_PER_TRIP } from "../../src/config";
import { sharesLocation } from "../../src/constraints";
import { checkDayBase, dayBaseOptions } from "../../src/dayBases";
import { planRoute } from "../../src/dayRoute";
import { planDay } from "../../src/planDay";
import { type DaySelection, scheduleTrip } from "../../src/trip";
import type { Itinerary } from "../../src/types";
import { validationErrors } from "../../src/validate";
import {
  anchorIds,
  anyTripRequest,
  ctx,
  PROPERTY_SETTINGS,
  placeIds,
  seedLine,
} from "./arbitraries";
import { hardRuleProblems } from "./hardRules";
import { planFor } from "./planMemo";

// Re-planning one day of a planned trip (planDay.ts) and the cities a day may move to
// (dayBases.ts), on any request the API accepts, any day, any base, and any places to avoid.
// The day never repeats a place of another day, never uses an excluded or avoided place, and a
// city the options allow always gives a trip the validator and the independent hard-rule check
// both pass once the days it names are planned again (dayRoute.ts). No other day changes.

const TIMEOUT_MS = 60_000 + PROPERTY_SETTINGS.numRuns * 200;

/** A request, the day to re-plan, a base, and up to five places to avoid. */
const replan = fc.record({
  request: anyTripRequest,
  day: fc.nat(),
  base: fc.constantFrom(...anchorIds),
  avoid: fc.uniqueArray(fc.constantFrom(...placeIds), { maxLength: 5 }),
});

/** The trip's days as a selection: each day's base and place ids. */
function selectionOf(itinerary: Itinerary) {
  return itinerary.days.map((day) => ({
    anchorId: day.anchorId,
    placeIds: day.stops.map((stop) => stop.placeId),
  }));
}

/** Every rule the re-planned day breaks against the trip it joins, as readable strings. */
function dayProblems(
  itinerary: Itinerary,
  index: number,
  base: string,
  ids: readonly string[],
  avoid: readonly string[],
): string[] {
  const { request } = itinerary;
  const others = itinerary.days.flatMap((day, at) =>
    at === index ? [] : day.stops.map((stop) => stop.placeId),
  );
  const problems: string[] = [];
  if (new Set(ids).size !== ids.length) problems.push("a place twice on the day");
  for (const id of ids) {
    const place = ctx.placesById.get(id);
    if (!place) problems.push(`${id} is not a place`);
    if (ctx.anchorIdByPlaceId.get(id) !== base) problems.push(`${id} is not in ${base}`);
    if (others.includes(id)) problems.push(`${id} is on another day`);
    const twin = others.find((other) => {
      const placed = ctx.placesById.get(other);
      return place && placed && sharesLocation(place, placed);
    });
    if (twin) problems.push(`${id} is at the same spot as ${twin} on another day`);
    if (request.exclude.includes(id)) problems.push(`${id} is excluded`);
    if (avoid.includes(id) && !request.mustInclude.includes(id)) problems.push(`${id} is avoided`);
  }
  return problems;
}

describe("re-planning one day of a trip", () => {
  beforeAll(() => {
    console.info(seedLine("planDay"));
  });

  it(
    "never repeats another day's place or its spot, and never uses an excluded or avoided place",
    () => {
      fc.assert(
        fc.property(replan, ({ request, day, base, avoid }) => {
          const itinerary = planFor(request);
          const index = day % itinerary.days.length;
          const days = selectionOf(itinerary);
          const planned = planDay(request, days, index, base, ctx, { avoid });
          expect(planned.anchorId).toBe(base);
          expect(dayProblems(itinerary, index, base, planned.placeIds, avoid)).toEqual([]);
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "always gives a valid trip when the day is planned again at its own base",
    () => {
      fc.assert(
        fc.property(replan, ({ request, day, avoid }) => {
          const itinerary = planFor(request);
          const index = day % itinerary.days.length;
          const days = selectionOf(itinerary);
          const base = days[index]?.anchorId as string;
          const check = checkDayBase(request, days, index, base, ctx, { avoid });
          // A new version of a day always fits: at worst it is the day the trip already had.
          const planned = check.day ?? planDay(request, days, index, base, ctx, { avoid });
          const rebuilt = rebuiltTrip(itinerary, index, planned.anchorId, planned.placeIds);
          if (check.option.allowed) {
            expect(validationErrors(rebuilt, ctx)).toEqual([]);
            expect(hardRuleProblems(rebuilt, ctx)).toEqual([]);
          } else {
            // Only avoiding places can empty the day's own base.
            expect(avoid.length).toBeGreaterThan(0);
            expect(check.option.reason).toMatch(/^Nothing in /);
          }
        }),
        PROPERTY_SETTINGS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "gives a trip with zero validator errors for every city the options allow, planning only the days it names",
    () => {
      let allowed = 0;
      let moved = 0;
      fc.assert(
        fc.property(replan, ({ request, day }) => {
          const itinerary = planFor(request);
          const index = day % itinerary.days.length;
          const days = selectionOf(itinerary);
          for (const option of dayBaseOptions(request, days, index, ctx)) {
            if (!option.allowed) {
              expect(option.reason?.length ?? 0).toBeGreaterThan(0);
              expect(option.fix?.length ?? 0).toBeGreaterThan(0);
              expect(option.refusal).toBeDefined();
              continue;
            }
            allowed++;
            if (option.current) continue;
            moved++;
            const route = days.map((d, at) => (at === index ? option.anchorId : d.anchorId));
            const plan = planRoute(request, days, route, ctx);
            expect(plan.replan).toEqual([index, ...option.replans].sort((a, b) => a - b));
            const planned = plan.rulesDays ?? [];
            const rebuilt = rebuiltRoute(itinerary, planned);
            expect(validationErrors(rebuilt, ctx)).toEqual([]);
            expect(hardRuleProblems(rebuilt, ctx, MAX_BASES_PER_TRIP)).toEqual([]);
            days.forEach((d, at) => {
              if (!plan.replan.includes(at)) expect(planned[at]).toEqual(d);
            });
          }
        }),
        PROPERTY_SETTINGS,
      );
      // Not vacuous: most trips can move some day to another city.
      expect(allowed).toBeGreaterThan(PROPERTY_SETTINGS.numRuns);
      expect(moved).toBeGreaterThan(PROPERTY_SETTINGS.numRuns / 2);
    },
    TIMEOUT_MS * 3,
  );
});

/** The itinerary with a route's days, timed from their ids as the page applies them. */
function rebuiltRoute(itinerary: Itinerary, days: readonly DaySelection[]): Itinerary {
  const timed = scheduleTrip(itinerary.request, days, ctx).days;
  return withReplannedDays(
    itinerary,
    timed.map((dayPlan, day) => ({ day, dayPlan })),
    ctx,
  );
}

/** The itinerary with the day replaced, timed the way the page applies a re-planned day. */
function rebuiltTrip(
  itinerary: Itinerary,
  index: number,
  base: string,
  ids: readonly string[],
): Itinerary {
  const days = selectionOf(itinerary).map((day, at) =>
    at === index ? { anchorId: base, placeIds: ids } : day,
  );
  const timed = scheduleTrip(itinerary.request, days, ctx).days[index];
  return withReplannedDay(itinerary, index, timed as Itinerary["days"][number], ctx);
}
