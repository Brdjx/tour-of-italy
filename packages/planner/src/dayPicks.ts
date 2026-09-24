import { TRAVEL } from "./config";
import { coversMeal, withinBudget } from "./constraints";
import type { DayInput } from "./dayBuilder";
import type { LatestStarts } from "./dayLimits";
import { LAST_CHANCE_MARGIN, MAX_IDLE_MIN, OUTING_LATEST_START } from "./planPolicy";
import { isBlocked } from "./pools";
import type { DayCursor, TimedStep } from "./schedule";
import { compareScored } from "./score";
import { type LatLng, travelMinutes } from "./travel";
import type { Meal, Place, PlaceType } from "./types";

// The picks of the greedy walk (dayBuilder.ts), tried in order until one finds a stop:
//   1. pickObligationNow: a must-include that can start now;
//   2. pickDueMeal: the meal that is due now, a must-include meal place first, then the place
//      with the fewest meals it could still serve on the other days (leastFlexible);
//   3. pickVisitNow: the best visit that can start now and keeps the meal promise, or a nearly
//      as good morning sight that no later day can hold (lastChance);
//   4. pickSoonest: whatever can start soonest without breaking it.
// The one look-ahead is the meal promise (keepsMeals): "if I take this stop now, can I still
// reach a place for the meal that is on offer?". It is a feasibility test on latest start times
// (dayLimits.ts), so it never guesses the order of the later stops.

/** A place that could come next, timed from the current cursor. */
export interface Option {
  place: Place;
  step: TimedStep;
  score: number;
  obligation: boolean; // a must-include to place today if at all possible
}

/** Where the walk is and what it has taken today. The rest of the trip is in DayInput.used. */
export interface WalkState {
  cursor: DayCursor;
  visits: number;
  previousType: PlaceType | null;
  today: Place[]; // this day's places so far, in order
  fed: boolean; // the day has a lunch or dinner, as a stop or inside an outing (coversMeal)
}

export type Limits = ReadonlyMap<string, LatestStarts>;

/** The next stop, or null when nothing fits and the day is done. */
export function choose(
  options: Option[],
  input: DayInput,
  state: WalkState,
  limits: Limits,
): Option | null {
  const keeps = keepsMeals(options, input, state, limits);
  return (
    pickObligationNow(options, keeps) ??
    pickDueMeal(options, keeps, input) ??
    pickVisitNow(options, keeps, input, limits) ??
    pickSoonest(options, keeps)
  );
}

function isNow(option: Option): boolean {
  return option.step.start - option.step.arrive <= MAX_IDLE_MIN;
}

/** The best-scoring option, ties by place id; null for none. */
function best(options: readonly Option[]): Option | null {
  let top: Option | null = null;
  for (const option of options) if (top === null || compareScored(option, top) < 0) top = option;
  return top;
}

/** 1. A must-include that can start now, preferring one that keeps the meal promise. */
function pickObligationNow(options: Option[], keeps: (o: Option) => boolean): Option | null {
  const now = options.filter((o) => o.obligation && isNow(o));
  return best(now.filter(keeps)) ?? best(now);
}

/**
 * 2. The meal that is due: some place can seat it now. A must-include meal place may take it even
 * if it waits a little longer for its own opening; otherwise the least flexible meal place that
 * keeps the promise (leastFlexible).
 */
function pickDueMeal(
  options: Option[],
  keeps: (o: Option) => boolean,
  input: DayInput,
): Option | null {
  const due = options.find((o) => o.step.role !== "visit" && isNow(o))?.step.role;
  if (due === undefined) return null;
  const meals = options.filter((o) => o.step.role === due && (isNow(o) || o.obligation));
  const mustMeals = meals.filter((o) => o.obligation);
  return (
    best(mustMeals.filter(keeps)) ?? best(mustMeals) ?? leastFlexible(meals.filter(keeps), input)
  );
}

/**
 * The meal place with the fewest meals it could still serve on the trip's other days, then the
 * best score: a dinner-only place, or one closed on the other days, goes before one that could
 * also be another day's lunch.
 */
// Decision: meal places are the scarcest thing in most bases (Florence has four lunch places,
// Venice three). Taken best-first, a lunch place used for one day's dinner left another day with
// no lunch. Measured alone it is worth 1.2 points of days missing a meal, under the bar; without
// it the final planner misses a meal on 1.6 to 2.3 points more days, past 2 on one of three seeds
// (docs/planner.md).
function leastFlexible(meals: readonly Option[], input: DayInput): Option | null {
  const chances = (option: Option) => input.mealChances?.(option.place) ?? 0;
  let top: Option | null = null;
  for (const option of meals) {
    const order = top === null ? -1 : chances(option) - chances(top) || compareScored(option, top);
    if (order < 0) top = option;
  }
  return top;
}

/**
 * 3. The best visit that can start now and keeps the meal promise, unless it would cost a nearly
 * as good morning sight its last chance in the trip (lastChance).
 */
function pickVisitNow(
  options: Option[],
  keeps: (o: Option) => boolean,
  input: DayInput,
  limits: Limits,
): Option | null {
  const now = options.filter((o) => o.step.role === "visit" && isNow(o) && keeps(o));
  const top = best(now);
  return top === null ? null : (lastChance(now, top, input, limits) ?? top);
}

/**
 * The best of `visits` that the top pick would lose for good: a morning visit (latest start by
 * OUTING_LATEST_START) that cannot start after the top pick, that no later day can still hold
 * (DayInput.visitChances), and that scores within LAST_CHANCE_MARGIN of the top pick.
 */
// Decision: mornings only. A trip has three mornings for every sight that must start by noon,
// while a museum open until 18:30 still fits some afternoon; counting afternoon ones too made the
// Uffizi beat a matching Chianti day trip on the last day. Kept although no sweep average moves
// past the bar without it (0.07 iconic sights a trip): without it, no Rome trip starting on a
// Sunday had the Vatican Museums (scripts/sweepPlaces.ts, docs/planner.md).
function lastChance(visits: Option[], top: Option, input: DayInput, limits: Limits): Option | null {
  let pick: Option | null = null;
  for (const option of visits) {
    if (option === top || option.score < top.score - LAST_CHANCE_MARGIN) continue;
    const latest = limits.get(option.place.id)?.visit;
    if (latest === undefined || latest > OUTING_LATEST_START) continue; // not a morning visit
    const after = top.step.end + travelMinutes(top.place, option.place) + TRAVEL.bufferMin;
    if (after <= latest) continue; // still possible after the top pick
    if ((input.visitChances?.(option.place) ?? 1) > 0) continue; // a later day can take it
    if (pick === null || compareScored(option, pick) < 0) pick = option;
  }
  return pick;
}

/**
 * 4. Whatever can start soonest without breaking the meal promise (a must-include always
 * qualifies). When that is a meal, the must-include places for that meal compete for it.
 */
function pickSoonest(options: Option[], keeps: (o: Option) => boolean): Option | null {
  const later = options.filter((o) => o.obligation || keeps(o)).sort(compareSoonest);
  const next = later[0];
  if (!next || next.step.role === "visit") return next ?? null;
  const rivals = later.filter((o) => o.obligation && o.step.role === next.step.role);
  return best(rivals.filter(keeps)) ?? best(rivals) ?? next;
}

/** Earliest start first, then must-includes, then score, then id. */
function compareSoonest(a: Option, b: Option): number {
  return (
    a.step.start - b.step.start ||
    Number(b.obligation) - Number(a.obligation) ||
    compareScored(a, b)
  );
}

/**
 * The meal promise: true for an option after which every meal some option could seat next is
 * still reachable at an unused place (or the option is that meal, or an outing that covers it).
 */
// Decision: only the meals some option could seat next count, not every meal a place could still
// seat later today. The wider promise needed a second try without it whenever no option kept
// it (a Bologna Monday whose only lunch opens at noon), and the two together planned within 0.2
// points of this one on every sweep metric (docs/planner.md).
function keepsMeals(
  options: readonly Option[],
  input: DayInput,
  state: WalkState,
  limits: Limits,
): (option: Option) => boolean {
  const taken = state.cursor.mealsTaken;
  const pending = (["lunch", "dinner"] as const).filter(
    (meal) => !taken.includes(meal) && options.some((o) => o.step.role === meal),
  );
  return (option) => {
    const todayAfter = [...state.today, option.place];
    const after: At = { clock: option.step.end, position: option.place, first: false };
    for (const meal of pending) {
      if (option.step.role === meal) continue;
      if (coversMeal(option.place, option.step.start, option.step.end, meal)) continue;
      if (!mealReachable(meal, after, todayAfter, input, limits)) return false;
    }
    return true;
  };
}

/**
 * True when a meal place one level over the budget may take `meal` now: no meal place within
 * the budget could still seat it today (pools.ts, isMealFallback).
 */
export function overBudgetMealAllowed(
  meal: Meal,
  input: DayInput,
  state: WalkState,
  limits: Limits,
): boolean {
  const inBudget = (place: Place) => withinBudget(place, input.request.maxPriceLevel);
  return !mealReachable(meal, { ...state.cursor }, state.today, input, limits, inBudget);
}

/** A moment and a place in the day, for arrival estimates. */
interface At {
  clock: number;
  position: LatLng;
  first: boolean; // no stop yet, so no buffer
}

/** True when some unused meal place (that `accept` allows) can still seat `meal` after `at`. */
function mealReachable(
  meal: Meal,
  at: At,
  todayAfter: readonly Place[],
  input: DayInput,
  limits: Limits,
  accept: (place: Place) => boolean = () => true,
): boolean {
  for (const place of input.pool) {
    if (!accept(place)) continue;
    const latest = limits.get(place.id)?.[meal];
    const arrive = at.clock + travelMinutes(at.position, place) + (at.first ? 0 : TRAVEL.bufferMin);
    if (latest === undefined || arrive > latest) continue;
    if (!isBlocked(place, input, todayAfter)) return true;
  }
  return false;
}
