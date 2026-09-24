import { PACE, TRAVEL } from "./config";
import { coversMeal, servesMeal, withinBudget } from "./constraints";
import { twinIds } from "./context";
import type { DayInput } from "./dayBuilder";
import type { LatestStarts } from "./dayLimits";
import type { DayCursor, TimedStep } from "./schedule";
import { type LatLng, travelMinutes } from "./travel";
import type { Meal, Place, PlaceType } from "./types";

// The greedy walk's look-ahead: "if I take this stop now, can I still keep my promises for the
// rest of the day?" The promises are the meals that are reachable now and the must-include
// places that can still happen today. Each check is a feasibility test on latest start times,
// so it never guesses the order of the later stops.

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

/** Look-ahead checks for one step: `meals` for the pending meals, `all` adds must-includes. */
export interface Promises {
  meals: (option: Option) => boolean;
  all: (option: Option) => boolean;
}

/**
 * True when the place is already in the trip (on another day, or `today`), or shares a location
 * with a place that is. Links are symmetric even when only one side lists the other.
 */
// Decision: never two places at one spot in a trip, even when the traveler asked for both
// (Trevi Fountain by day and by night): the first one placed wins and the validator explains the
// other ("at the same spot as ..."). The brief asks for one of each pair, and the pools drop
// ordinary twins of a must-include up front so the must-include keeps its spot.
export function isBlocked(place: Place, input: DayInput, today: readonly Place[]): boolean {
  if (input.used.has(place.id)) return true;
  const twins = twinIds(input.ctx, place.id);
  for (const other of today) {
    if (other.id === place.id || twins.includes(other.id)) return true;
  }
  return twins.some((id) => input.used.has(id));
}

/**
 * `meals`: after the option, every meal reachable now is still reachable (with `laterMeals` false,
 * only the meals some option could seat next).
 * `all`: that, and the must-includes still possible today are no worse off. "No worse off" is
 * the shortfall of a slot matching (see slotShortfall), so an option is only refused when it
 * costs a must-include its place, never because two must-includes already compete. When the
 * option is itself a must-include, only must-includes with no more chances on other days than it
 * has count: a less flexible must-include may go first.
 */
// Decision: flexibility decides between must-includes. With Torre degli Asinelli (open all three
// days) as a promise, the Parma tour (Friday only) could not go first and started at 12:15
// instead of 11:15. Dropping flexible must-includes from every promise went too far: two days
// each left the Mercato Testaccio lunch to the other, and neither kept it.
export function keepsPromises(
  options: readonly Option[],
  input: DayInput,
  state: WalkState,
  limits: Limits,
  laterMeals = true,
): Promises {
  const taken = state.cursor.mealsTaken;
  const now: At = { ...state.cursor };
  // Decision: a meal is a promise as soon as any unused place can still seat it (`laterMeals`),
  // not only when it could be the very next stop. At 10:20 in Bologna, Via Drapperie was a visit
  // option (lunch was 95 minutes off), so lunch was no promise and a Ferrari Museum visit until
  // 14:05 took it. When no option keeps such a promise, the walk asks again without it (choose).
  const pendingMeals = (["lunch", "dinner"] as const).filter(
    (meal) =>
      !taken.includes(meal) &&
      (options.some((o) => o.step.role === meal) ||
        (laterMeals && mealReachable(meal, now, state.today, input, limits))),
  );
  // Every must-include of the base still unplaced, not only those that could come next: the
  // Mercato Testaccio lunch is no option at 10:20, but a museum until 12:50 would still lose it.
  const pending = input.pool.filter(
    (place) => input.obligations.has(place.id) && !isBlocked(place, input, state.today),
  );
  const chances = (place: Place) => input.otherChances(place.id);
  const visitsLeft = PACE[input.request.pace].maxVisits - state.visits;
  const shortfallNow = new Map<number, number>(); // by the most chances a promise may have
  const promisedFor = (option: Option): { places: Place[]; before: number } => {
    const most = option.obligation ? chances(option.place) : Number.POSITIVE_INFINITY;
    const places = pending.filter((place) => chances(place) <= most);
    let before = shortfallNow.get(most);
    if (before === undefined) {
      before = slotShortfall(places, now, taken, visitsLeft, limits);
      shortfallNow.set(most, before);
    }
    return { places, before };
  };
  const meals = (option: Option): boolean => {
    const todayAfter = [...state.today, option.place];
    const after = atEndOf(option);
    for (const meal of pendingMeals) {
      if (option.step.role === meal || coversOption(option, meal)) continue;
      if (!mealReachable(meal, after, todayAfter, input, limits)) return false;
    }
    return true;
  };
  const all = (option: Option): boolean => {
    if (!meals(option)) return false;
    const isVisit = option.step.role === "visit";
    const takenAfter = isVisit ? taken : [...taken, option.step.role as Meal];
    const { places, before } = promisedFor(option);
    const rest = places.filter((place) => place.id !== option.place.id);
    const left = visitsLeft - (isVisit ? 1 : 0);
    return slotShortfall(rest, atEndOf(option), takenAfter, left, limits) <= before;
  };
  return { meals, all };
}

/** True when the option is an outing under way through the meal window: it includes the meal. */
function coversOption(option: Option, meal: Meal): boolean {
  return coversMeal(option.place, option.step.start, option.step.end, meal);
}

/** A moment and a place in the day, for arrival estimates. */
interface At {
  clock: number;
  position: LatLng;
  first: boolean; // no stop yet, so no buffer
}

function atEndOf(option: Option): At {
  return { clock: option.step.end, position: option.place, first: false };
}

function arriveAt(at: At, place: Place): number {
  return at.clock + travelMinutes(at.position, place) + (at.first ? 0 : TRAVEL.bufferMin);
}

type Slot = "lunch" | "dinner" | "visit";

/** Every non-empty set of slot kinds, for Hall's condition. */
const SLOT_SETS: readonly (readonly Slot[])[] = [
  ["lunch"],
  ["dinner"],
  ["visit"],
  ["lunch", "dinner"],
  ["lunch", "visit"],
  ["dinner", "visit"],
  ["lunch", "dinner", "visit"],
];

/** The slot kinds a place can still take when reached from `at`. */
function slotsFor(place: Place, at: At, taken: readonly Meal[], limits: Limits): Slot[] {
  const latest = limits.get(place.id);
  if (!latest) return [];
  const arrive = arriveAt(at, place);
  const slots: Slot[] = [];
  for (const meal of ["lunch", "dinner"] as const) {
    const last = latest[meal];
    if (!taken.includes(meal) && last !== undefined && arrive <= last) slots.push(meal);
  }
  // Decision: a meal place is not a possible visit while a meal it serves is still open, because
  // inferRole would seat it as that meal. Counting it as a visit hid real conflicts (a cafe and a
  // restaurant, both must-include, competing for one dinner).
  const mealStillOpen = (["lunch", "dinner"] as const).some(
    (meal) => servesMeal(place, meal) && !taken.includes(meal),
  );
  if (!mealStillOpen && latest.visit !== undefined && arrive <= latest.visit) slots.push("visit");
  return slots;
}

/**
 * How many of the pending must-includes cannot get a slot today: those with no feasible slot,
 * plus the worst excess of demand over capacity across every set of slot kinds (Hall's
 * condition for a matching). Capacity is one lunch and one dinner unless taken, and the visits
 * left under the pace's cap.
 */
// Decision: a matching check instead of checking each must-include alone. Alone, a lunch-or-
// dinner restaurant looks safe after a long morning visit even when another must-include needs
// the only dinner slot; the matching sees that both now want dinner.
export function slotShortfall(
  pending: readonly Place[],
  at: At,
  taken: readonly Meal[],
  visitsLeft: number,
  limits: Limits,
): number {
  const capacity: Record<Slot, number> = {
    lunch: taken.includes("lunch") ? 0 : 1,
    dinner: taken.includes("dinner") ? 0 : 1,
    visit: Math.max(0, visitsLeft),
  };
  const slots = pending.map((place) => slotsFor(place, at, taken, limits));
  const lost = slots.filter((kinds) => kinds.length === 0).length;
  let worst = 0;
  for (const set of SLOT_SETS) {
    let demand = 0;
    for (const kinds of slots) {
      if (kinds.length > 0 && kinds.every((kind) => set.includes(kind))) demand++;
    }
    let supply = 0;
    for (const kind of set) supply += capacity[kind];
    worst = Math.max(worst, demand - supply);
  }
  return lost + worst;
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
  const budget = input.request.maxPriceLevel;
  const inBudget = (place: Place) => withinBudget(place, budget);
  return !mealReachable(meal, { ...state.cursor }, state.today, input, limits, inBudget);
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
    if (latest === undefined || arriveAt(at, place) > latest) continue;
    if (!isBlocked(place, input, todayAfter)) return true;
  }
  return false;
}
