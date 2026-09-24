import { MEALS } from "./config";
import { type DayWindow, dayWindow, servesMeal } from "./constraints";
import { hoursOn } from "./time";
import { type LatLng, travelMinutes } from "./travel";
import type { Meal, Pace, Place, TimeRange } from "./types";

// Latest feasible start times for one day, used by the greedy walk to look ahead: "if I take
// this visit, can I still reach a lunch place in time?". A start is feasible when the whole stop
// fits one open range, the day window, and (for a meal) the meal's start window. Feasibility only
// gets worse with a later arrival, so "arrive <= latest start" is the whole test.

/** The latest feasible start for each role a place can take on one date. Absent = never. */
export interface LatestStarts {
  lunch?: number;
  dinner?: number;
  visit?: number; // absent for a restaurant unless it is a must-include (see mayVisit)
}

/** The fields latestStartsFor reads. */
export interface LimitInput {
  date: string;
  pace: Pace;
  transferMin: number;
  pool: readonly Place[];
  mustInclude: readonly string[]; // must-include restaurants may also be visits
}

/**
 * True when the planner may use the place as a visit. A restaurant is only ever a meal, unless
 * the traveler asked for it: then it may also follow both meals as a visit.
 */
// Decision: a restaurant "visit" at 10:00 or after dinner is not a plan anyone wants, so the
// planner avoids it. A must-include restaurant is the exception: with both meal slots already
// taken by other places the traveler asked for, a late visit beats leaving it out, and it is
// exactly what the validator counts as placeable.
export function mayVisit(place: Place, mustInclude: readonly string[]): boolean {
  return place.type !== "restaurant" || mustInclude.includes(place.id);
}

/** Latest starts for every place in the pool on the day's date. */
export function latestStartsFor(input: LimitInput): Map<string, LatestStarts> {
  const window = dayWindow(input.pace, input.transferMin);
  const limits = new Map<string, LatestStarts>();
  for (const place of input.pool) {
    const ranges = hoursOn(place, input.date);
    const entry: LatestStarts = {};
    for (const meal of ["lunch", "dinner"] as const) {
      if (!servesMeal(place, meal)) continue;
      const latest = latestMealStart(ranges, meal, place.durationMin, window);
      if (latest !== null) entry[meal] = latest;
    }
    if (mayVisit(place, input.mustInclude)) {
      const latest = latestVisitStart(ranges, place.durationMin, window);
      if (latest !== null) entry.visit = latest;
    }
    limits.set(place.id, entry);
  }
  return limits;
}

/** The latest start of any role still open to the place, or null when none is. */
export function latestStartFor(
  limits: ReadonlyMap<string, LatestStarts>,
  placeId: string,
  mealsTaken: readonly Meal[],
): number | null {
  const entry = limits.get(placeId);
  if (!entry) return null;
  const candidates: number[] = [];
  if (entry.visit !== undefined) candidates.push(entry.visit);
  for (const meal of ["lunch", "dinner"] as const) {
    const latest = entry[meal];
    if (latest !== undefined && !mealsTaken.includes(meal)) candidates.push(latest);
  }
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/** Latest visit start inside one open range and the day window, or null. */
export function latestVisitStart(
  ranges: TimeRange[] | "unknown",
  durationMin: number,
  window: DayWindow,
): number | null {
  const open = ranges === "unknown" ? [{ open: window.start, close: window.end }] : ranges;
  let latest: number | null = null;
  for (const range of open) {
    const low = Math.max(range.open, window.start);
    const high = Math.min(range.close, window.end) - durationMin;
    if (low <= high && (latest === null || high > latest)) latest = high;
  }
  return latest;
}

/** Latest meal start inside the meal's start window, one open range, and the day window. */
export function latestMealStart(
  ranges: TimeRange[] | "unknown",
  meal: Meal,
  durationMin: number,
  window: DayWindow,
): number | null {
  const meals = MEALS[meal];
  const open = ranges === "unknown" ? [{ open: window.start, close: window.end }] : ranges;
  let latest: number | null = null;
  for (const range of open) {
    const low = Math.max(range.open, window.start, meals.earliestStart);
    const high = Math.min(range.close, window.end) - durationMin;
    const lastStart = Math.min(high, meals.latestStart);
    if (low <= lastStart && (latest === null || lastStart > latest)) latest = lastStart;
  }
  return latest;
}

/**
 * True when the place could be the first and only stop of a day starting at `from` (the base
 * centroid) after `transferMin`: some role it can take has a feasible start after the travel.
 */
export function fitsEmptyDay(
  place: Place,
  date: string,
  pace: Pace,
  transferMin: number,
  from: LatLng,
): boolean {
  const window = dayWindow(pace, transferMin);
  const limits = latestStartsFor({
    date,
    pace,
    transferMin,
    pool: [place],
    mustInclude: [place.id],
  });
  const latest = latestStartFor(limits, place.id, []);
  return latest !== null && window.start + travelMinutes(from, place) <= latest;
}
