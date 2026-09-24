import type { DayWalk } from "./dayBuilder";
import type { Arrangement } from "./planAnchors";
import { timeStep } from "./schedule";
import type { Place } from "./types";

// What the other days of a trip being walked (tripWalk.ts) could still do, so that one day's
// choice leaves another day what only it can use: a meal place for a day with no meal yet, a
// meal place that could serve fewer meals elsewhere, and a visit no later day can still hold.

/** A day with no meal yet keeps a claim on its last meal places while it has this many or fewer. */
const MEAL_RESERVE_MAX = 2;

/** The walk seen from day `index`: every day's walk and which days are finished. */
export interface WalkView {
  index: number;
  arrangement: Arrangement;
  walks: readonly DayWalk[];
  finished: ReadonlySet<number>;
}

/** The chance functions DayInput takes for day `index` (dayBuilder.ts). */
export function chancesElsewhere(view: WalkView) {
  return {
    mealChances: (place: Place) => mealsElsewhere(place, view),
    mealWanted: (place: Place) => wantedByMealless(place, view),
    visitChances: (place: Place) => visitsElsewhere(place, view),
  };
}

export function clockOf(walk: DayWalk): number {
  return walk.state.cursor.clock;
}

/** The other unfinished days of the same base as day `index`, with their day numbers. */
function otherDays(view: WalkView): { walk: DayWalk; day: number }[] {
  const { index, arrangement, walks, finished } = view;
  const days: { walk: DayWalk; day: number }[] = [];
  walks.forEach((walk, day) => {
    if (day === index || finished.has(day) || arrangement[day] !== arrangement[index]) return;
    days.push({ walk, day });
  });
  return days;
}

/**
 * True when another unfinished day of the base has no meal yet, could still seat one here, and
 * has at most MEAL_RESERVE_MAX places left where it could.
 */
function wantedByMealless(place: Place, view: WalkView): boolean {
  return otherDays(view).some(({ walk }) => {
    if (walk.state.fed || !canSeat(walk, place)) return false;
    const left = walk.input.pool.filter((other) => !walk.input.used.has(other.id));
    return left.filter((other) => canSeat(walk, other)).length <= MEAL_RESERVE_MAX;
  });
}

/** True when the walk could still seat a lunch or dinner at the place today. */
function canSeat(walk: DayWalk, place: Place): boolean {
  const latest = walk.limits.get(place.id);
  const clock = clockOf(walk);
  return [latest?.lunch, latest?.dinner].some((last) => last !== undefined && last >= clock);
}

/** How many lunches and dinners the place could still serve on the other unfinished days. */
function mealsElsewhere(place: Place, view: WalkView): number {
  let count = 0;
  for (const { walk } of otherDays(view)) {
    const latest = walk.limits.get(place.id);
    for (const meal of ["lunch", "dinner"] as const) {
      if (latest?.[meal] !== undefined && !walk.state.cursor.mealsTaken.includes(meal)) count++;
    }
  }
  return count;
}

/**
 * How many later days of the trip at the same base, still unfinished, could still start a visit
 * to the place: its chances after this day.
 */
// Decision: later days only. Counting every other day, day 2 and day 3 of a Rome trip each
// counted on the other for the Vatican Museums, both mornings went to sights open all week, and
// the Vatican was lost; the last day that can hold a place now takes it (dayPicks.ts, lastChance).
function visitsElsewhere(place: Place, view: WalkView): number {
  let count = 0;
  for (const { walk, day } of otherDays(view)) {
    if (day < view.index) continue;
    const latest = walk.limits.get(place.id)?.visit;
    const arrive = timeStep(place, walk.input.date, walk.state.cursor).arrive;
    if (latest !== undefined && arrive <= latest) count++;
  }
  return count;
}
