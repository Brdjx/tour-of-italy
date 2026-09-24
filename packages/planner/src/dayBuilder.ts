import { PACE } from "./config";
import { dayWindow } from "./constraints";
import type { PlannerContext } from "./context";
import { latestStartsFor, mayVisit } from "./dayLimits";
import { isBlocked, keepsPromises, type Limits, type Option, type WalkState } from "./dayLookahead";
import { MAX_IDLE_MIN } from "./planPolicy";
import { advanceCursor, startCursor, timeStep } from "./schedule";
import { compareScored, scorePlace } from "./score";
import type { Anchor, Place, TripRequest } from "./types";

// The greedy "walk the day" of planDeterministic. At each step it asks timeStep what every
// remaining place would look like next, keeps those that fit, and picks, in this order:
//   1. a must-include that can start now;
//   2. a meal that is due (can start now) and keeps the promises below;
//   3. the best visit that can start now and still leaves the pending meals and must-includes
//      reachable (dayLookahead.ts);
//   4. otherwise whatever can start soonest without breaking those promises.
// "Now" means within MAX_IDLE_MIN of arriving. Evening-only places land after dinner this way.

/** What one day may use. */
export interface DayInput {
  date: string;
  anchor: Anchor;
  transferMin: number;
  request: TripRequest;
  ctx: PlannerContext;
  pool: readonly Place[]; // places this day may use, already filtered (base, exclusions, budget)
  used: ReadonlySet<string>; // ids already in the trip on earlier days
  obligations: ReadonlySet<string>; // must-include ids to fit today if at all possible
  laterDays: ReadonlyMap<string, number>; // per obligation: later trip days that could hold it
  visitCap?: number; // cap on ordinary visits, below the pace's cap to spread a thin base
}

/** The day the greedy walk produced: ids in visiting order and the summed selection scores. */
export interface BuiltDay {
  ids: string[];
  score: number;
}

/** Builds one day greedily. Pure and deterministic: ties always break by place id. */
export function buildDay(input: DayInput): BuiltDay {
  const limits = latestStartsFor({
    ...input,
    pace: input.request.pace,
    mustInclude: input.request.mustInclude,
  });
  const state: WalkState = {
    cursor: startCursor(input.anchor, input.request.pace, input.transferMin),
    visits: 0,
    previousType: null,
    usedIds: new Set(input.used),
  };
  const ids: string[] = [];
  let score = 0;
  // Each round adds one unused pool place or stops, so the loop runs at most pool.length times.
  for (;;) {
    const pick = choose(collectOptions(input, state), input, state, limits);
    if (!pick) break;
    ids.push(pick.place.id);
    score += pick.score;
    state.cursor = advanceCursor(state.cursor, pick.place, pick.step);
    if (pick.step.role === "visit") state.visits++;
    state.previousType = pick.place.type;
    state.usedIds.add(pick.place.id);
  }
  return { ids, score: Math.round(score * 1e6) / 1e6 };
}

/** Every pool place that could come next: open for its whole visit and inside the day window. */
function collectOptions(input: DayInput, state: WalkState): Option[] {
  const window = dayWindow(input.request.pace, input.transferMin);
  const maxVisits = PACE[input.request.pace].maxVisits;
  // Decision: the spread cap limits ordinary visits only. Must-include places still get every
  // visit slot the pace allows, so spreading a thin base never costs the traveler a named place.
  const ordinaryCap = Math.min(maxVisits, input.visitCap ?? maxVisits);
  const situation = {
    date: input.date,
    from: state.cursor.position,
    previousType: state.previousType,
  };
  const options: Option[] = [];
  for (const place of input.pool) {
    if (isBlocked(place, state.usedIds, input)) continue;
    const step = timeStep(place, input.date, state.cursor);
    if (!step.fits || step.end > window.end) continue;
    if (step.role === "visit" && !mayVisit(place, input.request.mustInclude)) continue;
    const obligation = input.obligations.has(place.id);
    const cap = obligation ? maxVisits : ordinaryCap;
    if (step.role === "visit" && state.visits >= cap) continue;
    const score = scorePlace(place, input.request, situation);
    options.push({ place, step, score, obligation });
  }
  return options;
}

function isNow(option: Option): boolean {
  return option.step.start - option.step.arrive <= MAX_IDLE_MIN;
}

function best(options: readonly Option[]): Option | null {
  let top: Option | null = null;
  for (const option of options) if (top === null || compareScored(option, top) < 0) top = option;
  return top;
}

/** Earliest start first, then must-includes, then score, then id. */
function compareSoonest(a: Option, b: Option): number {
  return (
    a.step.start - b.step.start ||
    Number(b.obligation) - Number(a.obligation) ||
    compareScored(a, b)
  );
}

/** The next stop, or null when nothing fits. The order is described at the top of the file. */
function choose(options: Option[], input: DayInput, state: WalkState, limits: Limits) {
  const keeps = keepsPromises(options, input, state, limits);
  const urgent = (candidates: Option[]) => mostUrgent(candidates, input, state, limits);
  // A must-include that can start now goes first, preferring one that costs no other promise.
  const obligationsNow = options.filter((o) => o.obligation && isNow(o));
  const obligationNow = urgent(obligationsNow.filter(keeps.all)) ?? urgent(obligationsNow);
  if (obligationNow) return obligationNow;
  // A meal is due when some place can seat it now; a must-include meal place may then be chosen
  // even if it means waiting a little longer for its own opening.
  const due = options.find((o) => o.step.role !== "visit" && isNow(o))?.step.role;
  const meals = options.filter((o) => o.step.role === due && (isNow(o) || o.obligation));
  // When every must-include meal costs another promise (two must-include dinners, one slot),
  // the least flexible one still takes the meal; the other keeps its later chances.
  const mustMeals = meals.filter((o) => o.obligation);
  const mealDue =
    urgent(mustMeals.filter(keeps.all)) ?? urgent(mustMeals) ?? best(meals.filter(keeps.all));
  if (mealDue) return mealDue;
  const visitNow = best(options.filter((o) => o.step.role === "visit" && isNow(o) && keeps.all(o)));
  if (visitNow) return visitNow;
  const later = options.filter((o) => o.obligation || keeps.all(o)).sort(compareSoonest);
  const next = later[0];
  if (!next || next.step.role === "visit") return next ?? null;
  // The next thing is a meal: the must-include places for that meal compete by urgency.
  const rivals = later.filter((o) => o.obligation && o.step.role === next.step.role);
  return urgent(rivals.filter(keeps.all)) ?? urgent(rivals) ?? next;
}

/**
 * The must-include with the fewest other chances, then the best score. Chances are later trip
 * days that could hold it, plus one for a lunch place that could still be tonight's dinner.
 */
// Decision: least flexible first. With two must-include restaurants and one lunch slot, the
// lunch-only one takes lunch and the other waits for dinner, instead of whichever scores higher
// taking lunch and the other being lost.
function mostUrgent(
  candidates: Option[],
  input: DayInput,
  state: WalkState,
  limits: Limits,
): Option | null {
  const chances = (option: Option): number => {
    const later = input.laterDays.get(option.place.id) ?? 0;
    const dinnerLater =
      option.step.role === "lunch" &&
      !state.cursor.mealsTaken.includes("dinner") &&
      limits.get(option.place.id)?.dinner !== undefined;
    return later + (dinnerLater ? 1 : 0);
  };
  let top: Option | null = null;
  for (const option of candidates) {
    if (top === null) {
      top = option;
      continue;
    }
    const order = chances(option) - chances(top) || compareScored(option, top);
    if (order < 0) top = option;
  }
  return top;
}
