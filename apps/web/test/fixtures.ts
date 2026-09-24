import {
  buildDataset,
  buildPlannerContext,
  type Itinerary,
  type Place,
  type PlannerContext,
  planDeterministic,
  type TripRequest,
} from "@italy/planner";
import raw from "../../../data/italy.json";
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
