import { PACE, TRAVEL } from "./config";
import { sharesLocation } from "./constraints";
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

/** Where the walk is and what it has used. */
export interface WalkState {
  cursor: DayCursor;
  visits: number;
  previousType: PlaceType | null;
  usedIds: Set<string>;
}

export type Limits = ReadonlyMap<string, LatestStarts>;

/** Look-ahead checks for one step: `meals` for the pending meals, `all` adds must-includes. */
export interface Promises {
  meals: (option: Option) => boolean;
  all: (option: Option) => boolean;
}

/**
 * True when the place is used, or shares a location with a used place. Links are symmetric
 * even when only one side lists the other.
 */
// Decision: two must-include places may share a spot (Trevi Fountain by day and by night both
// asked for): the traveler named both, so both are planned and SAME_LOCATION warns. Every other
// pair is blocked, and tripBuilder drops non-must-include twins of a must-include up front.
export function isBlocked(place: Place, usedIds: ReadonlySet<string>, input: DayInput): boolean {
  if (usedIds.has(place.id)) return true;
  const must = input.request.mustInclude;
  for (const id of usedIds) {
    if (must.includes(id) && must.includes(place.id)) continue;
    const used = input.ctx.placesById.get(id);
    if (used && sharesLocation(used, place)) return true;
  }
  return false;
}

/**
 * `meals`: after the option, every meal reachable now is still reachable.
 * `all`: that, and the must-includes still possible today are no worse off. "No worse off" is
 * the shortfall of a slot matching (see slotShortfall), so an option is only refused when it
 * costs a must-include its place, never because two must-includes already compete.
 */
export function keepsPromises(
  options: readonly Option[],
  input: DayInput,
  state: WalkState,
  limits: Limits,
): Promises {
  const taken = state.cursor.mealsTaken;
  const pendingMeals = (["lunch", "dinner"] as const).filter(
    (meal) => !taken.includes(meal) && options.some((o) => o.step.role === meal),
  );
  const pending = options.filter((o) => o.obligation).map((o) => o.place);
  const visitsLeft = PACE[input.request.pace].maxVisits - state.visits;
  const now: At = { ...state.cursor };
  const before = slotShortfall(pending, now, taken, visitsLeft, limits);
  const meals = (option: Option): boolean => {
    const usedAfter = new Set(state.usedIds).add(option.place.id);
    const after = atEndOf(option);
    for (const meal of pendingMeals) {
      if (option.step.role === meal) continue;
      if (!mealReachable(meal, after, usedAfter, input, limits)) return false;
    }
    return true;
  };
  const all = (option: Option): boolean => {
    if (!meals(option)) return false;
    const isVisit = option.step.role === "visit";
    const takenAfter = isVisit ? taken : [...taken, option.step.role as Meal];
    const rest = pending.filter((place) => place.id !== option.place.id);
    const left = visitsLeft - (isVisit ? 1 : 0);
    return slotShortfall(rest, atEndOf(option), takenAfter, left, limits) <= before;
  };
  return { meals, all };
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
  const mealStillOpen = place.meals.some((meal) => !taken.includes(meal));
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

/** True when some unused meal place can still seat `meal` after `at`. */
function mealReachable(
  meal: Meal,
  at: At,
  usedAfter: ReadonlySet<string>,
  input: DayInput,
  limits: Limits,
): boolean {
  for (const place of input.pool) {
    const latest = limits.get(place.id)?.[meal];
    if (latest === undefined || arriveAt(at, place) > latest) continue;
    if (!isBlocked(place, usedAfter, input)) return true;
  }
  return false;
}
