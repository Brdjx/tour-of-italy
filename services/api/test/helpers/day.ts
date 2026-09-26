import {
  type DaySelection,
  type Itinerary,
  planDeterministic,
  type TripRequest,
  usedOnOtherDays,
  validationErrors,
  withReplannedDay,
} from "@italy/planner";
import { expect } from "vitest";
import { type PlanDayResponse, PlanDayResponseSchema } from "../../src/contract";
import { shippedData } from "../../src/data";
import type { DayInput } from "../../src/plan/dayInput";
import { START_DATE, tripBody } from "./app";

// Helpers for POST /api/plan/day: a planned trip to re-plan a day of, the request body, and the
// guard every day answer must pass: the published schema, and a trip that, with the day applied
// as the page applies it, has zero validator errors, no place on two days, and the other days
// unchanged.

const { ctx } = shippedData();

/** A rules-only trip for the request, as the page would hold it. */
export function plannedTrip(overrides: Partial<TripRequest> = {}): Itinerary {
  const request = tripBody({ anchors: ["rome"], ...overrides }) as unknown as TripRequest;
  return planDeterministic(request, ctx);
}

/** The body of POST /api/plan/day for day `day` of `trip` at `anchorId`. */
export function dayBody(
  trip: Itinerary,
  day: number,
  anchorId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    request: trip.request,
    days: trip.days.map((d) => ({ anchorId: d.anchorId, ids: d.stops.map((s) => s.placeId) })),
    day,
    anchorId,
    ...extra,
  };
}

/** The pipeline's input for the same day. */
export function dayInput(
  trip: Itinerary,
  day: number,
  anchorId: string,
  avoid: string[] = [],
): DayInput {
  return {
    request: trip.request,
    days: trip.days.map((d) => ({ anchorId: d.anchorId, placeIds: d.stops.map((s) => s.placeId) })),
    day,
    anchorId,
    avoid,
    route: null,
  };
}

/**
 * The body of POST /api/plan/day for day `day` of a route, as the page sends it: the trip as ids
 * with the route's cities in, the days planned so far, and the days still to plan empty.
 */
export function routeBody(
  request: TripRequest,
  days: readonly DaySelection[],
  day: number,
  route: readonly string[],
): Record<string, unknown> {
  return {
    request,
    days: days.map((d) => ({ anchorId: d.anchorId, ids: [...d.placeIds] })),
    day,
    anchorId: route[day],
    route: [...route],
  };
}

export interface DayPostOptions {
  scenario?: string;
  query?: string;
  headers?: Record<string, string>;
}

export function postDay(
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
  body: unknown,
  options: DayPostOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };
  if (options.scenario) headers["x-fixture-scenario"] = options.scenario;
  const path = options.query ? `/api/plan/day?${options.query}` : "/api/plan/day";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return Promise.resolve(app.request(path, { method: "POST", headers, body: text }));
}

/** Parses a day answer and checks it against the trip it was planned for. */
export function expectValidDay(body: unknown, trip: Itinerary, day: number): PlanDayResponse {
  const parsed = PlanDayResponseSchema.safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
  const result = parsed.data as PlanDayResponse;
  expect(result.day).toBe(day);
  expect(result.dayPlan.stops.length).toBeGreaterThan(0);
  const ids = result.dayPlan.stops.map((stop) => stop.placeId);
  const selection = trip.days.map((d) => ({
    anchorId: d.anchorId,
    placeIds: d.stops.map((s) => s.placeId),
  }));
  const used = usedOnOtherDays(selection, day);
  expect(ids.filter((id) => used.has(id))).toEqual([]);
  for (const id of ids) {
    expect(ctx.anchorIdByPlaceId.get(id)).toBe(result.dayPlan.anchorId);
    expect(trip.request.exclude).not.toContain(id);
  }
  const applied = withReplannedDay(trip, day, result.dayPlan, ctx);
  expect(validationErrors(applied, ctx)).toEqual([]);
  applied.days.forEach((other, index) => {
    if (index === day) return;
    expect(other.stops.map((s) => s.placeId)).toEqual(selection[index]?.placeIds);
  });
  return result;
}

export { START_DATE };
