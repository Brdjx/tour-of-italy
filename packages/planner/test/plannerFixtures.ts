import fc from "fast-check";
import { ITALY_BBOX } from "../src/config";
import { buildPlannerContext, type PlannerContext } from "../src/context";
import { makeWeek } from "../src/time";
import type { Place, TripRequest, Weekday } from "../src/types";
import { realResult } from "./helpers";

// Fixtures for the planner-core tests (travel, bases, constraints, scoring, reasons): the real
// dataset as a PlannerContext, and small synthetic places for the edge cases the data lacks.

let cachedContext: PlannerContext | null = null;

/** The planner context over the real dataset, built once per test file. */
export function realContext(): PlannerContext {
  cachedContext ??= buildPlannerContext(realResult().places);
  return cachedContext;
}

/** A real place from the context; throws when missing so a renamed id fails loudly. */
export function realPlace(id: string): Place {
  const found = realContext().placesById.get(id);
  if (!found) throw new Error(`No place ${id} in the real context`);
  return found;
}

const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** A valid synthetic museum in central Rome, open 09:00 to 19:00 every day, with overrides. */
export function makePlace(overrides: Partial<Place> = {}): Place {
  return {
    id: "place_test",
    name: "Test Place",
    type: "museum",
    city: "Rome",
    region: "Lazio",
    neighborhood: "Celio",
    description: "A synthetic place for tests.",
    lat: 41.8902,
    lng: 12.4922,
    locationSource: "listed",
    hours: makeWeek(EVERY_DAY, [{ open: 540, close: 1140 }]),
    hoursConfidence: "listed",
    hoursRaw: "9:00-19:00",
    hoursDerivation: null,
    dateRules: [],
    seasonalNote: null,
    durationMin: 60,
    durationSource: "listed",
    priceLevel: 2,
    rating: 4.5,
    tags: ["art"],
    bookingRequired: false,
    bookAhead: false,
    mealCapable: false,
    meals: [],
    sharedLocationWith: [],
    issues: [],
    ...overrides,
  };
}

/** A complete trip request with sensible defaults. */
export function makeRequest(overrides: Partial<TripRequest> = {}): TripRequest {
  return {
    startDate: "2026-10-19",
    pace: "balanced",
    interests: [],
    maxPriceLevel: null,
    anchors: "auto",
    mustInclude: [],
    exclude: [],
    ...overrides,
  };
}

/** A point `km` kilometers due north of `from` (one degree of latitude is about 111.19 km). */
export function northOf(
  from: { lat: number; lng: number },
  km: number,
): { lat: number; lng: number } {
  const kmPerDegree = (6371 * Math.PI) / 180;
  return { lat: from.lat + km / kmPerDegree, lng: from.lng };
}

/** fast-check settings: a fixed seed so CI is repeatable; FC_SEED and FC_RUNS widen a nightly run. */
export const FC_SETTINGS = {
  seed: Number(process.env.FC_SEED ?? 20260923),
  numRuns: Number(process.env.FC_RUNS ?? 500),
};

/** Any point inside Italy's bounding box. */
export const italyPoint = fc.record({
  lat: fc.double({ min: ITALY_BBOX.minLat, max: ITALY_BBOX.maxLat, noNaN: true }),
  lng: fc.double({ min: ITALY_BBOX.minLng, max: ITALY_BBOX.maxLng, noNaN: true }),
});
