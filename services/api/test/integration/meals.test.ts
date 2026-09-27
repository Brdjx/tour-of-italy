import {
  type DaySelection,
  dayMealGaps,
  type Itinerary,
  isMealPlace,
  planRoute,
  routeStartDays,
  scheduleTrip,
  type TripRequest,
  validationErrors,
  withDay,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import { PlanDayResponseSchema } from "../../src/contract";
import { shippedData } from "../../src/data";
import type {
  LlmClient,
  LlmDayResult,
  LlmResult,
  RepairInput,
  SelectInput,
} from "../../src/llm/client";
import { FixtureClient } from "../../src/llm/fixture";
import { lastRequestLog, makeApp, postPlan, tripBody } from "../helpers/app";
import { plannedTrip, postDay, routeBody } from "../helpers/day";
import { expectValidItinerary } from "../helpers/validPlan";

// The meals code adds to an AI answer, through both routes (mealAdd.ts, decision 17). A model
// that leaves out every meal place gets its lunches and dinners added where a place of the city is
// open and free, labelled "ai_repaired", with rule reasons, and the log line names each one; and
// on the owner's Monday in Bologna (2026-09-26), where no dinner place opens, the day keeps its
// lunch and no dinner is invented.

const { ctx } = shippedData();

const visit = (id: string) => !isMealPlace(ctx.placesById.get(id) ?? { mealCapable: false });

/** The fixture's valid answers, less every meal place: a model that skips meals. */
class MealSkippingClient implements LlmClient {
  readonly model = "meal-skipping";
  private readonly fixture = new FixtureClient(ctx, "valid");

  select(input: SelectInput): Promise<LlmResult> {
    return this.fixture.select(input).then((result) => this.trip(result));
  }

  repair(input: RepairInput): Promise<LlmResult> {
    return this.fixture.repair(input).then((result) => this.trip(result));
  }

  selectDay(input: SelectInput): Promise<LlmDayResult> {
    return this.fixture.selectDay(input).then((result) => this.day(result));
  }

  repairDay(input: RepairInput): Promise<LlmDayResult> {
    return this.fixture.repairDay(input).then((result) => this.day(result));
  }

  private trip(result: LlmResult): LlmResult {
    const selection = result.selection;
    if (selection === null) return result;
    const days = selection.days.map((day) => ({
      ...day,
      placeIds: day.placeIds.filter(visit),
      reasons: day.reasons.filter((reason) => visit(reason.placeId)),
    }));
    return { ...result, selection: { ...selection, days } };
  }

  private day(result: LlmDayResult): LlmDayResult {
    const answer = result.answer;
    if (answer === null) return result;
    return {
      ...result,
      answer: {
        placeIds: answer.placeIds.filter(visit),
        reasons: answer.reasons.filter((reason) => visit(reason.placeId)),
      },
    };
  }
}

type Change = { rule: string; day: number; placeId: string };

describe("meals code adds to an AI answer", () => {
  it("POST /api/plan adds the lunches and dinners an answer leaves out", async () => {
    const { app, logs } = makeApp({ client: new MealSkippingClient() });

    const res = await postPlan(app, tripBody({ anchors: ["rome"] }));

    expect(res.status).toBe(200);
    const itinerary = expectValidItinerary(await res.json());
    expect(itinerary.source).toBe("ai_repaired");
    const log = lastRequestLog(logs);
    const added = (log.tidied as Change[]).filter((change) => change.rule === "meal_added");
    expect(added.length).toBeGreaterThanOrEqual(3);
    for (const change of added) {
      const stop = itinerary.days[change.day]?.stops.find((s) => s.placeId === change.placeId);
      expect(stop?.role).toMatch(/^(lunch|dinner)$/);
      expect(stop?.reasonSource).toBe("rule");
    }
    const warned = itinerary.warnings.filter((w) => w.code === "MEAL_MISSING");
    for (const change of added) {
      const stop = itinerary.days[change.day]?.stops.find((s) => s.placeId === change.placeId);
      const text = `has no ${stop?.role} stop`;
      expect(warned.some((w) => w.day === change.day && w.detail.includes(text))).toBe(false);
    }
  });

  it("POST /api/plan/day adds the owner's Monday lunch in Bologna, and no dinner, which none serves", async () => {
    // Rome, Venice, Bologna from Saturday 10 October 2026: day 3 is Monday 12 October, after 2 h
    // 25 min by train from Venice, so it starts at 11:55 and Via Drapperie's 12:00 lunch is its
    // last. None of Bologna's three dinner places opens on Mondays.
    const trip: Itinerary = plannedTrip({ startDate: "2026-10-10", anchors: "auto" });
    const request: TripRequest = trip.request;
    const route = ["rome", "venice", "bologna"];
    const days: DaySelection[] = trip.days.map((day) => ({
      anchorId: day.anchorId,
      placeIds: day.stops.map((stop) => stop.placeId),
    }));
    const plan = planRoute(request, days, route, ctx);
    expect(plan.allowed).toBe(true);
    expect(plan.replan).toContain(2);
    expect(plan.days[2]?.meals).toEqual(["No dinner place listed for Bologna opens on Mondays."]);
    const { app, logs } = makeApp({ client: new MealSkippingClient() });

    let working = routeStartDays(days, plan);
    for (const day of plan.replan) {
      const res = await postDay(app, routeBody(request, working, day, route));
      expect(res.status).toBe(200);
      const answer = PlanDayResponseSchema.parse(await res.json());
      const ids = answer.dayPlan.stops.map((stop) => stop.placeId);
      working = withDay(working, day, { anchorId: route[day] as string, placeIds: ids });
      if (day !== 2) continue;
      expect(answer.source).toBe("ai_repaired");
      const added = (lastRequestLog(logs).tidied as Change[]).filter(
        (change) => change.rule === "meal_added",
      );
      expect(added).toEqual([{ rule: "meal_added", day: 2, placeId: "place_046", answer: 1 }]);
      expect(answer.dayPlan.stops.find((stop) => stop.role === "lunch")).toMatchObject({
        placeId: "place_046",
        start: 720,
        reasonSource: "rule",
      });
      expect(answer.dayPlan.stops.some((stop) => stop.role === "dinner")).toBe(false);
    }

    const timed = { request, days: scheduleTrip(request, working, ctx).days };
    expect(validationErrors({ ...trip, ...timed }, ctx)).toEqual([]);
    expect(dayMealGaps(timed, 2, ctx).map((gap) => [gap.meal, gap.cause, gap.text])).toEqual([
      [
        "dinner",
        "none_open",
        "The three dinner places listed for Bologna are all closed on Mondays.",
      ],
    ]);
  });
});
