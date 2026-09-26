import { describe, expect, it } from "vitest";
import { withReplannedDays } from "../src/alternatives";
import { MAX_ANCHORS_PER_TRIP } from "../src/config";
import { checkDayBase, routeOptions } from "../src/dayBases";
import { mustIncludesLeftOut, newTripErrors } from "../src/dayChecks";
import { dayTravel, planRoute, type RoutePlan, routeStartDays } from "../src/dayRoute";
import { planDeterministic } from "../src/plan";
import { type DaySelection, scheduleTrip } from "../src/trip";
import type { Itinerary, TripRequest } from "../src/types";
import { validateItinerary, validationErrors } from "../src/validate";
import { realContext } from "./plannerFixtures";

// A route the traveler sets by hand (dayRoute.ts): a city for every day, in any order, with the
// travel stated as facts, the days planned again and why, and the only refusals: a place asked for
// that no day of the route can take, and a day where nothing fits. Each route here is checked by
// planning its days with the rules, as the page does on the device, and by the validator.

const ctx = realContext();

function request(overrides: Partial<TripRequest> = {}): TripRequest {
  return {
    startDate: "2026-10-19", // a Monday
    pace: "balanced",
    interests: ["historic"],
    maxPriceLevel: null,
    anchors: ["rome"],
    mustInclude: [],
    exclude: [],
    ...overrides,
  };
}

function selectionOf(itinerary: Pick<Itinerary, "days">): DaySelection[] {
  return itinerary.days.map((day) => ({
    anchorId: day.anchorId,
    placeIds: day.stops.map((stop) => stop.placeId),
  }));
}

function trip(overrides: Partial<TripRequest> = {}) {
  const req = request(overrides);
  const itinerary = planDeterministic(req, ctx);
  return { req, itinerary, days: selectionOf(itinerary) };
}

/** The route's rules-only trip, timed, as the page would show it. */
function timed(req: TripRequest, plan: RoutePlan): Itinerary {
  const days = plan.rulesDays as DaySelection[];
  return {
    request: req,
    days: scheduleTrip(req, days, ctx).days,
    source: "deterministic",
    warnings: [],
    meta: { attempts: 0, latencyMs: 0, generatedAt: "2026-09-26T00:00:00.000Z" },
  };
}

/** Every place id of the trip, in day order. */
const allIds = (days: readonly DaySelection[]) => days.flatMap((day) => day.placeIds);

/** Checks the route's rules trip: valid, no place twice, days not planned again unchanged. */
function expectPlannedWell(req: TripRequest, days: DaySelection[], plan: RoutePlan) {
  expect(plan.allowed).toBe(true);
  const planned = plan.rulesDays as DaySelection[];
  expect(planned.map((day) => day.anchorId)).toEqual(plan.route);
  const ids = allIds(planned);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(req.exclude).not.toContain(id);
  expect(validationErrors(timed(req, plan), ctx)).toEqual([]);
  days.forEach((day, index) => {
    if (!plan.replan.includes(index)) expect(planned[index]).toEqual(day);
  });
  // Planned one day at a time as the page and the API do, each day's check gives the same days.
  const working = routeStartDays(days, plan);
  for (const index of plan.replan) {
    const check = checkDayBase(req, working, index, plan.route[index] as string, ctx);
    expect(check.option.reason).toBeUndefined();
    working[index] = check.day as DaySelection;
  }
  expect(working).toEqual(planned);
}

const rome = trip();

describe("planRoute", () => {
  it("moves day 1 to Florence and plans day 2 again, which no longer fits after the travel", () => {
    const plan = planRoute(rome.req, rome.days, ["florence", "rome", "rome"], ctx);

    expect(plan).toMatchObject({
      changed: true,
      allowed: true,
      replan: [0, 1],
      travelMin: 130,
      message: "Day 1 now in Florence.",
      refusal: null,
    });
    const [day1, day2, day3] = plan.days;
    expect(day1).toMatchObject({
      anchorId: "florence",
      name: "Florence",
      changes: true,
      replan: "city",
      travelIn: null,
      startMin: 570,
      note: "Day 1 will be planned in Florence.",
      warnings: [],
      refusal: null,
    });
    expect(day1?.travelOut).toMatchObject({ fromName: "Florence", toName: "Rome", minutes: 130 });
    expect(day2).toMatchObject({
      changes: false,
      replan: "travel",
      startMin: 700,
      freeMin: 440,
      note: "Day 2 will be planned again: it now starts after 2 h 10 min of travel.",
      warnings: [
        "2 h 10 min by high-speed train from Florence, so the day starts at 11:40.",
        "Leaves about 7 h before dinner.",
      ],
    });
    expect(day2?.travelIn).toEqual({
      fromAnchorId: "florence",
      fromName: "Florence",
      toAnchorId: "rome",
      toName: "Rome",
      minutes: 130,
      label: "2 h 10 min by high-speed train",
    });
    expect(day3).toMatchObject({ replan: null, note: null, warnings: [] });
    expectPlannedWell(rome.req, rome.days, plan);
  });

  it("gives every day its own city: Rome, Florence, Venice", () => {
    const plan = planRoute(rome.req, rome.days, ["rome", "florence", "venice"], ctx);

    expect(plan).toMatchObject({
      replan: [1, 2],
      travelMin: 250,
      message: "Route changed: Rome, Florence, Venice.",
    });
    expect(plan.days.map((day) => day.note)).toEqual([
      null,
      "Day 2 will be planned in Florence.",
      "Day 3 will be planned in Venice.",
    ]);
    expect(plan.days[2]?.warnings).toEqual([
      "2 h by high-speed train from Florence, so the day starts at 11:30.",
      "Leaves about 7 h 30 min before dinner.",
    ]);
    expectPlannedWell(rome.req, rome.days, plan);
    // The whole-trip planners' limit still holds where the API asks for it.
    const codes = validateItinerary(timed(rome.req, plan), ctx, {
      maxBases: MAX_ANCHORS_PER_TRIP,
    }).map((v) => v.code);
    expect(codes).toContain("TOO_MANY_ANCHORS");
  });

  it("moves all three days to Florence with no travel and no place twice", () => {
    const plan = planRoute(rome.req, rome.days, ["florence", "florence", "florence"], ctx);

    expect(plan).toMatchObject({
      replan: [0, 1, 2],
      travelMin: 0,
      message: "Route changed: Florence, Florence, Florence.",
    });
    expect(plan.days.every((day) => day.warnings.length === 0)).toBe(true);
    expectPlannedWell(rome.req, rome.days, plan);
  });

  it("goes away for a day and back: Rome, Rome, Florence to Rome, Florence, Rome", () => {
    const start = planRoute(rome.req, rome.days, ["rome", "rome", "florence"], ctx);
    const days = start.rulesDays as DaySelection[];
    const plan = planRoute(rome.req, days, ["rome", "florence", "rome"], ctx);

    expect(plan).toMatchObject({
      replan: [1, 2],
      travelMin: 260,
      message: "Route changed: Rome, Florence, Rome.",
    });
    expect(plan.days.map((day) => day.startMin)).toEqual([570, 700, 700]);
    expectPlannedWell(rome.req, days, plan);
  });

  it("goes from Florence to Milan and back for a day each way", () => {
    const florence = trip({ anchors: ["florence"] });
    const plan = planRoute(florence.req, florence.days, ["milan", "florence", "milan"], ctx);

    expect(plan).toMatchObject({ replan: [0, 1, 2], travelMin: 270 });
    expect(plan.days[1]?.warnings[0]).toBe(
      "2 h 15 min by high-speed train from Milan, so the day starts at 11:45.",
    );
    expectPlannedWell(florence.req, florence.days, plan);
  });

  it("keeps a day that still fits its new start, and says when it now starts", () => {
    const two = trip({ pace: "relaxed", interests: [], anchors: ["rome", "florence"] });
    expect(two.days.map((day) => day.anchorId)).toEqual(["rome", "florence", "florence"]);
    const plan = planRoute(two.req, two.days, ["florence", "florence", "rome"], ctx);

    expect(plan.replan).toEqual([0, 2]);
    expect(plan.days[1]).toMatchObject({
      replan: null,
      startMin: 600,
      note: "Day 2 keeps its places and now starts at 10:00.",
    });
    expectPlannedWell(two.req, two.days, plan);
  });

  it("plans a day again when losing its travel breaks it, and says it has none now", () => {
    // Planned for 13:35 after 3 h 35 min from Milan, the day's stops do not fit a 10:00 start.
    const two = trip({ pace: "relaxed", interests: [], anchors: ["milan", "rome"] });
    expect(two.days.map((day) => day.anchorId)).toEqual(["milan", "rome", "rome"]);
    const plan = planRoute(two.req, two.days, ["rome", "rome", "rome"], ctx);

    expect(plan.days[1]).toMatchObject({
      replan: "travel",
      note: "Day 2 will be planned again: it now starts at 10:00, with no travel.",
    });
    expectPlannedWell(two.req, two.days, plan);
  });

  it("gives a place asked for to the next day of its city planned again", () => {
    const must = trip({ mustInclude: ["place_001"] });
    expect(must.days[0]?.placeIds).toContain("place_001");
    const plan = planRoute(must.req, must.days, ["florence", "rome", "rome"], ctx);

    expect(plan.replan).toEqual([0, 1]);
    expect(plan.rulesDays?.[1]?.placeIds).toContain("place_001");
    expectPlannedWell(must.req, must.days, plan);
  });

  it("plans a kept day of the city again to hold a place asked for", () => {
    // Day 1 holds the Colosseum and moves; day 3, the next Rome day, keeps its travel.
    const must = trip({
      mustInclude: ["place_001"],
      pace: "relaxed",
      interests: [],
      anchors: "auto",
    });
    const plan = planRoute(must.req, must.days, ["florence", "florence", "rome"], ctx);

    expect(plan.days[2]).toMatchObject({
      replan: "must_include",
      note: "Day 3 will be planned again to hold Colosseum, which you asked for.",
    });
    expect(plan.rulesDays?.[2]?.placeIds).toContain("place_001");
    expectPlannedWell(must.req, must.days, plan);
  });

  it("gives a place asked for to a kept day of its city the validator only warns about", () => {
    // Bologna from a Monday, relaxed, with Via Drapperie on day 1: days 1 and 2 go to Rome. The
    // validator calls the place unplaceable on day 3 (a warning, not an error), so only the rules'
    // day finds it room there; without that pass the route would be refused.
    const must = trip({ mustInclude: ["place_046"], pace: "relaxed", anchors: ["bologna"] });
    expect(must.days[0]?.placeIds).toContain("place_046");
    const plan = planRoute(must.req, must.days, ["rome", "rome", "bologna"], ctx);

    expect(plan.allowed).toBe(true);
    expect(plan.days[2]).toMatchObject({
      replan: "must_include",
      note: "Day 3 will be planned again to hold Via Drapperie, Bologna, which you asked for.",
    });
    expect(plan.rulesDays?.[2]?.placeIds).toContain("place_046");
    expectPlannedWell(must.req, must.days, plan);
  });

  it("keeps a day that was to hold a place asked for when a day planned before it takes it", () => {
    // Bologna from a Monday, relaxed, with Via Drapperie on day 1, which goes to Rome. The first
    // pass plans day 2 again for its travel and, as the validator found day 3 room for the place
    // while day 2 still had its stops, day 3 to hold it; planned in day order, day 2 takes it.
    const must = trip({
      mustInclude: ["place_046"],
      pace: "relaxed",
      anchors: ["bologna"],
      interests: ["historic", "food"],
    });
    expect(must.days[0]?.placeIds).toContain("place_046");
    const plan = planRoute(must.req, must.days, ["rome", "bologna", "bologna"], ctx);

    expect(plan.allowed).toBe(true);
    expect(plan.replan).toEqual([0, 1]);
    expect(plan.days[2]).toMatchObject({ replan: null, note: null });
    expect(plan.rulesDays?.[1]?.placeIds).toContain("place_046");
    expect(plan.rulesDays?.[2]).toEqual(must.days[2]);
    expectPlannedWell(must.req, must.days, plan);
  });

  it("refuses a route with no day in the city of a place asked for, and says how to fix it", () => {
    const must = trip({ mustInclude: ["place_001"] });
    const plan = planRoute(must.req, must.days, ["florence", "florence", "florence"], ctx);
    const refusal = {
      code: "holds_must_include",
      reason:
        "Day 1 has Colosseum, which you asked for, and no other day of this route is in Rome.",
      fix: "Keep day 1 in Rome, or remove Colosseum from day 1 first.",
    };

    expect(plan).toMatchObject({
      allowed: false,
      rulesDays: null,
      refusal: { day: 0, ...refusal },
    });
    expect(plan.days.map((day) => day.refusal)).toEqual([refusal, null, null]);
  });

  it("refuses a route whose days in the place's city cannot take it", () => {
    // The Uffizi closes on Mondays, and day 1, the only Florence day left, is one.
    const must = trip({ mustInclude: ["place_026"], anchors: ["florence"], pace: "relaxed" });
    const holder = must.days.findIndex((day) => day.placeIds.includes("place_026"));
    expect(holder).toBe(1);
    const plan = planRoute(must.req, must.days, ["florence", "rome", "rome"], ctx);

    expect(plan.refusal).toEqual({
      day: 1,
      code: "holds_must_include",
      reason:
        "Day 2 has Uffizi Gallery, which you asked for, and no day of this route in Florence can take it.",
      fix: "Keep day 2 in Florence, or remove Uffizi Gallery from day 2 first.",
    });
  });

  it("refuses a day where nothing fits, after its travel or with the settings", () => {
    const milan = ctx.anchorById.get("milan")?.placeIds ?? [];
    const req = request({ exclude: milan });
    const days = selectionOf(planDeterministic(req, ctx));
    const late = planRoute(req, days, ["rome", "rome", "milan"], ctx);
    const first = planRoute(req, days, ["milan", "rome", "rome"], ctx);

    expect(late.refusal).toEqual({
      day: 2,
      code: "nothing_fits",
      reason: "Nothing in Milan fits day 3 after 3 h 35 min of travel.",
      fix: "Keep day 3 in Rome, or choose another city for it.",
    });
    expect(late.days[2]?.refusal?.code).toBe("nothing_fits");
    expect(first.refusal?.reason).toBe("Nothing in Milan fits day 1 with your settings.");
  });

  it("changes nothing for the trip's own route", () => {
    const plan = planRoute(rome.req, rome.days, ["rome", "rome", "rome"], ctx);

    expect(plan).toMatchObject({
      changed: false,
      allowed: true,
      replan: [],
      travelMin: 0,
      message: "",
      refusal: null,
      rulesDays: rome.days,
    });
    expect(plan.days.every((day) => day.note === null && day.replan === null)).toBe(true);
  });

  it("throws on a route of the wrong length or with an unknown base", () => {
    expect(() => planRoute(rome.req, rome.days, ["rome", "rome"], ctx)).toThrow(RangeError);
    expect(() => planRoute(rome.req, rome.days, ["rome", "atlantis", "rome"], ctx)).toThrow(
      RangeError,
    );
  });

  it("is fast enough for every tap, and deterministic", () => {
    const route = ["milan", "florence", "venice"];
    const first = planRoute(rome.req, rome.days, route, ctx);
    const started = performance.now();
    for (let run = 0; run < 20; run++) planRoute(rome.req, rome.days, route, ctx);
    const each = (performance.now() - started) / 20;
    console.info(`planRoute, three new cities: ${Math.round(each * 100) / 100} ms a route`);
    // A frame is 16 ms; the budget allows 5x for a slow runner or coverage.
    expect(each).toBeLessThan(16 * 5);
    expect(planRoute(rome.req, rome.days, route, ctx)).toEqual(first);
  });
});

describe("routeStartDays", () => {
  it("empties the days to plan again at their new cities and keeps the rest", () => {
    const plan = planRoute(rome.req, rome.days, ["florence", "rome", "rome"], ctx);

    expect(routeStartDays(rome.days, plan)).toEqual([
      { anchorId: "florence", placeIds: [] },
      { anchorId: "rome", placeIds: [] },
      rome.days[2],
    ]);
  });
});

describe("mustIncludesLeftOut", () => {
  it("catches a route day that loses a place asked for, which newTripErrors cannot see", () => {
    // Day 3 holds Da Enzo al 29 and is planned again after its new travel. The trip sent with
    // it has day 3 empty, so the restaurant is already missing there, and the validator finds
    // it room on day 1, which the route keeps: the error is one the trip "already had".
    const must = trip({ mustInclude: ["place_003"] });
    expect(must.days[2]?.placeIds).toContain("place_003");
    const plan = planRoute(must.req, must.days, ["rome", "florence", "rome"], ctx);
    expect(plan.replan).toEqual([1, 2]);
    const working = routeStartDays(must.days, plan);
    working[1] = checkDayBase(must.req, working, 1, "florence", ctx).day as DaySelection;
    const rules = checkDayBase(must.req, working, 2, "rome", ctx).day as DaySelection;
    const without = {
      anchorId: "rome",
      placeIds: rules.placeIds.filter((id) => id !== "place_003"),
    };

    expect(newTripErrors(must.req, working, 2, without, ctx)).toEqual([]);
    expect(mustIncludesLeftOut(must.req, 2, rules, without, ctx)).toEqual([
      expect.objectContaining({
        code: "MUST_INCLUDE_MISSING",
        severity: "error",
        day: 2,
        placeId: "place_003",
        detail: "You asked for Da Enzo al 29, and it fits on day 3, but it is not in the plan.",
      }),
    ]);
    expect(mustIncludesLeftOut(must.req, 2, rules, rules, ctx)).toEqual([]);
  });

  it("counts only places asked for, and names one it does not know as a place", () => {
    const req = request({ mustInclude: ["place_001", "place_x"] });
    const rules = { anchorId: "rome", placeIds: ["place_001", "place_002", "place_x"] };
    const day = { anchorId: "rome", placeIds: ["place_002"] };

    expect(mustIncludesLeftOut(req, 0, rules, day, ctx).map((v) => v.detail)).toEqual([
      "You asked for Colosseum, and it fits on day 1, but it is not in the plan.",
      "You asked for a place, and it fits on day 1, but it is not in the plan.",
    ]);
  });
});

describe("dayTravel", () => {
  it("states a planned day's travel, its start and the time before dinner", () => {
    const route = ["rome", "milan", "venice"];
    const relaxed = request({ pace: "relaxed" });

    expect(dayTravel(relaxed, route, 1, ctx)).toMatchObject({
      startMin: 815,
      freeMin: 325,
      warnings: [
        "3 h 35 min by high-speed train from Rome, so the day starts at 13:35.",
        "Leaves about 5 h before dinner.",
      ],
    });
    expect(dayTravel(relaxed, route, 0, ctx)).toMatchObject({ travelIn: null, warnings: [] });
    expect(dayTravel(relaxed, route, 2, ctx).travelOut).toBeNull();
  });
});

describe("routeOptions", () => {
  it("judges each city for a day against the route being set, the trip's own city first", () => {
    const route = ["rome", "florence", "rome"];
    const options = routeOptions(rome.req, rome.days, route, 2, ctx);

    expect(options.map((o) => o.anchorId)).toEqual([
      "rome",
      ...ctx.anchors.map((a) => a.id).filter((id) => id !== "rome"),
    ]);
    expect(options[0]).toMatchObject({ current: true, allowed: true, replans: [1] });
    const venice = options.find((o) => o.anchorId === "venice");
    expect(venice).toMatchObject({
      current: false,
      allowed: true,
      transferInMin: 120,
      replans: [1],
      warnings: [
        "2 h by high-speed train from Florence, so the day starts at 11:30.",
        "Leaves about 7 h 30 min before dinner.",
        "Day 2 will be planned in Florence.",
      ],
      // The other days' notes end the warnings, each with its day and why, so a list can say
      // each fact once.
      others: [{ day: 1, replan: "city", note: "Day 2 will be planned in Florence." }],
    });
  });

  it("gives a refused city its reason and way out", () => {
    const must = trip({ mustInclude: ["place_001"] });
    const route = ["florence", "florence", "rome"];
    const options = routeOptions(must.req, must.days, route, 2, ctx);
    const venice = options.find((o) => o.anchorId === "venice");

    expect(venice).toMatchObject({
      allowed: false,
      refusal: "holds_must_include",
      reason:
        "Day 1 has Colosseum, which you asked for, and no other day of this route is in Rome.",
      fix: "Keep day 1 in Rome, or remove Colosseum from day 1 first.",
      refusalDay: 0,
    });
  });
});

describe("withReplannedDays", () => {
  it("applies a route's days as one edit, and drops the summary when a city changes", () => {
    const plan = planRoute(rome.req, rome.days, ["rome", "florence", "venice"], ctx);
    const timedDays = scheduleTrip(rome.req, plan.rulesDays as DaySelection[], ctx).days;
    const replanned = plan.replan.map((day) => ({
      day,
      dayPlan: timedDays[day] as Itinerary["days"][number],
    }));
    const next = withReplannedDays({ ...rome.itinerary, summary: "Rome." }, replanned, ctx);

    expect(selectionOf(next)).toEqual(plan.rulesDays);
    expect(next.days.map((day) => day.transferMin)).toEqual([0, 130, 120]);
    expect(next.summary).toBeUndefined();
    expect(validationErrors(next, ctx)).toEqual([]);
    const same = withReplannedDays({ ...rome.itinerary, summary: "Rome." }, [], ctx);
    expect(same.summary).toBe("Rome.");
    expect(() =>
      withReplannedDays(
        rome.itinerary,
        [{ day: 3, dayPlan: timedDays[0] as Itinerary["days"][number] }],
        ctx,
      ),
    ).toThrow(RangeError);
  });
});
