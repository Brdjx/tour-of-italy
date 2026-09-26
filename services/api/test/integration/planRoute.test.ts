import {
  type DaySelection,
  type Itinerary,
  planRoute,
  routeStartDays,
  validationErrors,
  withDay,
  withReplannedDays,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import {
  ErrorResponseSchema,
  type PlanDayResponse,
  PlanDayResponseSchema,
  TripSnapshotSchema,
} from "../../src/contract";
import { shippedData } from "../../src/data";
import type { LlmClient, LlmDayResult, RepairInput, SelectInput } from "../../src/llm/client";
import { FIXTURE_SCENARIOS, FixtureClient } from "../../src/llm/fixture";
import { lastRequestLog, makeApp, type TestApp, tripBody } from "../helpers/app";
import { dayBody, plannedTrip, postDay, routeBody } from "../helpers/day";
import { aiPlan, getTrip, saveBody, saveTrip, tripsApp } from "../helpers/trips";

// POST /api/plan/day for a route the traveler set by hand (a city a day, in any order, back and
// forth included), planned as the page plans it: planRoute names the days to plan again, the page
// sends one request a day in day order with the route and the days planned so far, puts each
// answer in, and applies them all as one edit. Every route ends in a trip the validator passes,
// with no place on two days and the kept days unchanged; the body is strict about which days may
// be empty; the cache keys on the route; and a 3-city trip saves and reopens.

const { ctx } = shippedData();

function selectionOf(trip: Pick<Itinerary, "days">): DaySelection[] {
  return trip.days.map((day) => ({
    anchorId: day.anchorId,
    placeIds: day.stops.map((stop) => stop.placeId),
  }));
}

/** The trip with each day's base and ids replaced, timed again. */
function applyIds(trip: Itinerary, days: readonly DaySelection[]): Itinerary {
  const stops = (ids: readonly string[]) =>
    ids.map((placeId) => ({
      placeId,
      start: 0,
      end: 1,
      travelFromPrevMin: 0,
      role: "visit" as const,
    }));
  return withReplannedDays(
    trip,
    days.map((day, index) => ({
      day: index,
      dayPlan: { anchorId: day.anchorId, stops: stops(day.placeIds) },
    })),
    ctx,
  );
}

/**
 * Plans `route` for `trip` through the API as the page does, and checks each answer and the trip
 * they make together. Returns the route's plan, the answers, and the trip with them applied.
 */
async function planRouteThroughApi(
  app: TestApp["app"],
  trip: Itinerary,
  route: string[],
  scenario = "valid",
) {
  const days = selectionOf(trip);
  const plan = planRoute(trip.request, days, route, ctx);
  expect(plan.allowed).toBe(true);
  let working = routeStartDays(days, plan);
  const answers: PlanDayResponse[] = [];
  for (const day of plan.replan) {
    const res = await postDay(app, routeBody(trip.request, working, day, route), { scenario });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);
    const answer = PlanDayResponseSchema.parse(json);
    expect(answer.day).toBe(day);
    expect(answer.dayPlan.anchorId).toBe(route[day]);
    const ids = answer.dayPlan.stops.map((stop) => stop.placeId);
    expect(ids.length).toBeGreaterThan(0);
    working = withDay(working, day, { anchorId: route[day] as string, placeIds: ids });
    answers.push(answer);
  }
  const applied = withReplannedDays(
    trip,
    answers.map((answer) => ({ day: answer.day, dayPlan: answer.dayPlan })),
    ctx,
  );
  expect(validationErrors(applied, ctx)).toEqual([]);
  expect(applied.days.map((day) => day.anchorId)).toEqual(route);
  const ids = applied.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
  expect(new Set(ids).size, "a place on two days").toBe(ids.length);
  days.forEach((day, index) => {
    if (plan.replan.includes(index)) return;
    expect(selectionOf(applied)[index]).toEqual(day);
  });
  return { plan, answers, applied };
}

const rome = plannedTrip();

describe("POST /api/plan/day for a route", () => {
  it("plans a city a day, Rome, Florence, Venice, one request a day, into one valid trip", async () => {
    const { app, logs } = makeApp();
    const { plan, answers } = await planRouteThroughApi(app, rome, ["rome", "florence", "venice"]);

    expect(plan.replan).toEqual([1, 2]);
    expect(answers.map((answer) => answer.source)).toEqual(["ai", "ai"]);
    expect(answers.map((answer) => answer.dayPlan.transferMin)).toEqual([130, 120]);
    expect(lastRequestLog(logs)).toMatchObject({ source: "ai", day: 2, cache: "miss" });
  });

  it("goes away for a day and back: Rome, Rome, Florence to Rome, Florence, Rome", async () => {
    const start = applyIds(
      rome,
      planRoute(rome.request, selectionOf(rome), ["rome", "rome", "florence"], ctx)
        .rulesDays as DaySelection[],
    );
    expect(validationErrors(start, ctx)).toEqual([]);
    const { app } = makeApp();
    const { plan, answers } = await planRouteThroughApi(app, start, ["rome", "florence", "rome"]);

    expect(plan.replan).toEqual([1, 2]);
    expect(answers.map((answer) => answer.dayPlan.transferMin)).toEqual([130, 130]);
  });

  it("plans day 2 again after a day 1 change it no longer fits, which one day alone cannot", async () => {
    const { app } = makeApp();
    const alone = await postDay(app, dayBody(rome, 0, "florence"));
    expect(alone.status).toBe(422);
    expect(ErrorResponseSchema.parse(await alone.json()).error.message).toBe(
      "Day 2 would start after 2 h 10 min of travel from Florence, and its plan would not fit.",
    );

    const { plan, answers } = await planRouteThroughApi(app, rome, ["florence", "rome", "rome"]);
    expect(plan.days[1]?.note).toBe(
      "Day 2 will be planned again: it now starts after 2 h 10 min of travel.",
    );
    expect(answers.map((answer) => [answer.day, answer.dayPlan.anchorId])).toEqual([
      [0, "florence"],
      [1, "rome"],
    ]);
  });

  it("moves a place asked for to the next day of its city, which one day alone refuses", async () => {
    const trip = plannedTrip({ mustInclude: ["place_001"] });
    expect(trip.days[0]?.stops.map((stop) => stop.placeId)).toContain("place_001");
    const { app } = makeApp();
    const alone = await postDay(app, dayBody(trip, 0, "florence"));
    expect(alone.status).toBe(422);
    expect(ErrorResponseSchema.parse(await alone.json()).error.message).toBe(
      "Day 1 has Colosseum, which you asked for.",
    );

    const { applied } = await planRouteThroughApi(app, trip, ["florence", "rome", "rome"]);
    expect(applied.days[1]?.stops.map((stop) => stop.placeId)).toContain("place_001");
  });

  it("plans the rules' day for a route day in deterministic mode, as the page would", async () => {
    const { app } = makeApp();
    const route = ["florence", "florence", "florence"];
    const plan = planRoute(rome.request, selectionOf(rome), route, ctx);
    const res = await postDay(
      app,
      routeBody(rome.request, routeStartDays(selectionOf(rome), plan), 0, route),
      { query: "mode=deterministic" },
    );

    const answer = PlanDayResponseSchema.parse(await res.json());
    expect(answer.source).toBe("deterministic");
    expect(answer.dayPlan.stops.map((stop) => stop.placeId)).toEqual(plan.rulesDays?.[0]?.placeIds);
  });

  it("drops a repeat of a day planned earlier in the same route before the check", async () => {
    const route = ["rome", "florence", "florence"];
    const days = selectionOf(rome);
    const plan = planRoute(rome.request, days, route, ctx);
    const { app: first } = makeApp();
    const working = routeStartDays(days, plan);
    const day2 = PlanDayResponseSchema.parse(
      await (await postDay(first, routeBody(rome.request, working, 1, route))).json(),
    );
    const taken = day2.dayPlan.stops[0]?.placeId as string;
    const next = withDay(working, 1, {
      anchorId: "florence",
      placeIds: day2.dayPlan.stops.map((stop) => stop.placeId),
    });
    const { app, logs } = makeApp({ client: new RepeatingDayClient(taken) });
    const res = await postDay(app, routeBody(rome.request, next, 2, route));

    const day3 = PlanDayResponseSchema.parse(await res.json());
    expect(day3.source).toBe("ai_repaired");
    expect(day3.dayPlan.stops.map((stop) => stop.placeId)).not.toContain(taken);
    expect(lastRequestLog(logs).tidied).toEqual([
      expect.objectContaining({ rule: "duplicate", day: 2, placeId: taken }),
    ]);
  });

  it("saves an AI trip after a route with the rules' why lines on the days planned again", async () => {
    const { app } = tripsApp();
    const plan = await aiPlan(app, tripBody({ anchors: ["rome"] }));
    expect(plan.planId).toBeDefined();
    const { applied, answers } = await planRouteThroughApi(app, plan, [
      "rome",
      "florence",
      "venice",
    ]);
    expect(answers.every((answer) => answer.source !== "deterministic")).toBe(true);
    expect(applied.planId).toBe(plan.planId);

    const id = await saveTrip(app, saveBody(applied));
    const snapshot = TripSnapshotSchema.parse(await (await getTrip(app, id)).json());

    expect(snapshot.origin).toEqual({ plannedBy: "ai", edited: true });
    expect(snapshot.itinerary.summary).toBeUndefined();
    const sources = snapshot.itinerary.days.map((day) =>
      day.stops.map((stop) => stop.reasonSource),
    );
    expect(sources[0]?.every((source) => source === "ai")).toBe(true);
    expect(
      sources
        .slice(1)
        .flat()
        .every((source) => source === "rule"),
    ).toBe(true);
    expect(validationErrors(snapshot.itinerary, ctx)).toEqual([]);
  });

  it("saves a trip of three cities and reopens it as saved", async () => {
    const { app } = tripsApp();
    const { applied } = await planRouteThroughApi(app, rome, ["rome", "florence", "venice"]);

    const id = await saveTrip(app, saveBody(applied));
    const snapshot = TripSnapshotSchema.parse(await (await getTrip(app, id)).json());

    expect(snapshot.itinerary.days.map((day) => day.anchorId)).toEqual([
      "rome",
      "florence",
      "venice",
    ]);
    expect(selectionOf(snapshot.itinerary)).toEqual(selectionOf(applied));
    expect(validationErrors(snapshot.itinerary, ctx)).toEqual([]);
    expect(snapshot.origin).toEqual({ plannedBy: "rules", edited: false });
  });
});

describe("POST /api/plan/day for a route with every fixture scenario", () => {
  const route = ["rome", "florence", "venice"];
  const days = selectionOf(rome);
  const start = routeStartDays(days, planRoute(rome.request, days, route, ctx));
  /** Short model timeouts, so the slow scenarios run in well under a second. */
  const FAST = {
    env: { LLM_TIMEOUT_MS: "300", PLAN_DEADLINE_MS: "2000" },
    timing: {
      reserveMs: 200,
      minCallMs: 100,
      minRepairMs: 100,
      retry: { defaultPauseMs: 10, maxPauseMs: 50 },
    },
  };

  for (const scenario of FIXTURE_SCENARIOS) {
    it(`"${scenario}" ends in a valid day of the route, the later day still waiting`, async () => {
      const { app } = makeApp(FAST);
      const res = await postDay(app, routeBody(rome.request, start, 1, route), { scenario });

      expect(res.status).toBe(200);
      const answer = PlanDayResponseSchema.parse(await res.json());
      const ids = answer.dayPlan.stops.map((stop) => stop.placeId);
      expect(answer.dayPlan.anchorId).toBe("florence");
      expect(ids.length).toBeGreaterThan(0);
      const trip = withDay(start, 1, { anchorId: "florence", placeIds: ids });
      const used = new Set(trip.flatMap((day, index) => (index === 1 ? [] : day.placeIds)));
      expect(ids.filter((id) => used.has(id))).toEqual([]);
      for (const id of ids) expect(ctx.anchorIdByPlaceId.get(id)).toBe("florence");
    });
  }
});

describe("POST /api/plan/day for a route: which days may be empty", () => {
  const route = ["rome", "florence", "venice"];
  const days = selectionOf(rome);
  const start = routeStartDays(days, planRoute(rome.request, days, route, ctx));

  it("takes the later days of the route empty, still waiting their turn", async () => {
    const { app } = makeApp();
    const res = await postDay(app, routeBody(rome.request, start, 1, route));

    expect(res.status).toBe(200);
  });

  const hostile: [string, Record<string, unknown>, string][] = [
    [
      "an empty day before the one being planned",
      routeBody(rome.request, withDay(start, 0, { anchorId: "rome", placeIds: [] }), 1, route),
      "days.0.ids",
    ],
    [
      "a day away from its city in the route",
      routeBody(rome.request, withDay(start, 2, { anchorId: "milan", placeIds: [] }), 1, route),
      "days.2.anchorId",
    ],
    [
      "a base that is not the day's city in the route",
      { ...routeBody(rome.request, start, 1, route), anchorId: "venice" },
      "anchorId",
    ],
    [
      "places to avoid with a route",
      { ...routeBody(rome.request, start, 1, route), avoid: ["place_026"] },
      "avoid",
    ],
    [
      "an unknown base in the route",
      { ...routeBody(rome.request, start, 1, route), route: ["rome", "florence", "atlantis"] },
      "route.2",
    ],
    [
      "a route of two days",
      { ...routeBody(rome.request, start, 1, route), route: ["rome", "florence"] },
      "route",
    ],
  ];
  it.each(hostile)("refuses %s (400)", async (_name, body, path) => {
    const { app } = makeApp();
    const res = await postDay(app, body);

    expect(res.status).toBe(400);
    const error = ErrorResponseSchema.parse(await res.json()).error;
    expect(error.details?.map((d) => d.path)).toContain(path);
  });

  it("refuses a later empty day without a route: only a route has days waiting (400)", async () => {
    const { app } = makeApp();
    const { route: _route, ...body } = routeBody(
      rome.request,
      withDay(days, 2, { anchorId: "rome", placeIds: [] }),
      1,
      ["rome", "rome", "rome"],
    );
    const res = await postDay(app, body);

    expect(res.status).toBe(400);
    const error = ErrorResponseSchema.parse(await res.json()).error;
    expect(error.details).toContainEqual({
      path: "days.2.ids",
      message: "Only the day being planned may be empty",
    });
  });
});

describe("POST /api/plan/day for a route: the AI day cache", () => {
  it("keys on the route: the same day is asked for again with another route", async () => {
    const client = new FixtureClient(ctx, "valid");
    const { app, logs } = makeApp({ client });
    const days = selectionOf(rome);
    const alone = dayBody(rome, 2, "florence");
    const inRoute = routeBody(
      rome.request,
      days.map((day, index) => (index === 2 ? { anchorId: "florence", placeIds: [] } : day)),
      2,
      ["rome", "rome", "florence"],
    );

    await postDay(app, alone);
    await postDay(app, inRoute);
    await postDay(app, inRoute);

    expect(client.calls).toBe(2);
    expect(lastRequestLog(logs)).toMatchObject({ cache: "hit-memory" });
  });
});

/** The fixture's valid day, with a place another day has put first. */
class RepeatingDayClient implements LlmClient {
  readonly model = "repeating-day";
  private readonly fixture = new FixtureClient(ctx, "valid");

  constructor(private readonly repeat: string) {}

  select(input: SelectInput) {
    return this.fixture.select(input);
  }

  repair(input: RepairInput) {
    return this.fixture.repair(input);
  }

  async selectDay(input: SelectInput): Promise<LlmDayResult> {
    const result = await this.fixture.selectDay(input);
    const answer = result.answer;
    if (answer === null) return result;
    const reason = { placeId: this.repeat, reason: "A good fit for the interests in this trip." };
    return {
      ...result,
      answer: { placeIds: [this.repeat, ...answer.placeIds], reasons: [reason, ...answer.reasons] },
    };
  }

  repairDay(input: RepairInput): Promise<LlmDayResult> {
    return this.fixture.repairDay(input);
  }
}
