import { compareText } from "./anchors";
import { MEALS, PACE } from "./config";
import { servesMeal, sharesLocation, withinBudget } from "./constraints";
import type { PlannerContext } from "./context";
import { inSatelliteArea } from "./dayRules";
import { breakingStarts, longestWait, mealsOf, noNewBreaks } from "./dayShape";
import { MEAL_WAIT_MAX_MIN } from "./planPolicy";
import type { PoolCache } from "./pools";
import { type ScheduledDay, scheduleDay } from "./schedule";
import { scorePlace } from "./score";
import type { TripDraft } from "./tripBuilder";
import { transferInto } from "./tripWalk";
import type { Anchor, Meal, Place, TripRequest } from "./types";
import { isError } from "./violations";

// A closing pass for meals. The walk shares meal places out as each day reaches a meal, but it
// judges each day's promise ("a dinner place is still free tonight") on its own, so another day
// can take the place a day was counting on, and the day ends with no dinner while an unused
// place could have seated it. For each day still missing lunch or dinner, this tries every
// unused meal place of the base at every position, and keeps the insertion that seats the meal
// with the shortest wait and leaves the rest of the day as it was: no error, every stop in the
// same role, no meal lost, no stop newly breaking a day rule, no wait over MEAL_WAIT_MAX_MIN (or
// over the longest the day already had), and the meal in the base city or in the area the day is
// already visiting. It only adds; it never removes or reorders a stop.

/** The draft with every missing meal that an unused meal place can seat added. Pure. */
export function fillMissingMeals(
  draft: TripDraft,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  pools: PoolCache,
): TripDraft {
  const days = draft.days.map((ids) => [...ids]);
  days.forEach((_, index) => {
    for (const meal of ["lunch", "dinner"] as const) {
      const day = dayToFill({ ...draft, days }, index, request, ctx, dates);
      if (!day) return;
      const candidates = mealPlacesFor(day.anchor, meal, days, request, ctx, pools);
      const filled = withMeal(day, meal, candidates);
      if (filled) days[index] = filled;
    }
  });
  return { ...draft, days };
}

/** One day of the draft and how to time it. */
export interface DayToFill {
  ids: readonly string[];
  date: string;
  dayStart: number; // the start of the day window, after any transfer
  anchor: Anchor;
  ctx: PlannerContext;
  time: (ids: readonly string[]) => ScheduledDay;
}

/** Day `index` of the draft, ready to time; null for an unknown base or a missing date. */
export function dayToFill(
  draft: TripDraft,
  index: number,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
): DayToFill | null {
  const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
  const date = dates[index];
  if (!anchor || date === undefined) return null;
  const transferMin = transferInto(draft.anchorIds, index, ctx);
  const time = (ids: readonly string[]) =>
    scheduleDay(ids, date, anchor, request, ctx, transferMin);
  const dayStart = PACE[request.pace].dayStart + transferMin;
  return { ids: draft.days[index] ?? [], date, dayStart, anchor, ctx, time };
}

/**
 * Unused meal places of the base that serve the meal and share no spot with a place in the
 * trip: within the budget first (pools.ts adds one level over as a fallback), then the best
 * score, then id.
 */
export function mealPlacesFor(
  anchor: Anchor,
  meal: Meal,
  days: readonly string[][],
  request: TripRequest,
  ctx: PlannerContext,
  pools: PoolCache,
): Place[] {
  const inTrip = days.flat().map((id) => ctx.placesById.get(id));
  const free = pools
    .strict(anchor.id)
    .filter(
      (place) =>
        servesMeal(place, meal) &&
        !inTrip.some((other) => other && (other.id === place.id || sharesLocation(other, place))),
    );
  const budget = (place: Place) => (withinBudget(place, request.maxPriceLevel) ? 0 : 1);
  const score = (place: Place) => scorePlace(place, request);
  return free.sort(
    (a, b) => budget(a) - budget(b) || score(b) - score(a) || compareText(a.id, b.id),
  );
}

/**
 * The day's ids with one of `candidates` seated as `meal`, or null when none fits cleanly. The
 * first candidate that fits wins, at its position with the shortest longest wait.
 */
// Decision: the shortest wait, not the first position. Tried from the start of the day, lunch at
// Via Drapperie became the first stop of a Bologna day: nothing from 09:30 to 12:00, then every
// morning sight in the afternoon. After the morning's last sight the same lunch waits 10 minutes.
// A meal may keep the traveler waiting up to MEAL_WAIT_MAX_MIN, as inferRole lets it.
export function withMeal(
  day: DayToFill,
  meal: Meal,
  candidates: readonly Place[],
): string[] | null {
  if (candidates.length === 0) return null;
  const before = day.time(day.ids);
  if (before.violations.some(isError)) return null; // the repair and clean-up steps own it
  const places = placesOf(before, day.ctx);
  const meals = mealsOf(before.stops, places);
  if (meals.includes(meal)) return null;
  const breaking = breakingStarts(before.stops, places, day.date);
  const waitCap = Math.max(longestWait(before.stops, day.dayStart), MEAL_WAIT_MAX_MIN);
  for (const candidate of candidates) {
    let best: { ids: string[]; wait: number } | null = null;
    for (let at = 0; at <= day.ids.length; at++) {
      const previous = before.stops[at - 1];
      if (previous && previous.end > MEALS[meal].latestStart) break; // too late from here on
      if (!onTheWay(candidate, places, at, day.anchor)) continue;
      const ids = [...day.ids.slice(0, at), candidate.id, ...day.ids.slice(at)];
      const after = day.time(ids);
      if (after.violations.some(isError) || after.stops[at]?.role !== meal) continue;
      if (!sameRoles(before, after, candidate.id)) continue;
      const afterPlaces = placesOf(after, day.ctx);
      if (mealsOf(after.stops, afterPlaces).length <= meals.length) continue; // lost a covered one
      if (!noNewBreaks(breakingStarts(after.stops, afterPlaces, day.date), breaking)) continue;
      const wait = longestWait(after.stops, day.dayStart);
      if (wait <= waitCap && (best === null || wait < best.wait)) best = { ids, wait };
    }
    if (best) return best.ids;
  }
  return null;
}

/** True when every stop of `before` keeps its role in `after`, which adds `added`. */
export function sameRoles(before: ScheduledDay, after: ScheduledDay, added: string): boolean {
  const roles = new Map(before.stops.map((stop) => [stop.placeId, stop.role]));
  return after.stops.every(
    (stop) => stop.placeId === added || roles.get(stop.placeId) === stop.role,
  );
}

/**
 * True when a meal at position `at` keeps the day's one trip out of town in one piece: a meal in
 * the base city anywhere but between two out-of-town stops, or a meal out of town right after a
 * stop in the same area (lunch in Parma after the Parma tour, never between two Bologna sights).
 */
function onTheWay(place: Place, places: readonly Place[], at: number, anchor: Anchor): boolean {
  const away = (other: Place | undefined) => other !== undefined && other.city !== anchor.name;
  const before = places.slice(0, at);
  if (place.city === anchor.name) return !(away(before.at(-1)) && away(places[at]));
  return away(before.at(-1)) && inSatelliteArea(place, before, anchor);
}

/** The places of a timed day, in order. Every id in a draft is a known place. */
export function placesOf(day: ScheduledDay, ctx: PlannerContext): Place[] {
  return day.stops.map((stop) => ctx.placesById.get(stop.placeId) as Place);
}
