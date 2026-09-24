import type { PlannerContext } from "./context";
import { breakingStarts, longestWait, mealsOf, noNewBreaks } from "./dayShape";
import {
  type DayToFill,
  dayToFill,
  mealPlacesFor,
  placesOf,
  sameRoles,
  withMeal,
} from "./mealFill";
import { MEAL_WAIT_MAX_MIN } from "./planPolicy";
import type { PoolCache } from "./pools";
import type { TripDraft } from "./tripBuilder";
import type { Meal, Place, TripRequest } from "./types";
import { isError } from "./violations";

// The last meal pass (after mealFill.ts). The walk shares meal places out one day at a time, so
// where they are scarce one day can end with two meals while another day of the base has none,
// though a swap would feed both: in Florence at budget 1, day 1 had lunch and dinner and day 3,
// a Monday, had nothing, because day 2 took the only dinner place open on Monday. For each day
// with no meal, this moves a meal place over from a day of the base that has two (it keeps one),
// or, failing that, moves the only meal of another day over and gives that day a replacement:
// an unused meal place or one a third day with two can spare. Every day it touches must time
// cleanly with its other stops in the same roles, no new day-rule break, and no long new wait
// (the checks of mealFill.ts). Must-include stops never move.

/**
 * The draft with meals moved to days that have none, where that seats them cleanly; the draft
 * itself when nothing moves. Pure.
 */
export function shareMeals(
  draft: TripDraft,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  pools: PoolCache,
): TripDraft {
  let moved = false;
  const trip: TripDraft = { ...draft, days: draft.days.map((ids) => [...ids]) };
  const share: Sharing = {
    request,
    day: (index) => dayToFill(trip, index, request, ctx, dates),
    unused: (index, meal) => {
      const anchor = ctx.anchorById.get(trip.anchorIds[index] ?? "");
      return anchor ? mealPlacesFor(anchor, meal, trip.days, request, ctx, pools) : [];
    },
  };
  trip.days.forEach((_, index) => {
    if (mealCount(share, index) !== 0) return;
    const moves = moveSpare(share, trip, index) ?? moveWithRefill(share, trip, index);
    for (const [day, ids] of moves ?? []) trip.days[day] = ids;
    moved ||= moves !== null;
  });
  return moved ? trip : draft; // the same object when nothing moved
}

/** What the moves need: the request, each day as the fill sees it, and unused meal places. */
interface Sharing {
  request: TripRequest;
  day: (index: number) => DayToFill | null;
  unused: (index: number, meal: Meal) => Place[];
}

/** New ids by day index for the days a move changes. */
type Moves = Map<number, string[]>;

function mealCount(share: Sharing, index: number): number {
  const day = share.day(index);
  if (!day) return -1;
  const timed = day.time(day.ids);
  return mealsOf(timed.stops, placesOf(timed, day.ctx)).length;
}

/** The meal places seated on day `index` that the traveler did not ask for. */
function mealStops(share: Sharing, index: number): Place[] {
  const day = share.day(index);
  if (!day) return [];
  const timed = day.time(day.ids);
  const places = placesOf(timed, day.ctx);
  return places.filter(
    (place, at) =>
      timed.stops[at]?.role !== "visit" && !share.request.mustInclude.includes(place.id),
  );
}

/** Day `index` seated with `place` as one of the meals it lacks, or null. */
function seat(share: Sharing, index: number, candidates: readonly Place[]): string[] | null {
  const day = share.day(index);
  if (!day) return null;
  for (const meal of ["lunch", "dinner"] as const) {
    const ids = withMeal(day, meal, candidates);
    if (ids) return ids;
  }
  return null;
}

/**
 * Day `index` without `place`, when the rest still times cleanly in the same roles, breaks no new
 * day rule, waits no longer than the fill allows, and keeps at least `keep` meals; else null.
 */
function without(share: Sharing, index: number, place: Place, keep: number): string[] | null {
  const day = share.day(index);
  if (!day) return null;
  const before = day.time(day.ids);
  const ids = day.ids.filter((id) => id !== place.id);
  const after = day.time(ids);
  if (after.violations.some(isError) || !sameRoles(before, after, "")) return null;
  const places = placesOf(after, day.ctx);
  if (mealsOf(after.stops, places).length < keep) return null;
  const breaking = breakingStarts(before.stops, placesOf(before, day.ctx), day.date);
  if (!noNewBreaks(breakingStarts(after.stops, places, day.date), breaking)) return null;
  const cap = Math.max(longestWait(before.stops, day.dayStart), MEAL_WAIT_MAX_MIN);
  return longestWait(after.stops, day.dayStart) <= cap ? ids : null;
}

/** The other days of the base of day `index` with at least `meals` meals. */
function daysWith(share: Sharing, trip: TripDraft, index: number, meals: number): number[] {
  const days: number[] = [];
  trip.anchorIds.forEach((anchorId, other) => {
    if (other === index || anchorId !== trip.anchorIds[index]) return;
    if (mealCount(share, other) >= meals) days.push(other);
  });
  return days;
}

/** A meal place moved to the hungry day from a day that has two and keeps one. */
function moveSpare(share: Sharing, trip: TripDraft, hungry: number): Moves | null {
  for (const donor of daysWith(share, trip, hungry, 2)) {
    for (const place of mealStops(share, donor)) {
      const fed = seat(share, hungry, [place]);
      const left = fed && without(share, donor, place, 1);
      if (fed && left)
        return new Map([
          [hungry, fed],
          [donor, left],
        ]);
    }
  }
  return null;
}

/**
 * The only meal of another day moved to the hungry day, and that day given another: an unused
 * meal place, or one a third day with two meals can spare.
 */
function moveWithRefill(share: Sharing, trip: TripDraft, hungry: number): Moves | null {
  for (const donor of daysWith(share, trip, hungry, 1)) {
    for (const place of mealStops(share, donor)) {
      const fed = seat(share, hungry, [place]);
      const left = fed && without(share, donor, place, 0);
      if (!fed || !left) continue;
      const moved: Moves = new Map([
        [hungry, fed],
        [donor, left],
      ]);
      const refill = applied(trip, moved, () => refillDay(share, trip, donor, [hungry, donor]));
      if (refill) return new Map([...moved, ...refill]);
    }
  }
  return null;
}

/** `run` with the moves applied to the trip, which is restored afterwards. */
function applied<T>(trip: TripDraft, moves: Moves, run: () => T): T {
  const original = new Map([...moves.keys()].map((day) => [day, trip.days[day] ?? []]));
  for (const [day, ids] of moves) trip.days[day] = ids;
  try {
    return run();
  } finally {
    for (const [day, ids] of original) trip.days[day] = ids;
  }
}

/** Day `donor`, as the trip now has it, given a meal: an unused place, or a third day's spare. */
function refillDay(
  share: Sharing,
  trip: TripDraft,
  donor: number,
  busy: readonly number[],
): Moves | null {
  const unused = (["lunch", "dinner"] as const).flatMap((meal) => share.unused(donor, meal));
  const refilled = seat(share, donor, unused);
  if (refilled) return new Map([[donor, refilled]]);
  for (const third of daysWith(share, trip, donor, 2)) {
    if (busy.includes(third)) continue;
    for (const place of mealStops(share, third)) {
      const fed = seat(share, donor, [place]);
      const left = fed && without(share, third, place, 1);
      if (fed && left)
        return new Map([
          [donor, fed],
          [third, left],
        ]);
    }
  }
  return null;
}
