import { buildPlannerContext, type PlannerContext } from "../../src/context";
import { addDays } from "../../src/time";
import type {
  DayPlan,
  Itinerary,
  Stop,
  TripRequest,
  Violation,
  ViolationCode,
} from "../../src/types";
import { validateItinerary } from "../../src/validate";
import { realResult } from "../helpers";
import { fittedWarnings } from "./tripLength";
import { itinerary, stop, tripMilan, tripNewYear, tripRome, tripTuscany } from "./trips";

// Shared helpers for the validator tests: the real context, the valid trips with the exact
// warnings each carries, a small base trip for one-code tests, and lookups that fail loudly.

let cached: PlannerContext | null = null;

/** The real dataset as a planner context, built once per test file. */
export function ctx(): PlannerContext {
  cached ??= buildPlannerContext(realResult().places);
  return cached;
}

/**
 * A small valid trip for one-code tests: Rome, Rome, then Florence (a 2 h 10 min transfer) at a
 * balanced pace, Tue 20 to Thu 22 Oct 2026, with one or two stops a day. It has no errors; its
 * only warnings are missing meals.
 */
export function miniTrip(overrides: Partial<TripRequest> = {}): Itinerary {
  const request: TripRequest = {
    startDate: "2026-10-20",
    pace: "balanced",
    interests: [],
    maxPriceLevel: null,
    anchors: "auto",
    mustInclude: [],
    exclude: [],
    ...overrides,
  };
  return itinerary(request, [
    {
      date: "2026-10-20",
      anchorId: "rome",
      transferMin: 0,
      stops: [
        stop("place_005", 600, 645, 5, "visit"), // Pantheon 10:00 to 10:45
        stop("place_022", 750, 840, 10, "lunch"), // Roscioli Salumeria 12:30 to 14:00
      ],
    },
    {
      date: "2026-10-21",
      anchorId: "rome",
      transferMin: 0,
      stops: [stop("place_001", 600, 720, 20, "visit")], // Colosseum 10:00 to 12:00
    },
    {
      date: "2026-10-22",
      anchorId: "florence",
      transferMin: 130,
      stops: [stop("place_093", 720, 750, 10, "visit")], // Piazza del Duomo 12:00 to 12:30
    },
  ]);
}

/** A valid trip and the exact warnings it carries, as "CODE day placeId" keys. */
export interface ValidTrip {
  name: string;
  build: () => Itinerary;
  warnings: string[];
}

export const VALID_TRIPS: readonly ValidTrip[] = [
  { name: "Rome, balanced", build: tripRome, warnings: fittedWarnings([]) },
  {
    name: "Florence and Bologna, relaxed",
    build: tripTuscany,
    // No MEAL_MISSING for day 2's lunch: the Chianti bike day covers it (coversMeal).
    warnings: fittedWarnings(["HOURS_UNKNOWN 1 place_035"]),
  },
  {
    name: "Milan, packed",
    build: tripMilan,
    warnings: fittedWarnings([
      "MEAL_MISSING 1 -",
      "OVER_BUDGET 2 place_102",
      "MEAL_MISSING 2 -",
      "MEAL_MISSING 2 -",
    ]),
  },
  {
    name: "Rome to Venice over New Year, packed",
    build: tripNewYear,
    warnings: fittedWarnings([
      "LOW_RATING 0 place_025",
      "LONG_TRANSFER 1 -",
      "HOURS_UNKNOWN 2 place_071",
    ]),
  },
];

/** "CODE day placeId" for a violation, the form VALID_TRIPS lists warnings in. */
export function key(item: Violation): string {
  return `${item.code} ${item.day ?? "-"} ${item.placeId ?? "-"}`;
}

/** The codes of the errors the validator reports. */
export function errorCodes(plan: Itinerary): ViolationCode[] {
  return validateItinerary(plan, ctx())
    .filter((item) => item.severity === "error")
    .map((item) => item.code);
}

/** The violations for a plan with the given code. */
export function withCode(plan: Itinerary, code: ViolationCode): Violation[] {
  return validateItinerary(plan, ctx()).filter((item) => item.code === code);
}

/** Dates every day of the plan from its request's start date: day i is the start plus i. */
export function redate(plan: Itinerary): Itinerary {
  plan.days.forEach((day, index) => {
    day.date = addDays(plan.request.startDate, index);
  });
  return plan;
}

/** A day of a plan, throwing when it is missing so a bad index fails loudly. */
export function dayOf(plan: Itinerary, index: number): DayPlan {
  const day = plan.days[index];
  if (!day) throw new Error(`No day ${index}`);
  return day;
}

/** A stop of a plan, throwing when it is missing. */
export function stopOf(plan: Itinerary, dayIndex: number, stopIndex: number): Stop {
  const found = dayOf(plan, dayIndex).stops[stopIndex];
  if (!found) throw new Error(`No stop ${stopIndex} on day ${dayIndex}`);
  return found;
}
