import { dayOrigin } from "./anchors";
import { PACE } from "./config";
import { coversMeal, withinBudget } from "./constraints";
import type { PlannerContext } from "./context";
import { latestStartsFor } from "./dayLimits";
import {
  choose,
  type Limits,
  type Option,
  overBudgetMealAllowed,
  type WalkState,
} from "./dayPicks";
import { keepsDayRules } from "./dayRules";
import { isBlocked } from "./pools";
import { advanceCursor, startCursor, timeStep } from "./schedule";
import { scorePlace } from "./score";
import type { Anchor, Place, TripRequest } from "./types";

// The greedy "walk the day" of planDeterministic. At each step it times every unused pool place
// as the next stop (timeStep), keeps the options that fit the hard rules, the trip back to the
// base, and the day rules (dayRules.ts), and takes the first pick of (dayPicks.ts):
//   1. a must-include that can start now;
//   2. the meal that is due now, a must-include meal place first, then the least flexible one;
//   3. the best visit that can start now and keeps the meal promise, unless it would cost a
//      nearly as good morning sight its last chance in the trip;
//   4. whatever can start soonest without breaking the meal promise.
// "Now" means within MAX_IDLE_MIN of arriving. The promise is that a meal some place could seat
// next is still reachable after this stop (dayPicks.ts, keepsMeals). Evening-only places land in
// the evening, after dinner or, when a later dinner still fits, just before it.
// A walk moves one stop at a time (stepWalk), so the trip builder can take turns between days.

/** What one day may use. */
export interface DayInput {
  date: string;
  anchor: Anchor;
  transferMin: number;
  request: TripRequest;
  ctx: PlannerContext;
  pool: readonly Place[]; // places this day may use, already filtered (base, exclusions, budget)
  used: ReadonlySet<string>; // ids in the trip on other days; the trip builder keeps it current
  obligations: ReadonlySet<string>; // must-include ids to fit today if at all possible
  mealWanted?: (place: Place) => boolean; // another day with no meal yet could still eat here
  mealChances?: (place: Place) => number; // meals the place could still serve on other days
  visitChances?: (place: Place) => number; // later days of the trip that could still start it
}

/** The day the greedy walk produced: ids in visiting order and the summed selection scores. */
export interface BuiltDay {
  ids: string[];
  score: number;
}

/** A day being walked: its input, where it is, and what it has taken so far. */
export interface DayWalk extends BuiltDay {
  input: DayInput;
  state: WalkState;
  limits: Limits;
}

/** A walk at the start of its day: at the day's start point, after any transfer. */
export function startWalk(input: DayInput): DayWalk {
  const { request, anchor, transferMin } = input;
  const origin = dayOrigin(anchor, request);
  const limits = latestStartsFor({
    date: input.date,
    pace: request.pace,
    transferMin,
    origin,
    pool: input.pool,
    mustInclude: request.mustInclude,
  });
  const state: WalkState = {
    cursor: startCursor(anchor, request.pace, transferMin, origin),
    visits: 0,
    previousType: null,
    today: [],
    fed: false,
  };
  return { input, state, limits, ids: [], score: 0 };
}

/** Takes the walk's next stop and returns it, or null when nothing fits (the day is done). */
export function stepWalk(walk: DayWalk): Option | null {
  const { input, state, limits } = walk;
  const pick = choose(collectOptions(input, state, limits), input, state, limits);
  if (!pick) return null;
  walk.ids.push(pick.place.id);
  walk.score = Math.round((walk.score + pick.score) * 1e6) / 1e6;
  state.cursor = advanceCursor(state.cursor, pick.place, pick.step);
  if (pick.step.role === "visit") state.visits++;
  state.previousType = pick.place.type;
  state.today.push(pick.place);
  state.fed ||= pick.step.role !== "visit" || coversAMeal(pick);
  return pick;
}

/** Builds one day greedily on its own. Pure and deterministic: ties always break by place id. */
export function buildDay(input: DayInput): BuiltDay {
  const walk = startWalk(input);
  // Each step adds one unused pool place or stops, so the loop runs at most pool.length times.
  while (stepWalk(walk));
  return { ids: walk.ids, score: walk.score };
}

/**
 * Every pool place that could come next: open for its whole visit, starting no later than its
 * latest start for that role (which leaves time to get back to the base), under the pace's visit
 * cap, keeping the day rules, and, for an ordinary meal, not one of the last meal places another
 * day with no meal yet needs (savedForAnotherDay).
 */
function collectOptions(input: DayInput, state: WalkState, limits: Limits): Option[] {
  const situation = {
    date: input.date,
    from: state.cursor.position,
    previousType: state.previousType,
  };
  const daySoFar = {
    clock: state.cursor.clock,
    mealsTaken: state.cursor.mealsTaken,
    today: state.today,
    anchor: input.anchor,
  };
  const maxVisits = PACE[input.request.pace].maxVisits;
  const options: Option[] = [];
  for (const place of input.pool) {
    if (isBlocked(place, input, state.today)) continue;
    const step = timeStep(place, input.date, state.cursor);
    const latest = limits.get(place.id);
    const lastStart = latest?.[step.role];
    if (!step.fits || lastStart === undefined || step.start > lastStart) continue;
    const obligation = input.obligations.has(place.id);
    if (step.role === "visit" && state.visits >= maxVisits) continue;
    if (step.role !== "visit" && !obligation) {
      const overBudget = !withinBudget(place, input.request.maxPriceLevel);
      if (overBudget && !overBudgetMealAllowed(step.role, input, state, limits)) continue;
      if (savedForAnotherDay(input, state, place)) continue;
    }
    const { role, arrive, start, travelMin } = step;
    const next = { place, role, arrive, start, travelMin, obligation, latest };
    if (!keepsDayRules(next, daySoFar)) continue;
    const score = scorePlace(place, input.request, situation);
    options.push({ place, step, score, obligation });
  }
  return options;
}

/** A second meal here would take one of the last places another day with no meal yet needs. */
function savedForAnotherDay(input: DayInput, state: WalkState, place: Place): boolean {
  return state.fed && (input.mealWanted?.(place) ?? false);
}

function coversAMeal(option: Option): boolean {
  const { place, step } = option;
  return (["lunch", "dinner"] as const).some((meal) =>
    coversMeal(place, step.start, step.end, meal),
  );
}
