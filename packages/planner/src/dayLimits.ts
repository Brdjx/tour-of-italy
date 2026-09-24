import { MEALS } from "./config";
import { type DayWindow, dayWindow, isMealPlace, isOuting, servesMeal } from "./constraints";
import { closedForHoliday, daylightEnd } from "./dayRules";
import { OUTING_LATEST_START } from "./planPolicy";
import { hoursOn } from "./time";
import { type LatLng, latestReturn, travelMinutes } from "./travel";
import type { Meal, Pace, Place, StopRole, TimeRange } from "./types";

// Latest feasible start times for one day, used by the greedy walk to look ahead: "if I take
// this visit, can I still reach a lunch place in time?". A start is feasible when the whole stop
// fits one open range, ends in time to travel back to the base before the day window closes,
// and (for a meal) starts inside the meal's window. The planner's own preferences tighten it for
// places the traveler did not ask for: an outing starts by OUTING_LATEST_START, a park or
// outdoor experience ends by sunset, and a museum takes no role on a holiday. Feasibility only
// gets worse with a later arrival, so "arrive <= latest start" is the whole test.

/** The latest feasible start for each role a place can take on one date. Absent = never. */
export interface LatestStarts {
  lunch?: number;
  dinner?: number;
  visit?: number; // absent for a meal place unless it is a must-include (see mayVisit)
}

/** The fields latestStartsFor reads. */
export interface LimitInput {
  date: string;
  pace: Pace;
  transferMin: number;
  origin: LatLng; // where the day starts and ends (dayOrigin)
  pool: readonly Place[];
  mustInclude: readonly string[]; // must-include meal places may also be visits
}

/**
 * True when the planner may use the place as a visit. A meal place (a restaurant, a food hall, a
 * cicchetti crawl) is only ever a meal, unless the traveler asked for it; then it may also be a
 * visit, but only once no meal it serves can still happen that day (dayRules.ts).
 */
// Decision: meal places are for meals. Used as morning visits they ran out before the last day,
// which then had no lunch or dinner (the Rome and Bologna food trips); a restaurant "visit" at
// 10:00 or after dinner is not a plan anyone wants either. A must-include restaurant is the
// exception: with both meals taken by other places the traveler asked for, a late visit beats
// leaving it out, and it is exactly what the validator counts as placeable.
export function mayVisit(place: Place, mustInclude: readonly string[]): boolean {
  return !isMealPlace(place) || mustInclude.includes(place.id);
}

/** Latest starts for every place in the pool on the day's date. */
export function latestStartsFor(input: LimitInput): Map<string, LatestStarts> {
  const window = dayWindow(input.pace, input.transferMin);
  const limits = new Map<string, LatestStarts>();
  for (const place of input.pool) {
    const ranges = hoursOn(place, input.date);
    // Decision: the preferences never keep out a place the traveler asked for. The validator
    // judges must-includes by the hard rules alone, so the planner must be able to place one
    // wherever those allow (a January day trip to Siena that ends 15 minutes after sunset).
    const preferred = !input.mustInclude.includes(place.id);
    if (preferred && closedForHoliday(place, input.date)) {
      limits.set(place.id, {}); // no role today: see HOLIDAY_CLOSURES
      continue;
    }
    const usable = (role: StopRole) => usableWindow(place, role, window, input, preferred);
    const entry: LatestStarts = {};
    for (const meal of ["lunch", "dinner"] as const) {
      if (!servesMeal(place, meal)) continue;
      const latest = latestMealStart(ranges, meal, place.durationMin, usable(meal));
      if (latest !== null) entry[meal] = latest;
    }
    if (mayVisit(place, input.mustInclude)) {
      const cap = preferred && isOuting(place) ? OUTING_LATEST_START : Number.POSITIVE_INFINITY;
      const latest = latestVisitStart(ranges, place.durationMin, usable("visit"), cap);
      if (latest !== null) entry.visit = latest;
    }
    limits.set(place.id, entry);
  }
  return limits;
}

/**
 * The part of the day window a stop in `role` may use: it ends inside the window, in time to get
 * back to the base (a dinner may end the day a little later: latestReturn), and, for a place the
 * traveler did not ask for, by the planner's preferred end (daylightEnd).
 */
function usableWindow(
  place: Place,
  role: StopRole,
  window: DayWindow,
  input: LimitInput,
  preferred: boolean,
): DayWindow {
  const back = travelMinutes(place, input.origin);
  const end = Math.min(window.end, latestReturn(window.end, role) - back);
  return {
    start: window.start,
    end: preferred ? Math.min(end, daylightEnd(place, input.date)) : end,
  };
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

/**
 * Latest visit start inside one open range and the window, no later than `startCap`, or null.
 */
export function latestVisitStart(
  ranges: TimeRange[] | "unknown",
  durationMin: number,
  window: DayWindow,
  startCap = Number.POSITIVE_INFINITY,
): number | null {
  const open = ranges === "unknown" ? [{ open: window.start, close: window.end }] : ranges;
  let latest: number | null = null;
  for (const range of open) {
    const low = Math.max(range.open, window.start);
    const high = Math.min(Math.min(range.close, window.end) - durationMin, startCap);
    if (low <= high && (latest === null || high > latest)) latest = high;
  }
  return latest;
}

/** Latest meal start inside the meal's start window, one open range, and the window. */
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
 * True when the place could be the first and only stop of a day starting at `origin` after
 * `transferMin`: some role it can take has a feasible start after the first leg.
 */
export function fitsEmptyDay(
  place: Place,
  date: string,
  pace: Pace,
  transferMin: number,
  origin: LatLng,
): boolean {
  const window = dayWindow(pace, transferMin);
  const limits = latestStartsFor({
    date,
    pace,
    transferMin,
    origin,
    pool: [place],
    mustInclude: [place.id],
  });
  const latest = latestStartFor(limits, place.id, []);
  return latest !== null && window.start + travelMinutes(origin, place) <= latest;
}
