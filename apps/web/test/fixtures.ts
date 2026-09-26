import {
  buildDataset,
  buildPlannerContext,
  checkDayBase,
  type Itinerary,
  type Place,
  type PlannerContext,
  type PlanSource,
  planDeterministic,
  planRoute,
  scheduleTrip,
  type TripRequest,
  withDay,
  withReplannedDays,
} from "@italy/planner";
import raw from "../../../data/italy.json";
import type { PlanDayBody } from "../lib/api";
import type { PlanDayResponse } from "../lib/apiSchemas";
import { tripSelection } from "../lib/dayCity";
import type { TripData } from "../lib/tripData";
import { buildTripOptions } from "../lib/tripOptions";

// Test fixtures built from the real dataset through the planner, exactly as the API would serve
// them: normalized places, the planner context, and deterministic itineraries.

export const GENERATED_AT = "2026-09-23T08:00:00.000Z";

export const dataset = buildDataset(raw);
export const places: Place[] = dataset.places;
export const ctx: PlannerContext = buildPlannerContext(places);

/** Tuesday 6 October 2026, a balanced food trip with the planner choosing bases. */
export const baseRequest: TripRequest = {
  startDate: "2026-10-06",
  pace: "balanced",
  interests: ["food"],
  maxPriceLevel: null,
  anchors: "auto",
  mustInclude: [],
  exclude: [],
};

export function makeRequest(overrides: Partial<TripRequest> = {}): TripRequest {
  return { ...baseRequest, ...overrides };
}

/** A deterministic plan for the request, identical on every run. */
export function fixturePlan(overrides: Partial<TripRequest> = {}): Itinerary {
  return planDeterministic(makeRequest(overrides), ctx, { generatedAt: GENERATED_AT });
}

/**
 * The owner's trip (decision 17, 2026-09-26): Rome, Venice, Bologna from Saturday 10 October,
 * days 2 and 3 planned again by the rules as the route sheet plans them, so day 3 is a Monday in
 * Bologna, where no place serves dinner.
 */
export function ownersMonday(): Itinerary {
  const plan = fixturePlan({ startDate: "2026-10-10" });
  const route = planRoute(plan.request, tripSelection(plan), ["rome", "venice", "bologna"], ctx);
  const timed = scheduleTrip(plan.request, must(route.rulesDays, "the route's days"), ctx);
  const days = [1, 2].map((day) => ({ day, dayPlan: must(timed.days[day], `day ${day + 1}`) }));
  return withReplannedDays(plan, days, ctx);
}

/** The plan as an AI-sourced API response would carry it. */
export function aiPlan(overrides: Partial<TripRequest> = {}): Itinerary {
  const plan = fixturePlan(overrides);
  return {
    ...plan,
    source: "ai",
    summary: "Three days of food in Rome.",
    meta: { ...plan.meta, model: "claude-sonnet-5", promptVersion: "v1", attempts: 1 },
    days: plan.days.map((day) => ({
      ...day,
      stops: day.stops.map((stop) => ({ ...stop, reasonSource: "ai" as const })),
    })),
  };
}

/** Everything the page loads before planning, built without the network. */
export function tripData(sourcePlaces: Place[] = places): TripData {
  const context = buildPlannerContext(sourcePlaces);
  return {
    places: sourcePlaces,
    ctx: context,
    options: buildTripOptions(context, null),
    summary: dataset.summary,
  };
}

/** A place by id from the real data; throws when it is missing so a data change fails loudly. */
export function place(id: string): Place {
  const found = ctx.placesById.get(id);
  if (!found) throw new Error(`No place ${id}`);
  return found;
}

/** The value, or a thrown error naming what was missing; keeps fixtures honest without `!`. */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`Missing ${what} in fixture`);
  return value;
}

/** A JSON Response, as fetch would return it. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The classic stored-XSS probe. Rendered as text it is harmless; parsed as HTML it runs. */
export const XSS = `<img src=x onerror="window.__xss=1">`;

/** Index of the day that visits the Vatican Museums; throws when no day does. */
export function vaticanDay(plan: Itinerary): number {
  const index = plan.days.findIndex((day) =>
    day.stops.some((stop) => ctx.placesById.get(stop.placeId)?.name === "Vatican Museums"),
  );
  if (index < 0) throw new Error("No day visits the Vatican Museums in this fixture");
  return index;
}

/** The reason an AI day answer's stops carry in these tests. */
export const AI_DAY_REASON = "A good fit for the interests in this trip.";

/**
 * What POST /api/plan/day would answer for `body`: the rules' day at its city for the trip the
 * body carries (the days planned before it, later days of a route still empty), timed in that
 * trip, with AI reasons when `source` is an AI one. Throws when the planner does not allow that
 * city for the day, so a data change fails loudly.
 */
export function dayAnswerFor(body: PlanDayBody, source: PlanSource = "ai"): PlanDayResponse {
  const days = body.days.map((day) => ({ anchorId: day.anchorId, placeIds: [...day.ids] }));
  const { request, day, anchorId } = body;
  const check = checkDayBase(request, days, day, anchorId, ctx, { avoid: body.avoid ?? [] });
  const picked = must(check.day, `a day at ${anchorId}`);
  const dayPlan = must(scheduleTrip(request, withDay(days, day, picked), ctx).days[day]);
  const ai = source !== "deterministic";
  return {
    day,
    dayPlan: {
      ...dayPlan,
      stops: dayPlan.stops.map((stop) =>
        ai ? { ...stop, reason: AI_DAY_REASON, reasonSource: "ai" as const } : stop,
      ),
    },
    source,
    meta: {
      ...(ai
        ? { model: "claude-sonnet-5", promptVersion: "day-v2" }
        : { fallbackReason: "timeout" }),
      attempts: ai ? 1 : 0,
      latencyMs: 4100,
      generatedAt: GENERATED_AT,
    },
  };
}

/**
 * What POST /api/plan/day would answer for day `day` (0-based) of `itinerary` at `anchorId`
 * planned alone: another city, or new ideas at the day's own with its places left out.
 */
export function dayAnswer(
  itinerary: Itinerary,
  day: number,
  anchorId: string,
  source: PlanSource = "ai",
): PlanDayResponse {
  const days = tripSelection(itinerary);
  const own = days[day];
  const avoid = own?.anchorId === anchorId ? own.placeIds : [];
  const body: PlanDayBody = {
    request: itinerary.request,
    days: days.map((planned) => ({ anchorId: planned.anchorId, ids: [...planned.placeIds] })),
    day,
    anchorId,
    ...(avoid.length > 0 ? { avoid: [...avoid] } : {}),
  };
  return dayAnswerFor(body, source);
}
