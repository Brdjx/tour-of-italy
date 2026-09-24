import { dayOrigin } from "./anchors";
import { PACE } from "./config";
import { coversMeal, withinBudget } from "./constraints";
import type { PlannerContext } from "./context";
import { latestStartsFor } from "./dayLimits";
import {
  isBlocked,
  type Limits,
  type Option,
  overBudgetMealAllowed,
  type WalkState,
} from "./dayLookahead";
import { choose } from "./dayPicks";
import { keepsDayRules } from "./dayRules";
import { advanceCursor, startCursor, timeStep } from "./schedule";
import { scorePlace } from "./score";
import type { Anchor, Place, TripRequest } from "./types";

// The greedy "walk the day" of planDeterministic. At each step it times every unused pool place
// as the next stop (timeStep), keeps the options that fit the hard rules, the trip back to the
// base, and the day rules (dayRules.ts), and takes the first pick of:
//   1. pickObligationNow: a must-include that can start now, the least flexible first;
//   2. pickDueMeal: the meal that is due now, a must-include meal place first;
//   3. pickVisitNow: the best visit that can start now and keeps every promise;
//   4. pickSoonest: whatever can start soonest without breaking a promise;
//   5. pickFirstStop: on a day still empty, whatever can start soonest.
// "Now" means within MAX_IDLE_MIN of arriving. The promises are the meals still reachable and the
// must-includes still possible today (dayLookahead.ts). Evening-only places land in the evening,
// after dinner or, when a later dinner still fits, just before it.
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
  otherChances: (placeId: string) => number; // other days that could still hold a must-include
  mealChances?: (place: Place) => number; // meals the place could serve on other unfinished days
  mealWanted?: (place: Place) => boolean; // another day with no meal yet could still eat here
  visitChances?: (place: Place) => number; // later unfinished days that could still visit it
  visitCap?: number; // cap on visits below the pace's cap
  mealVisits?: boolean; // a rescued day: a meal place may be a visit (tripWalk.ts)
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
  heldBack: boolean; // the last step found nothing, but a meal place held for another day fit
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
    mealVisits: input.mealVisits ?? false,
  });
  const state: WalkState = {
    cursor: startCursor(anchor, request.pace, transferMin, origin),
    visits: 0,
    previousType: null,
    today: [],
    fed: false,
  };
  return { input, state, limits, ids: [], score: 0, heldBack: false };
}

/** Takes the walk's next stop and returns it, or null when nothing fits (the day is done). */
export function stepWalk(walk: DayWalk): Option | null {
  const { input, state, limits } = walk;
  const { options, heldBack } = collectOptions(input, state, limits);
  const pick = choose(options, input, state, limits);
  walk.heldBack = pick === null && heldBack;
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
 * latest start for that role (which leaves time to get back to the base), under the visit cap,
 * and keeping the day rules. `heldBack` is true when a meal place fit but was left to another day
 * with no meal yet (savedForAnotherDay), so the day may get another turn once that day eats.
 */
function collectOptions(
  input: DayInput,
  state: WalkState,
  limits: Limits,
): { options: Option[]; heldBack: boolean } {
  const situation = {
    date: input.date,
    from: state.cursor.position,
    previousType: state.previousType,
  };
  const daySoFar = {
    mealVisits: input.mealVisits ?? false,
    clock: state.cursor.clock,
    mealsTaken: state.cursor.mealsTaken,
    today: state.today,
    anchor: input.anchor,
  };
  const options: Option[] = [];
  let heldBack = false;
  for (const place of input.pool) {
    if (isBlocked(place, input, state.today)) continue;
    const step = timeStep(place, input.date, state.cursor);
    const latest = limits.get(place.id);
    const lastStart = latest?.[step.role];
    if (!step.fits || lastStart === undefined || step.start > lastStart) continue;
    const obligation = input.obligations.has(place.id);
    if (step.role === "visit" && state.visits >= visitCapFor(input, place.id, obligation)) continue;
    if (step.role !== "visit" && !obligation) {
      const overBudget = !withinBudget(place, input.request.maxPriceLevel);
      if (overBudget && !overBudgetMealAllowed(step.role, input, state, limits)) continue;
      if (savedForAnotherDay(input, state, place)) {
        heldBack = true;
        continue;
      }
    }
    const { role, arrive, start, travelMin } = step;
    const next = { place, role, arrive, start, travelMin, obligation, latest };
    if (!keepsDayRules(next, daySoFar)) continue;
    const score = scorePlace(place, input.request, situation);
    options.push({ place, step, score, obligation });
  }
  return { options, heldBack };
}

/**
 * The visit cap for one place: the day's cap, except that a must-include on its last chance (no
 * other day could hold it) may use every visit slot the pace allows.
 */
// Decision: a must-include with other chances obeys the cap like any other visit. When it did
// not, four must-includes of one base all landed on day 1 and the base ran dry, so the plan left
// the base the traveler chose for the other two days.
/** A second meal here would take one of the last places another day with no meal yet needs. */
// Decision: where meal places are scarce (Bologna and Milan have three or four for six meals), a
// day already fed leaves the last ones to a day that has none, so no day ends with two meals
// while another has nothing. A meal place over the budget is held the same way: at budget 1 in
// Florence, day 1 took two of them while day 3 ended at 12:50 with no meal.
function savedForAnotherDay(input: DayInput, state: WalkState, place: Place): boolean {
  return state.fed && (input.mealWanted?.(place) ?? false);
}

function coversAMeal(option: Option): boolean {
  const { place, step } = option;
  return (["lunch", "dinner"] as const).some((meal) =>
    coversMeal(place, step.start, step.end, meal),
  );
}

function visitCapFor(input: DayInput, placeId: string, obligation: boolean): number {
  const maxVisits = PACE[input.request.pace].maxVisits;
  if (obligation && input.otherChances(placeId) === 0) return maxVisits;
  return Math.min(maxVisits, input.visitCap ?? maxVisits);
}
