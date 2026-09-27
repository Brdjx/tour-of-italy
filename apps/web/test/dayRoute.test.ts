import {
  type DaySelection,
  type Itinerary,
  planRoute,
  validationErrors,
  withDay,
  withReplannedDays,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import type { PlanDayResponse } from "../lib/apiSchemas";
import { tripKey, tripSelection } from "../lib/dayCity";
import {
  type DayJob,
  dayChoices,
  daysTitle,
  IDEAS_WAIT,
  ideasRun,
  jobBody,
  lockedText,
  planAction,
  planningText,
  type ReplannedResult,
  type ReplanRun,
  replanMessage,
  resolveJob,
  routeRun,
  routeView,
  SHORT_REASONS,
  sameRoute,
  travelFacts,
  tripRoute,
  waitingText,
} from "../lib/dayRoute";
import { ctx, dayAnswerFor, fixturePlan, must } from "./fixtures";

// A route set by hand, the page's side (decision 16): what the route sheet shows for a route
// being set, the run that plans its days one request at a time, and the check each answer must
// pass before the page takes it. What would break the product: a city refused for its travel, a
// consequence the sheet does not show, a place on two days, a day the validator rejects shown as
// checked, or a fallback that claims the AI planned it.

/** Three days in Rome (fixturePlan). */
const plan = fixturePlan();
const ROME = "rome";
const FLORENCE = "florence";
const VENICE = "venice";

function ids(itinerary: Itinerary, day: number): string[] {
  return itinerary.days[day]?.stops.map((stop) => stop.placeId) ?? [];
}

/** The run for `route`, from the fixture plan. */
function runFor(route: string[], itinerary: Itinerary = plan): ReplanRun {
  return routeRun(
    itinerary,
    planRoute(itinerary.request, tripSelection(itinerary), route, ctx),
    ctx,
  );
}

/** Every day of `run` answered as the API would, in order: the results and the trip they make. */
function answerAll(run: ReplanRun, itinerary: Itinerary = plan) {
  let working: DaySelection[] = run.start;
  const results: ReplannedResult[] = [];
  for (const job of run.jobs) {
    const response = dayAnswerFor(jobBody(itinerary.request, working, job, run.route));
    const resolved = resolveJob(itinerary, working, job, { kind: "answer", response }, ctx);
    if (resolved.kind !== "day") throw new Error(resolved.reason);
    const placeIds = resolved.dayPlan.stops.map((stop) => stop.placeId);
    working = withDay(working, job.day, { anchorId: job.anchorId, placeIds });
    results.push({ day: job.day, dayPlan: resolved.dayPlan, made: resolved.made });
  }
  return { results, working };
}

describe("the route view", () => {
  it("shows each day's city and the travel into it, with nothing to plan before a change", () => {
    expect(tripRoute(plan)).toEqual([ROME, ROME, ROME]);
    expect(sameRoute(plan, [ROME, ROME, ROME])).toBe(true);
    const view = routeView(plan, tripRoute(plan), ctx);
    expect(view.changed).toBe(false);
    expect(view.travel).toBeNull();
    expect(view.rows.map((row) => [row.name, row.date, row.start, row.legIn, row.was])).toEqual([
      ["Rome", "Tue 6 Oct", "09:30", null, null],
      ["Rome", "Wed 7 Oct", "09:30", "Same city", null],
      ["Rome", "Thu 8 Oct", "09:30", "Same city", null],
    ]);
    expect(view.rows.every((row) => row.note === null && row.facts.length === 0)).toBe(true);
  });

  it("marks a changed day and plans the next one again for its travel, with the facts", () => {
    const view = routeView(plan, [ROME, FLORENCE, ROME], ctx);
    expect(view).toMatchObject({ changed: true, allowed: true, action: "Plan day 2 and day 3" });
    expect(view.travel).toBe("Travel between cities: 4 h 20 min");
    const [first, second, third] = view.rows;
    expect(first).toMatchObject({ was: null, note: null, facts: [], replan: false });
    // Each fact once: the leg gives the train, the day's column its start, and "was Rome" the
    // change, so a changed day has no note and only what its travel leaves.
    expect(second).toEqual({
      day: 1,
      date: "Wed 7 Oct",
      start: "11:40",
      anchorId: FLORENCE,
      name: "Florence",
      was: "Rome",
      legIn: "2 h 10 min by high-speed train",
      note: null,
      facts: ["Leaves about 7 h before dinner."],
      replan: true,
      refusal: null,
    });
    expect(third).toMatchObject({
      start: "11:40",
      was: null,
      replan: true,
      note: "Day 3 will be planned again: it now starts after 2 h 10 min of travel.",
      facts: ["Leaves about 7 h before dinner."],
    });
  });

  it("names the action by the days it plans", () => {
    expect(routeView(plan, [FLORENCE, "milan", VENICE], ctx).action).toBe("Plan all three days");
    expect(planAction([2])).toBe("Plan day 3");
    expect(planAction([0, 1])).toBe("Plan day 1 and day 2");
  });

  it("shows a refused route on the day it fails, with the way out", () => {
    // The Uffizi was asked for, and day 1 is the trip's only Florence day.
    const pinned = fixturePlan({ mustInclude: ["place_026"] });
    const view = routeView(pinned, [ROME, ROME, ROME], ctx);
    expect(view.allowed).toBe(false);
    expect(view.rows[0]?.refusal).toBe(
      "Day 1 has Uffizi Gallery, which you asked for, and no other day of this route is in Florence. Keep day 1 in Florence, or remove Uffizi Gallery from day 1 first.",
    );
    expect(view.rows.slice(1).every((row) => row.refusal === null)).toBe(true);
  });
});

// Decision 17: a city that leaves a day with no lunch or dinner open says so before it is
// chosen, as a fact like the travel ones, and stays a choice. The owner's route: Rome, Venice,
// Bologna from Saturday 10 October, day 3 a Monday, when none of Bologna's dinner places opens.
describe("a meal a city cannot give a day", () => {
  const saturday = fixturePlan({ startDate: "2026-10-10" });
  const BOLOGNA = "bologna";

  it("says on the route that Bologna has no dinner on Mondays, not the hours left before it", () => {
    const view = routeView(saturday, [ROME, VENICE, BOLOGNA], ctx);
    expect(view).toMatchObject({ allowed: true, action: "Plan day 2 and day 3" });
    expect(view.rows[2]).toMatchObject({
      name: "Bologna",
      start: "11:55",
      legIn: "2 h 25 min by train or car",
      facts: ["No dinner place listed for Bologna opens on Mondays."],
    });
    // Venice has dinner on a Sunday: its day keeps what the travel leaves.
    expect(view.rows[1]?.facts).toEqual(["Leaves about 6 h before dinner."]);
  });

  it("warns on Bologna in day 3's cities, and on no other city, and Bologna stays a choice", () => {
    const choices = dayChoices(saturday, [ROME, VENICE, ROME], 2, ctx);
    const bologna = must(choices.rows.find((row) => row.anchorId === BOLOGNA));
    expect(bologna).toMatchObject({
      allowed: true,
      warnings: [
        "2 h 25 min by train or car from Venice, so the day starts at 11:55.",
        "No dinner place listed for Bologna opens on Mondays.",
      ],
    });
    const others = choices.rows.filter((row) => row.anchorId !== BOLOGNA);
    expect(others.flatMap((row) => row.warnings).filter((fact) => fact.startsWith("No "))).toEqual(
      [],
    );
  });

  it("says both meals when the train from Rome also leaves no lunch in reach", () => {
    const relaxed = fixturePlan({ startDate: "2026-10-10", pace: "relaxed" });
    const view = routeView(relaxed, [ROME, ROME, BOLOGNA], ctx);
    expect(view.rows[2]?.facts).toEqual([
      "No lunch place listed for Bologna can take lunch after the travel from Rome.",
      "No dinner place listed for Bologna opens on Mondays.",
    ]);
  });

  it("drops only the hours before dinner, and only when there is no dinner to have", () => {
    const travel = ["2 h by train from Venice, so the day starts at 11:30.", "Leaves about 7 h."];
    expect(travelFacts(travel, [])).toEqual(travel);
    expect(travelFacts(travel, ["No lunch place listed for Bologna opens on Sundays."])).toEqual(
      travel,
    );
    expect(travelFacts(travel, ["No dinner place listed for Bologna opens on Mondays."])).toEqual([
      travel[0],
    ]);
    expect(travelFacts([], ["No dinner place is listed for Testville."])).toEqual([]);
  });
});

describe("a day's cities", () => {
  it("lists the trip's city first and says what each other city adds, travel never refused", () => {
    const choices = dayChoices(plan, tripRoute(plan), 0, ctx);
    expect(choices.rows.map((row) => row.anchorId)).toEqual([
      ROME,
      FLORENCE,
      "milan",
      VENICE,
      "bologna",
    ]);
    expect(choices.rows[0]).toEqual({
      anchorId: ROME,
      name: "Rome",
      planned: true,
      chosen: true,
      allowed: true,
      line: "Same city as day\u00a02, 30 places",
      warnings: [],
      reason: null,
    });
    // The minutes once: the line gives the travel on to day 2, and the warning what it does.
    expect(choices.rows[1]).toMatchObject({
      planned: false,
      chosen: false,
      allowed: true,
      line: "2 h 10 min on to Rome for day\u00a02, 22 places",
      warnings: ["Day 2 will be planned again."],
    });
    expect(choices.rows.every((row) => row.allowed)).toBe(true);
    expect(choices.ideas).toEqual({ allowed: true, reason: null });
  });

  it("leaves out what the route being set already does, and new ideas wait for it", () => {
    const draft = [ROME, FLORENCE, ROME];
    const third = dayChoices(plan, draft, 2, ctx);
    // Day 2 in Florence is the draft's already: no city of day 3 says it again.
    expect(
      third.rows.some((row) => row.warnings.includes("Day 2 will be planned in Florence.")),
    ).toBe(false);
    expect(third.rows[0]).toMatchObject({
      anchorId: ROME,
      planned: true,
      chosen: true,
      warnings: [
        "2 h 10 min by high-speed train from Florence, so the day starts at 11:40.",
        "Leaves about 7 h before dinner.",
      ],
    });
    expect(third.rows[1]).toMatchObject({
      anchorId: FLORENCE,
      line: "Same city as day\u00a02, 22 places",
      warnings: [],
    });
    expect(third.ideas).toEqual({ allowed: false, reason: IDEAS_WAIT });
    // Day 2's own list: Rome is planned now, Florence is chosen.
    const second = dayChoices(plan, draft, 1, ctx);
    expect(second.rows[0]).toMatchObject({ anchorId: ROME, planned: true, chosen: false });
    expect(second.rows[1]).toMatchObject({ anchorId: FLORENCE, planned: false, chosen: true });
    expect(second.rows[1]?.line).toBe("2 h 10 min on to Rome for day\u00a03, 22 places");
  });

  it("keeps the next day's whole note when it keeps its places at a new start", () => {
    // Rome, Rome, Florence: day 2 in Milan leaves day 3's places as they are, at 11:45.
    const two = fixturePlan({ anchors: [ROME, FLORENCE] });
    expect(tripRoute(two)).toEqual([ROME, ROME, FLORENCE]);
    const milan = dayChoices(two, tripRoute(two), 1, ctx).rows.find((row) => row.name === "Milan");
    expect(milan).toMatchObject({
      line: "2 h 15 min on to Florence for day\u00a03, 18 places",
      warnings: [
        "3 h 35 min by high-speed train from Rome, so the day starts at 13:05.",
        "Leaves about 5 h 30 min before dinner.",
        "Day 3 keeps its places and now starts at 11:45.",
      ],
    });
  });

  it("gives a reason that is the same for every city in full once, then short", () => {
    const pinned = fixturePlan({ mustInclude: ["place_026"] });
    const refused = dayChoices(pinned, tripRoute(pinned), 0, ctx).rows.filter(
      (row) => !row.planned,
    );
    expect(refused.every((row) => !row.allowed)).toBe(true);
    expect(refused.map((row) => row.reason)).toEqual([
      "Day 1 has Uffizi Gallery, which you asked for, and no other day of this route is in Florence. Keep day 1 in Florence, or remove Uffizi Gallery from day 1 first.",
      SHORT_REASONS.holds_must_include,
      SHORT_REASONS.holds_must_include,
      SHORT_REASONS.holds_must_include,
    ]);
  });

  it("names the day that has the place when it is not the day being set", () => {
    // Rome three days with the Colosseum on day 1, and day 1 set to Florence: day 2 must stay in
    // Rome to take it, and every other city for day 2 is refused because of day 1's place.
    const pinned = fixturePlan({
      mustInclude: ["place_001"],
      anchors: [ROME],
      interests: ["historic"],
    });
    expect(ids(pinned, 0)).toContain("place_001");
    const rows = dayChoices(pinned, [FLORENCE, ROME, FLORENCE], 1, ctx).rows;

    expect(rows.map((row) => row.reason)).toEqual([
      null,
      "Day 1 has Colosseum, which you asked for, and no other day of this route is in Rome. Keep day 1 in Rome, or remove Colosseum from day 1 first.",
      "Day 1 has a place you asked for.",
      "Day 1 has a place you asked for.",
      "Day 1 has a place you asked for.",
    ]);
  });

  it("checks new ideas with the day's own places left out", () => {
    // Every other place in Rome skipped: the day has nothing new, and the list says so.
    const used = new Set(plan.days.flatMap((day) => day.stops.map((stop) => stop.placeId)));
    const rest = (ctx.anchorById.get(ROME)?.placeIds ?? []).filter((id) => !used.has(id));
    const tight = { ...plan, request: { ...plan.request, exclude: rest } };
    expect(dayChoices(tight, tripRoute(tight), 0, ctx).ideas).toEqual({
      allowed: false,
      reason: "Nothing in Rome fits day 1 with your settings.",
    });
  });
});

describe("a run", () => {
  it("plans a route's days in day order, each with the route and the later days empty", () => {
    const run = runFor([ROME, FLORENCE, VENICE]);
    expect(run).toMatchObject({
      kind: "route",
      route: [ROME, FLORENCE, VENICE],
      names: ["Florence", "Venice"],
      basis: tripKey(plan),
      head: "Route changed: Rome, Florence, Venice.",
    });
    expect(run.jobs).toEqual([
      { day: 1, anchorId: FLORENCE, avoid: [], why: "city" },
      { day: 2, anchorId: VENICE, avoid: [], why: "city" },
    ]);
    expect(run.start).toEqual([
      { anchorId: ROME, placeIds: ids(plan, 0) },
      { anchorId: FLORENCE, placeIds: [] },
      { anchorId: VENICE, placeIds: [] },
    ]);
    const body = jobBody(plan.request, run.start, must(run.jobs[0]), run.route);
    expect(body).toEqual({
      request: plan.request,
      days: [
        { anchorId: ROME, ids: ids(plan, 0) },
        { anchorId: FLORENCE, ids: [] },
        { anchorId: VENICE, ids: [] },
      ],
      day: 1,
      anchorId: FLORENCE,
      route: [ROME, FLORENCE, VENICE],
    });
    expect(body).not.toHaveProperty("avoid");
  });

  it("is a city change when one day moves, with the next day planned again for its travel", () => {
    const run = runFor([ROME, FLORENCE, ROME]);
    expect(run.kind).toBe("city");
    expect(run.jobs.map((job) => [job.day, job.anchorId, job.why])).toEqual([
      [1, FLORENCE, "city"],
      [2, ROME, "travel"],
    ]);
    expect(run.head).toBe("Day 2 now in Florence.");
  });

  it("gives new ideas for one day alone, with its places left out and no route", () => {
    const run = ideasRun(plan, 1, ctx);
    expect(run).toMatchObject({
      kind: "ideas",
      route: null,
      names: ["Rome"],
      start: tripSelection(plan),
      head: "New ideas for day 2.",
    });
    const job = must(run.jobs[0]);
    expect(job).toEqual({ day: 1, anchorId: ROME, avoid: ids(plan, 1), why: "ideas" });
    const body = jobBody(plan.request, run.start, job, run.route);
    expect(body.avoid).toEqual(ids(plan, 1));
    expect(body).not.toHaveProperty("route");
  });

  it("makes a trip of three new cities with no place twice and nothing the validator rejects", () => {
    const run = runFor([FLORENCE, VENICE, "milan"]);
    const { results } = answerAll(run);
    expect(results.map((result) => result.day)).toEqual([0, 1, 2]);
    const trip = withReplannedDays(plan, results, ctx);
    expect(trip.days.map((day) => day.anchorId)).toEqual([FLORENCE, VENICE, "milan"]);
    const all = trip.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
    expect(new Set(all).size).toBe(all.length);
    expect(all.some((id) => plan.days.some((day) => day.stops.some((s) => s.placeId === id)))).toBe(
      false,
    );
    expect(validationErrors(trip, ctx)).toEqual([]);
  });
});

describe("taking the API's day, or planning it here", () => {
  const run = runFor([ROME, FLORENCE, VENICE]);
  const job = must(run.jobs[0]);
  const body = jobBody(plan.request, run.start, job, run.route);

  it("takes an answer that fits the trip as planned so far, with who planned it", () => {
    const response = dayAnswerFor(body);
    expect(resolveJob(plan, run.start, job, { kind: "answer", response }, ctx)).toEqual({
      kind: "day",
      dayPlan: response.dayPlan,
      made: { kind: "api", source: "ai" },
    });
  });

  it("keeps why the server planned the day by rules", () => {
    const response = dayAnswerFor(body, "deterministic");
    const resolved = resolveJob(plan, run.start, job, { kind: "answer", response }, ctx);
    expect(resolved.kind === "day" && resolved.made).toEqual({
      kind: "api",
      source: "deterministic",
      fallbackReason: "timeout",
    });
  });

  it("plans the day here, blaming the server, when its answer breaks the trip", () => {
    const good = dayAnswerFor(body);
    const repeat = must(plan.days[0]?.stops[0]);
    const first = must(good.dayPlan.stops[0]);
    const broken: PlanDayResponse[] = [
      // A place already on day 1.
      { ...good, dayPlan: { ...good.dayPlan, stops: [repeat, ...good.dayPlan.stops.slice(1)] } },
      // Another day, another city, another date, no stops, an unknown place, a twice-listed one.
      { ...good, day: 2 },
      { ...good, dayPlan: { ...good.dayPlan, anchorId: VENICE } },
      { ...good, dayPlan: { ...good.dayPlan, date: "2026-10-09" } },
      { ...good, dayPlan: { ...good.dayPlan, stops: [] } },
      { ...good, dayPlan: { ...good.dayPlan, stops: [{ ...first, placeId: "place_999" }] } },
      { ...good, dayPlan: { ...good.dayPlan, stops: [first, first] } },
      // A place the validator rejects: one from another city than the day's.
      {
        ...good,
        dayPlan: {
          ...good.dayPlan,
          stops: [{ ...first, placeId: must(ctx.anchorById.get(VENICE)?.placeIds[0]) }],
        },
      },
    ];
    for (const response of broken) {
      const resolved = resolveJob(plan, run.start, job, { kind: "answer", response }, ctx);
      expect(resolved.kind).toBe("day");
      if (resolved.kind !== "day") continue;
      expect(resolved.made).toEqual({ kind: "device", cause: "invalid" });
      expect(resolved.dayPlan.anchorId).toBe(FLORENCE);
    }
  });

  it("plans the day here when its answer leaves out a place asked for the rules' day holds", () => {
    // Day 3 holds Da Enzo al 29 and is planned again after its new travel. Sent empty, the
    // restaurant is already missing from the trip as planned so far, and the validator finds it
    // room on day 1, which the route keeps: only the rules' day shows the answer lost it.
    const trip = fixturePlan({
      startDate: "2026-10-19",
      interests: ["historic"],
      anchors: [ROME],
      mustInclude: ["place_003"],
    });
    expect(ids(trip, 2)).toContain("place_003");
    const routeRun = runFor([ROME, FLORENCE, ROME], trip);
    expect(routeRun.jobs.map((each) => each.day)).toEqual([1, 2]);
    const [first, last] = routeRun.jobs.map((each) => must(each));
    const day2 = dayAnswerFor(jobBody(trip.request, routeRun.start, must(first), routeRun.route));
    const working = withDay(routeRun.start, 1, {
      anchorId: FLORENCE,
      placeIds: day2.dayPlan.stops.map((stop) => stop.placeId),
    });
    const good = dayAnswerFor(jobBody(trip.request, working, must(last), routeRun.route));
    const stops = good.dayPlan.stops.filter((stop) => stop.placeId !== "place_003");
    const response = { ...good, dayPlan: { ...good.dayPlan, stops } };

    const resolved = resolveJob(trip, working, must(last), { kind: "answer", response }, ctx);

    expect(resolved.kind === "day" && resolved.made).toEqual({ kind: "device", cause: "invalid" });
    expect(resolved.kind === "day" && resolved.dayPlan.stops.map((stop) => stop.placeId)).toContain(
      "place_003",
    );
  });

  it("plans the day here with the failure's cause when the call failed", () => {
    const resolved = resolveJob(plan, run.start, job, { kind: "failed", cause: "offline" }, ctx);
    expect(resolved.kind).toBe("day");
    if (resolved.kind !== "day") return;
    expect(resolved.made).toEqual({ kind: "device", cause: "offline" });
    const day = resolved.dayPlan;
    expect(day.anchorId).toBe(FLORENCE);
    expect(day.date).toBe(plan.days[1]?.date);
    expect(day.stops.every((stop) => stop.reasonSource === "rule")).toBe(true);
    expect(day.stops.some((stop) => ids(plan, 0).includes(stop.placeId))).toBe(false);
  });

  it("refuses with the planner's reason when the rules cannot plan the day either", () => {
    const closed = {
      ...plan,
      request: { ...plan.request, exclude: [...(ctx.anchorById.get(FLORENCE)?.placeIds ?? [])] },
    };
    const refused = resolveJob(closed, run.start, job, { kind: "failed", cause: "server" }, ctx);
    expect(refused).toEqual({
      kind: "refused",
      reason: "Nothing in Florence fits day 2 after 2 h 10 min of travel.",
    });
  });
});

describe("what the page says about a run", () => {
  const ai = { kind: "api", source: "ai" } as const;
  const rules = { kind: "api", source: "deterministic" } as const;
  const device = { kind: "device", cause: "offline" } as const;
  const result = (day: number, made: ReplannedResult["made"]) =>
    ({ day, dayPlan: must(plan.days[day]), made }) as ReplannedResult;

  it("says what changed, what else was planned again, and what the AI did not plan", () => {
    const moved = runFor([ROME, FLORENCE, ROME]);
    expect(replanMessage(moved, [result(1, ai), result(2, ai)])).toBe(
      "Day 2 now in Florence. Day 3 planned again.",
    );
    const route = runFor([ROME, FLORENCE, VENICE]);
    expect(replanMessage(route, [result(1, ai), result(2, ai)])).toBe(
      "Route changed: Rome, Florence, Venice.",
    );
    expect(replanMessage(route, [result(1, device), result(2, device)])).toBe(
      "Route changed: Rome, Florence, Venice. Planned without AI on this device.",
    );
    expect(replanMessage(route, [result(1, ai), result(2, rules)])).toBe(
      "Route changed: Rome, Florence, Venice. Day 3 planned without AI.",
    );
    expect(replanMessage(route, [result(1, rules), result(2, device)])).toBe(
      "Route changed: Rome, Florence, Venice. Planned without AI.",
    );
    const ideas = ideasRun(plan, 0, ctx);
    expect(replanMessage(ideas, [result(0, device)])).toBe(
      "New ideas for day 1. Planned without AI on this device.",
    );
    expect(replanMessage(ideas, [result(0, { kind: "api", source: "ai_repaired" })])).toBe(
      "New ideas for day 1.",
    );
  });

  it("says which day is being planned, which waits, and why editing waits", () => {
    const run = runFor([FLORENCE, VENICE, "milan"]);
    expect(planningText(run, 0)).toBe("Planning day 1 in Florence (1 of 3)");
    expect(waitingText(run, 2)).toBe("Waiting to plan day 3 in Milan (3 of 3)");
    expect(lockedText(run, 0)).toBe("Editing waits until day 1, day 2 and day 3 are planned.");
    expect(lockedText(run, 2)).toBe("Editing waits until day 3 is planned.");
    expect(planningText(runFor([ROME, ROME, VENICE]), 0)).toBe("Planning day 3 in Venice");
    expect(planningText(ideasRun(plan, 1, ctx), 0)).toBe("Planning new ideas for day 2");
    expect(planningText(run, 5)).toBe("");
    expect(waitingText(run, 5)).toBe("");
    expect(daysTitle([2])).toBe("Day 3");
    expect(daysTitle([1, 2])).toBe("Days 2 and 3");
    expect(daysTitle([0, 1, 2])).toBe("Days 1, 2 and 3");
  });

  it("keeps the job's day type the planner gave it", () => {
    const job: DayJob = { day: 0, anchorId: ROME, avoid: [], why: "must_include" };
    const run: ReplanRun = { ...runFor([FLORENCE, ROME, ROME]), jobs: [job] };
    expect(replanMessage(run, [result(0, ai)])).toBe("Day 1 now in Florence. Day 1 planned again.");
  });
});
