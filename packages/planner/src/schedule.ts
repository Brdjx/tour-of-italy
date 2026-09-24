import { TRAVEL } from "./config";
import { dayWindow, earliestMealStart, earliestOpenStart, servesMeal } from "./constraints";
import type { PlannerContext } from "./context";
import { MEAL_WAIT_MAX_MIN } from "./planPolicy";
import { dayViolations, makeViolation, stopViolations } from "./scheduleChecks";
import { type LatLng, travelMinutes } from "./travel";
import type { Anchor, Meal, Pace, Place, Stop, StopRole, TripRequest, Violation } from "./types";

// Deterministic timing of one day. scheduleDay walks a given order of places without reordering
// it; the greedy planner (dayBuilder.ts) asks the same timeStep function "what if this place came
// next", so a plan the planner builds and the same ids timed again always agree.

/** Timed stops for one day, plus every problem found while timing them. */
export interface ScheduledDay {
  stops: Stop[]; // in the given order, timed even when infeasible so the UI can show where
  violations: Violation[]; // infeasibilities found while timing (errors and warnings)
}

/** Optional extras for scheduleDay. */
export interface ScheduleOptions {
  dayIndex?: number; // copied into each violation's `day`
}

/** Where the traveler is between stops. */
export interface DayCursor {
  clock: number; // end of the previous stop, or the start of the day window
  position: LatLng; // the previous stop, or the base centroid before the first stop
  first: boolean; // no stop yet, so no buffer before the next one
  mealsTaken: readonly Meal[]; // meals already seated today
}

/** One stop timed from a cursor. */
export interface TimedStep {
  role: StopRole;
  travelMin: number; // from the cursor's position
  arrive: number; // clock + travel + buffer (no buffer before the first stop)
  start: number; // max(arrive, opening or meal window), or arrive when nothing fits
  end: number; // start + visit length
  fits: boolean; // false when the hours (and meal window) leave no start at or after arrival
}

const MEAL_ORDER: readonly Meal[] = ["lunch", "dinner"];

/** The cursor at the start of a day: the base centroid, after any transfer. */
export function startCursor(anchor: Anchor, pace: Pace, transferMin: number): DayCursor {
  const window = dayWindow(pace, transferMin);
  return { clock: window.start, position: anchor.centroid, first: true, mealsTaken: [] };
}

/**
 * The role a place takes when reached at `arrive`. A place that serves meals takes the first
 * meal not yet taken (lunch before dinner) that it can seat, when that meal can start within
 * MEAL_WAIT_MAX_MIN of the moment it could start as a visit (or it cannot be visited at all).
 * Everything else is a visit. So a restaurant reached at 11:30 is lunch at 12:00, a market
 * reached at 09:45 is a visit, and a restaurant reached at 15:00 waits for dinner at 19:00 only
 * because its kitchen is closed until then anyway.
 */
// Decision: roles are inferred from the order, never stored separately. The AI returns ids only
// and share links carry ids only, so inference is the single rule every path uses. The planner
// times its own choices with this same rule, so a planned day timed again from its ids gives
// exactly the same stops.
export function inferRole(
  place: Place,
  date: string,
  arrive: number,
  mealsTaken: readonly Meal[],
): StopRole {
  if (!place.mealCapable) return "visit";
  const visitStart = earliestOpenStart(place, date, arrive, place.durationMin);
  for (const meal of MEAL_ORDER) {
    if (mealsTaken.includes(meal) || !servesMeal(place, meal)) continue;
    const mealStart = earliestMealStart(place, date, arrive, meal, place.durationMin);
    if (mealStart === null) continue;
    if (visitStart === null || mealStart - visitStart <= MEAL_WAIT_MAX_MIN) return meal;
  }
  return "visit";
}

/** Times `place` as the next stop after `cursor`. Pure; throws RangeError on a bad date. */
export function timeStep(place: Place, date: string, cursor: DayCursor): TimedStep {
  const travelMin = travelMinutes(cursor.position, place);
  const arrive = cursor.clock + travelMin + (cursor.first ? 0 : TRAVEL.bufferMin);
  const role = inferRole(place, date, arrive, cursor.mealsTaken);
  const duration = place.durationMin;
  const start =
    role === "visit"
      ? earliestOpenStart(place, date, arrive, duration)
      : earliestMealStart(place, date, arrive, role, duration);
  if (start === null) {
    return { role, travelMin, arrive, start: arrive, end: arrive + duration, fits: false };
  }
  return { role, travelMin, arrive, start, end: start + duration, fits: true };
}

/** The cursor after visiting `place` as timed by `step`. */
export function advanceCursor(cursor: DayCursor, place: Place, step: TimedStep): DayCursor {
  const mealsTaken = step.role === "visit" ? cursor.mealsTaken : [...cursor.mealsTaken, step.role];
  return {
    clock: step.end,
    position: { lat: place.lat, lng: place.lng },
    first: false,
    mealsTaken,
  };
}

/** A stop record from a timed step, keys in a fixed order for stable JSON. */
export function stopFromStep(placeId: string, step: TimedStep): Stop {
  return {
    placeId,
    start: step.start,
    end: step.end,
    travelFromPrevMin: step.travelMin,
    role: step.role,
  };
}

/**
 * Times `orderedIds` for one day at `anchor` without reordering them. The day starts at the
 * pace's dayStart plus `transferMin`, at the base centroid. Each stop starts at the later of its
 * arrival (travel plus a buffer after the first stop) and its opening time or meal window. Roles
 * come from inferRole. Infeasible stops are still timed (starting on arrival) and reported, so
 * the UI can show where the problem is. An unknown id cannot be timed: it is reported as
 * UNKNOWN_PLACE and left out of `stops`. Throws RangeError on a bad date or a negative transfer.
 */
export function scheduleDay(
  orderedIds: readonly string[],
  date: string,
  anchor: Anchor,
  request: TripRequest,
  ctx: PlannerContext,
  transferMin: number,
  options: ScheduleOptions = {},
): ScheduledDay {
  const day = options.dayIndex;
  let cursor = startCursor(anchor, request.pace, transferMin);
  const stops: Stop[] = [];
  const earlier: Place[] = [];
  const violations: Violation[] = [];
  for (const id of orderedIds) {
    const place = ctx.placesById.get(id);
    if (!place) {
      const detail = "This place is not in the data, so it cannot be scheduled.";
      violations.push(makeViolation("UNKNOWN_PLACE", detail, { day, placeId: id }));
      continue;
    }
    const step = timeStep(place, date, cursor);
    const stop = stopFromStep(place.id, step);
    const target = { day, stopIndex: stops.length, placeId: place.id };
    const common = { date, anchor, request, ctx, transferMin, earlier, target };
    violations.push(...stopViolations({ ...common, place, stop, fits: step.fits }));
    stops.push(stop);
    earlier.push(place);
    cursor = advanceCursor(cursor, place, step);
  }
  violations.push(...dayViolations(stops, request, transferMin, day, anchor));
  return { stops, violations };
}
