import {
  checkDayBase,
  type DaySelection,
  dayMealGaps,
  isMealPlace,
  mealGaps,
  planDeterministic,
  planRoute,
  scheduleTrip,
  type TripRequest,
  TripRequestSchema,
  type Violation,
  validationErrors,
  withDay,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import type {
  LlmClient,
  LlmDayAnswer,
  LlmDayResult,
  LlmSelection,
  RepairInput,
  SelectInput,
} from "../../src/llm/client";
import { validSelection } from "../../src/llm/fixtureAnswers";
import { validDayAnswer } from "../../src/llm/fixtureDayAnswers";
import { buildShortlist } from "../../src/plan/candidates";
import type { DayInput } from "../../src/plan/dayInput";
import { type Materialized, materializeSelection } from "../../src/plan/materialize";
import { keptPlan, withMealsAdded, withoutErrors } from "../../src/plan/mealAdd";
import { type PlanDeps, planTrip } from "../../src/plan/planTrip";
import { replanDay } from "../../src/plan/replanDay";
import { ScriptedClient, textResult } from "../helpers/fakeClients";

// The one step that adds a place to the model's answer (mealAdd.ts, decision 17): a lunch or
// dinner a day lacks, once the answer passed the check, where the rules planner's meal fill seats
// a place the shortlist offered. The failures it prevents: an AI timetable without dinner while a
// restaurant of the city was open and free, and the failures it must never cause: a stop of the
// model's moved or dropped, a place repeated or not offered, a meal where none is open, an error
// or a warning the answer did not have, and an AI plan labelled as written when code added to it.

const { ctx } = shippedData();
const META = { attempts: 1, latencyMs: 0, generatedAt: "2026-09-26T00:00:00.000Z" };

function request(overrides: Record<string, unknown> = {}): TripRequest {
  return TripRequestSchema.parse({ startDate: "2026-10-20", pace: "balanced", ...overrides });
}

/** The answer without its meal places, as a model that skips meals writes it. */
function withoutMeals(selection: LlmSelection): LlmSelection {
  const visit = (id: string) => !isMealPlace(ctx.placesById.get(id) ?? { mealCapable: false });
  return {
    ...selection,
    days: selection.days.map((day) => ({
      ...day,
      placeIds: day.placeIds.filter(visit),
      reasons: day.reasons.filter((reason) => visit(reason.placeId)),
    })),
  };
}

function deps(llm: LlmClient): PlanDeps {
  return {
    llm,
    ctx,
    now: () => Date.now(),
    config: { timeoutMs: 15_000, deadlineMs: 24_000, maxAttempts: 2 },
  };
}

describe("withMealsAdded", () => {
  const req = request({ anchors: ["rome"] });
  const shortlist = buildShortlist(req, ctx);
  const visits: LlmSelection = {
    days: [
      ["place_001", "place_004", "place_005"],
      ["place_002", "place_007"],
      ["place_013", "place_016"],
    ].map((placeIds) => ({
      anchorId: "rome",
      placeIds,
      reasons: placeIds.map((placeId) => ({ placeId, reason: "A fine old sight." })),
    })),
    summary: "",
  };
  const check = (next: LlmSelection, added: ReadonlySet<string>) =>
    withoutErrors(materializeSelection(next, req, shortlist, ctx, META, added));

  it("adds each day's missing lunch and dinner from the shortlist, in day order, with rule reasons", () => {
    const fed = withMealsAdded(visits, req, shortlist, ctx, [0, 1, 2], check);

    expect(fed.changes.length).toBeGreaterThanOrEqual(3);
    expect(fed.changes.every((change) => change.rule === "meal_added")).toBe(true);
    const days = fed.changes.map((change) => change.day);
    expect(days).toEqual([...days].sort());
    expect([...fed.added]).toEqual(fed.changes.map((change) => change.placeId));
    for (const id of fed.added) expect(shortlist.placeIds.has(id)).toBe(true);
    const itinerary = fed.made?.itinerary;
    expect(itinerary && validationErrors(itinerary, ctx)).toEqual([]);
    for (const day of itinerary?.days ?? []) {
      for (const stop of day.stops) {
        expect(stop.reasonSource).toBe(fed.added.has(stop.placeId) ? "rule" : "ai");
      }
    }
    // The model's reasons are all kept, and no added meal counts as a reason the model left out.
    expect(fed.made?.reasonStats).toMatchObject({ replaced: 0, rejections: [] });
    fed.selection.days.forEach((day, index) => {
      const own = day.placeIds.filter((id) => !fed.added.has(id));
      expect(own).toEqual(visits.days[index]?.placeIds);
    });
  });

  it("keeps nothing the check refuses, nothing the shortlist did not offer, and no day not named", () => {
    const refused = withMealsAdded(visits, req, shortlist, ctx, [0, 1, 2], () => null);
    expect(refused).toEqual({ selection: visits, changes: [], added: new Set(), made: null });

    const noMeals = { ...shortlist, placeIds: new Set(visits.days.flatMap((d) => d.placeIds)) };
    expect(withMealsAdded(visits, req, noMeals, ctx, [0, 1, 2], check).changes).toEqual([]);

    const second = withMealsAdded(visits, req, shortlist, ctx, [1], check);
    expect(second.changes.map((change) => change.day)).toEqual(second.changes.map(() => 1));
    expect(second.selection.days[0]).toBe(visits.days[0]);
  });
});

describe("keptPlan", () => {
  const warning = (code: Violation["code"], day?: number, placeId?: string): Violation => ({
    code,
    severity: "warning",
    ...(day === undefined ? {} : { day }),
    ...(placeId === undefined ? {} : { placeId }),
    detail: code,
  });
  const made = (warnings: Violation[], errors: Violation[] = []) =>
    ({ itinerary: { warnings }, errors }) as unknown as Materialized;
  const before = made([warning("MEAL_MISSING", 1), warning("LONG_TRANSFER", 1)]);
  const added = new Set(["place_020"]);

  it("keeps a plan whose only new warning is about the meal code added", () => {
    const after = made([warning("LONG_TRANSFER", 1), warning("OVER_BUDGET", 1, "place_020")]);
    expect(keptPlan(before, after, added)).toBe(after);
  });

  it("refuses a new warning about another place or the whole trip, and any error", () => {
    const other = made([warning("OVER_BUDGET", 1, "place_021")]);
    const trip = made([warning("MUST_INCLUDE_UNPLACEABLE")]);
    const error = { ...warning("CLOSED_AT_TIME", 1, "place_020"), severity: "error" as const };
    expect(keptPlan(before, other, added)).toBeNull();
    expect(keptPlan(before, trip, added)).toBeNull();
    expect(keptPlan(before, made([], [error]), added)).toBeNull();
  });
});

describe("the whole-trip pipeline (POST /api/plan)", () => {
  it("adds the meals an answer leaves out and labels the plan ai_repaired", async () => {
    const req = request({ anchors: ["rome"], interests: ["historic"] });
    const client = new ScriptedClient(async (input) => {
      const selection = withoutMeals(validSelection(input.request, input.user, ctx));
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { itinerary, trace } = await planTrip(req, deps(client));

    expect(client.inputs).toHaveLength(1);
    expect(itinerary.source).toBe("ai_repaired");
    expect(validationErrors(itinerary, ctx)).toEqual([]);
    const added = trace.tidied.filter((change) => change.rule === "meal_added");
    expect(added.length).toBeGreaterThanOrEqual(3);
    expect(added.every((change) => change.answer === 1)).toBe(true);
    for (const change of added) {
      const stop = itinerary.days[change.day]?.stops.find((s) => s.placeId === change.placeId);
      expect(stop?.role).toMatch(/^(lunch|dinner)$/);
      expect(stop?.reasonSource).toBe("rule");
    }
    expect(trace.reasonRejections).not.toContain("empty");
    expect(mealGaps(itinerary, ctx).filter((gap) => gap.cause === "not_planned")).toEqual([]);
  });

  it("adds no meal where none is open, and a complete answer stays as written (Bologna from a Saturday)", async () => {
    // Saturday 10 to Monday 12 October 2026: no place of Bologna serves lunch on a Sunday or
    // dinner on a Monday.
    const req = request({ anchors: ["bologna"], startDate: "2026-10-10" });
    const client = new ScriptedClient(async (input) => {
      const selection = validSelection(input.request, input.user, ctx);
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { itinerary, trace } = await planTrip(req, deps(client));

    expect(itinerary.source).toBe("ai");
    expect(trace.tidied).toEqual([]);
    const noneOpen = mealGaps(itinerary, ctx).filter((gap) => gap.cause === "none_open");
    expect(noneOpen.map((gap) => [gap.day, gap.meal])).toEqual([
      [1, "lunch"],
      [2, "dinner"],
    ]);
  });
});

/** A client that answers each day with the rules' day over what it was offered, less its meals. */
class MealSkippingDayClient implements LlmClient {
  readonly model = "meal-skipping-day";
  select(): never {
    throw new Error("A day pipeline never asks for a whole trip");
  }
  repair(): never {
    throw new Error("A day pipeline never asks for a whole trip");
  }
  selectDay(input: SelectInput): Promise<LlmDayResult> {
    return Promise.resolve(this.answer(input));
  }
  repairDay(input: RepairInput): Promise<LlmDayResult> {
    return Promise.resolve(this.answer(input));
  }
  private answer(input: SelectInput): LlmDayResult {
    const full = validDayAnswer(input.request, input.user, ctx);
    const visit = (id: string) => !isMealPlace(ctx.placesById.get(id) ?? { mealCapable: false });
    const answer: LlmDayAnswer = {
      placeIds: full.placeIds.filter(visit),
      reasons: full.reasons.filter((reason) => visit(reason.placeId)),
    };
    return {
      answer,
      rawText: JSON.stringify(answer),
      schemaIssues: [],
      usage: { inputTokens: 100, outputTokens: 20 },
      latencyMs: 5,
      model: this.model,
      stopReason: "end_turn",
    };
  }
}

describe("the one-day pipeline (POST /api/plan/day)", () => {
  /** The owner's route, Rome, Venice, Bologna from Saturday 10 October 2026, up to its day 3. */
  function ownersRoute() {
    const req = request({ startDate: "2026-10-10" });
    const base = planDeterministic(req, ctx);
    const days: DaySelection[] = base.days.map((day) => ({
      anchorId: day.anchorId,
      placeIds: day.stops.map((stop) => stop.placeId),
    }));
    const route = ["rome", "venice", "bologna"];
    const plan = planRoute(req, days, route, ctx);
    const planned = plan.rulesDays ?? [];
    const waiting = withDay(planned, 2, { anchorId: "bologna", placeIds: [] });
    const input: DayInput = {
      request: req,
      days: waiting,
      day: 2,
      anchorId: "bologna",
      avoid: [],
      route,
    };
    const witness = checkDayBase(req, waiting, 2, "bologna", ctx).day as DaySelection;
    return { input, witness };
  }

  it("adds the lunch the owner's Monday in Bologna can have, and no dinner, which none serves", async () => {
    const { input, witness } = ownersRoute();

    const { result, trace } = await replanDay(input, witness, deps(new MealSkippingDayClient()));

    expect(result.source).toBe("ai_repaired");
    const added = trace.tidied.filter((change) => change.rule === "meal_added");
    expect(added).toEqual([{ rule: "meal_added", day: 2, placeId: "place_046", answer: 1 }]);
    const lunch = result.dayPlan.stops.find((stop) => stop.role === "lunch");
    expect(lunch).toMatchObject({ placeId: "place_046", start: 720, reasonSource: "rule" });
    expect(result.dayPlan.stops.some((stop) => stop.role === "dinner")).toBe(false);
    const ids = result.dayPlan.stops.map((stop) => stop.placeId);
    const days = scheduleTrip(
      input.request,
      withDay(input.days, 2, { anchorId: "bologna", placeIds: ids }),
      ctx,
    ).days;
    expect(
      dayMealGaps({ request: input.request, days }, 2, ctx).map((g) => [g.meal, g.cause]),
    ).toEqual([["dinner", "none_open"]]);
  });
});
