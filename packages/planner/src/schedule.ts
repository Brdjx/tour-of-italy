import { dayOrigin } from "./anchors";
import { MEALS, TRAVEL } from "./config";
import {
  type DayWindow,
  dayWindow,
  earliestMealStart,
  earliestOpenStart,
  isMealPlace,
  servesMeal,
} from "./constraints";
import type { PlannerContext } from "./context";
import { MEAL_WAIT_MAX_MIN } from "./planPolicy";
import { dayViolations, stopViolations } from "./scheduleChecks";
import { type LatLng, latestReturn, travelMinutes } from "./travel";
import type { Anchor, Meal, Pace, Place, Stop, StopRole, TripRequest, Violation } from "./types";
import { makeViolation } from "./violations";

// Deterministic timing of one day. scheduleDay walks a given order of places without reordering
// it; the greedy planner (dayBuilder.ts) asks the same timeStep function "what if this place came
// next", so a plan the planner builds and the same ids timed again always agree.

/** Timed stops for one day, plus every problem found while timing them. */
export interface ScheduledDay {
  stops: Stop[]; // in the given order, timed even when infeasible so the UI can show where
  violations: Violation[]; // infeasibilities found while timing (errors and warnings)
  returnTravelMin: number; // travel from the last stop back to the day's start point, 0 if none
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

/**
 * The cursor at the start of a day, after any transfer, at `origin`. The planner always passes
 * dayOrigin(anchor, request); the default is the same point for callers without a request.
 */
export function startCursor(
  anchor: Anchor,
  pace: Pace,
  transferMin: number,
  origin: LatLng = anchor.centroid,
): DayCursor {
  const window = dayWindow(pace, transferMin);
  const position = { lat: origin.lat, lng: origin.lng };
  return { clock: window.start, position, first: true, mealsTaken: [] };
}

/**
 * The role a place takes when reached at `arrive`. A place that serves meals takes the first
 * meal not yet taken (lunch before dinner) that it can seat, when that meal can start within
 * MEAL_WAIT_MAX_MIN of the moment it could start as a visit (or it cannot be visited at all, or
 * it is the day's first stop). Everything else is a visit. So a restaurant reached at 11:30 is
 * lunch at 12:00, a market reached at 09:45 after a morning sight is a visit, and a restaurant
 * reached at 15:00 waits for dinner at 19:00 only because its kitchen is closed until then.
 */
// Decision: roles are inferred from the order, never stored separately. The AI returns ids only
// and share links carry ids only, so inference is the single rule every path uses. The planner
// times its own choices with this same rule, so a planned day timed again from its ids gives
// exactly the same stops. A meal place as the day's first stop is its meal: the traveler simply
// leaves the base later, rather than "visiting" Via Drapperie at 10:05 and eating elsewhere.
export function inferRole(
  place: Place,
  date: string,
  arrive: number,
  mealsTaken: readonly Meal[],
  firstStop = false,
): StopRole {
  if (!isMealPlace(place)) return "visit";
  const visitStart = earliestOpenStart(place, date, arrive, place.durationMin);
  for (const meal of MEAL_ORDER) {
    if (mealsTaken.includes(meal) || !servesMeal(place, meal)) continue;
    const mealStart = earliestMealStart(place, date, arrive, meal, place.durationMin);
    if (mealStart === null) continue;
    const waitable = visitStart === null || firstStop;
    if (waitable || mealStart - visitStart <= MEAL_WAIT_MAX_MIN) return meal;
  }
  return "visit";
}

/** Times `place` as the next stop after `cursor`. Pure; throws RangeError on a bad date. */
export function timeStep(place: Place, date: string, cursor: DayCursor): TimedStep {
  const travelMin = travelMinutes(cursor.position, place);
  const arrive = cursor.clock + travelMin + (cursor.first ? 0 : TRAVEL.bufferMin);
  const role = inferRole(place, date, arrive, cursor.mealsTaken, cursor.first);
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

/**
 * The step for the day's last stop. A meal place reached after noon that would only be a visit
 * waits for dinner instead, when dinner is not yet taken and the traveler still gets back to the
 * base in time (latestReturn): they go back to the hotel, then out to dinner.
 */
// Decision: only the last stop, so no later stop is pushed into the evening, and only after noon,
// so a market reached in the morning stays a morning visit. A restaurant open all afternoon
// (Il Sorpasso, Eataly) after a day that ended at 15:15 used to be timed as a 15:40 visit, so no
// pass could add it as the dinner the day was missing, although a 19:00 dinner was valid.
export function lastStopStep(
  place: Place,
  date: string,
  cursor: DayCursor,
  step: TimedStep,
  window: DayWindow,
  origin: LatLng,
): TimedStep {
  if (step.role !== "visit" || !isMealPlace(place) || !servesMeal(place, "dinner")) return step;
  if (cursor.mealsTaken.includes("dinner") || step.arrive < MEALS.lunch.earliestStart) return step;
  const start = earliestMealStart(place, date, step.arrive, "dinner", place.durationMin);
  if (start === null) return step;
  const end = start + place.durationMin;
  const back = travelMinutes(place, origin);
  if (end > window.end || end + back > latestReturn(window.end, "dinner")) return step;
  return { ...step, role: "dinner", start, end, fits: true };
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
 * pace's dayStart plus `transferMin`, at the day's start point (dayOrigin), and must end with
 * time to travel back there. Each stop starts at the later of its arrival (travel plus a buffer
 * after the first stop) and its opening time or meal window. Roles come from inferRole, and a
 * meal place that ends the day may wait for dinner (lastStopStep).
 * Infeasible stops are still timed (starting on arrival) and reported, so the UI can show where
 * the problem is. An unknown id cannot be timed: it is reported as UNKNOWN_PLACE and left out of
 * `stops`. Throws RangeError on a bad date or a negative transfer.
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
  const origin = dayOrigin(anchor, request);
  let cursor = startCursor(anchor, request.pace, transferMin, origin);
  const window = dayWindow(request.pace, transferMin);
  let lastKnown = orderedIds.length - 1;
  while (lastKnown >= 0 && !ctx.placesById.has(orderedIds[lastKnown] ?? "")) lastKnown--;
  const stops: Stop[] = [];
  const earlier: Place[] = [];
  const violations: Violation[] = [];
  for (const [index, id] of orderedIds.entries()) {
    const place = ctx.placesById.get(id);
    if (!place) {
      const detail = "This place is not in the data, so it cannot be scheduled.";
      violations.push(makeViolation("UNKNOWN_PLACE", detail, { day, placeId: id }));
      continue;
    }
    const next = timeStep(place, date, cursor);
    const step =
      index === lastKnown ? lastStopStep(place, date, cursor, next, window, origin) : next;
    const stop = stopFromStep(place.id, step);
    const target = { day, stopIndex: stops.length, placeId: place.id };
    const common = { date, anchor, request, ctx, transferMin, earlier, target };
    violations.push(...stopViolations({ ...common, place, stop, fits: step.fits }));
    stops.push(stop);
    earlier.push(place);
    cursor = advanceCursor(cursor, place, step);
  }
  const last = earlier.at(-1);
  const returnMin = last ? travelMinutes(last, origin) : 0;
  const places = earlier;
  violations.push(
    ...dayViolations({ stops, places, request, transferMin, returnMin, day, anchor }),
  );
  return { stops, violations, returnTravelMin: returnMin };
}
