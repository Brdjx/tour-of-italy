import {
  type Itinerary,
  ItinerarySchema,
  type PlannerContext,
  REASON_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  TRIP_DAYS,
  validateItinerary,
} from "@italy/planner";
import { expect } from "vitest";
import { shippedData } from "../../src/data";

// The shared guard every plan test runs (plan scenario 14, failure vector F1 at the API): the
// response parses with the published Itinerary schema, has zero validator errors, and names only
// places and bases that exist in the dataset.

export function expectValidItinerary(
  body: unknown,
  ctx: PlannerContext = shippedData().ctx,
): Itinerary {
  const parsed = ItinerarySchema.safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
  const itinerary = parsed.data as Itinerary;
  const errors = validateItinerary(itinerary, ctx).filter((v) => v.severity === "error");
  expect(errors).toEqual([]);
  expect(itinerary.days).toHaveLength(TRIP_DAYS);
  for (const day of itinerary.days) {
    expect(ctx.anchorById.has(day.anchorId)).toBe(true);
    expect(day.stops.length).toBeGreaterThan(0);
    for (const stop of day.stops) {
      expect(ctx.placesById.has(stop.placeId)).toBe(true);
      expect(stop.reason?.length ?? 0).toBeLessThanOrEqual(REASON_MAX_CHARS);
    }
  }
  expect(itinerary.summary?.length ?? 0).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  expect(itinerary.warnings.every((w) => w.severity === "warning")).toBe(true);
  return itinerary;
}

/** Every stop's place id across the trip. */
export function placeIdsOf(itinerary: Itinerary): string[] {
  return itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
}
