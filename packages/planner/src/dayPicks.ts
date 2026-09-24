import { TRAVEL } from "./config";
import type { DayInput } from "./dayBuilder";
import {
  keepsPromises,
  type Limits,
  type Option,
  type Promises,
  type WalkState,
} from "./dayLookahead";
import { LAST_CHANCE_MARGIN, MAX_IDLE_MIN, OUTING_LATEST_START } from "./planPolicy";
import { compareScored } from "./score";
import { travelMinutes } from "./travel";

// The picks of the greedy walk (dayBuilder.ts), tried in order until one finds a stop: a
// must-include that can start now, the meal that is due, the best visit that can start now, and
// whatever can start soonest, each keeping the day's promises (dayLookahead.ts); and, on a day
// still empty, whatever can start soonest.

/** What every pick step sees: the promise checks and the urgency orders. */
interface Picker {
  keeps: Promises;
  urgent: (candidates: Option[]) => Option | null; // must-includes, fewest other chances first
  leastFlexible: (meals: Option[]) => Option | null; // meals, fewest meals elsewhere first
  lastChance: (visits: Option[], top: Option) => Option | null; // a visit the top pick would lose
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

/**
 * The next stop, or null when nothing fits: the first of the picks that finds one, keeping every
 * meal a place can still seat today as a promise; failing that, only the meals some option could
 * seat next.
 */
// Decision: a second try, not a stop. On a Bologna Monday the only lunch, Via Drapperie at
// 12:00, was a promise at 10:20 but no option (the traveler cannot wait 95 minutes for it), and
// every sight left would lose it, so the day ended at 10:20; the Ferrari Museum is better.
export function choose(
  options: Option[],
  input: DayInput,
  state: WalkState,
  limits: Limits,
): Option | null {
  const tryWith = (laterMeals: boolean): Option | null => {
    const picker: Picker = {
      keeps: keepsPromises(options, input, state, limits, laterMeals),
      urgent: (candidates) => mostUrgent(candidates, input, state, limits),
      leastFlexible: (meals) => leastFlexible(meals, input),
      lastChance: (visits, top) => lastChance(visits, top, input, limits),
    };
    return (
      pickObligationNow(options, picker) ??
      pickDueMeal(options, picker) ??
      pickVisitNow(options, picker) ??
      pickSoonest(options, picker) ??
      pickFirstStop(options, state)
    );
  };
  return tryWith(true) ?? tryWith(false);
}

/**
 * 5. On a day with no stop yet, whatever can start soonest, even if it costs a promise.
 */
// Decision: a day with one stop and no lunch beats an empty day. The promises assume this day
// will get the meal; when a thin base's only lunch place will go to another day anyway, keeping
// the promise left the day empty and the plan moved to a base the traveler did not choose.
function pickFirstStop(options: Option[], state: WalkState): Option | null {
  if (state.today.length > 0) return null;
  return [...options].sort(compareSoonest)[0] ?? null;
}

/** 1. A must-include that can start now, preferring one that costs no other promise. */
function pickObligationNow(options: Option[], picker: Picker): Option | null {
  const now = options.filter((o) => o.obligation && isNow(o));
  return picker.urgent(now.filter(picker.keeps.all)) ?? picker.urgent(now);
}

/**
 * 2. The meal that is due: some place can seat it now. A must-include meal place may take it even
 * if it waits a little longer for its own opening. Must-include meal places compete by urgency
 * (two must-include dinners, one slot: the least flexible takes it and the other keeps its later
 * chances); otherwise the least flexible meal that keeps every promise, then the best.
 */
function pickDueMeal(options: Option[], picker: Picker): Option | null {
  const due = options.find((o) => o.step.role !== "visit" && isNow(o))?.step.role;
  if (due === undefined) return null;
  const meals = options.filter((o) => o.step.role === due && (isNow(o) || o.obligation));
  const mustMeals = meals.filter((o) => o.obligation);
  return (
    picker.urgent(mustMeals.filter(picker.keeps.all)) ??
    picker.urgent(mustMeals) ??
    picker.leastFlexible(meals.filter(picker.keeps.all))
  );
}

/**
 * 3. The best visit that can start now and keeps every promise, unless it would cost a nearly as
 * good visit its last chance in the trip (lastChance).
 */
function pickVisitNow(options: Option[], picker: Picker): Option | null {
  const now = options.filter((o) => o.step.role === "visit" && isNow(o) && picker.keeps.all(o));
  const top = best(now);
  return top === null ? null : (picker.lastChance(now, top) ?? top);
}

/**
 * The best visit among `visits` that the top pick would lose for good: a morning visit (its
 * latest start today is by OUTING_LATEST_START) that the traveler could no longer start after the
 * top pick, that no later day of the trip can still hold (DayInput.visitChances), and that scores
 * within LAST_CHANCE_MARGIN of the top pick.
 */
// Decision: mornings only. A trip has three mornings for every sight that must start by noon (the
// outings), while a museum open until 18:30 still fits some afternoon; on the last day, counting
// the afternoon ones too made the Uffizi beat a matching Chianti day trip.
function lastChance(
  visits: readonly Option[],
  top: Option,
  input: DayInput,
  limits: Limits,
): Option | null {
  let pick: Option | null = null;
  for (const option of visits) {
    if (option === top || option.score < top.score - LAST_CHANCE_MARGIN) continue;
    const latest = limits.get(option.place.id)?.visit;
    if (latest === undefined || latest > OUTING_LATEST_START) continue; // not a morning visit
    const after = top.step.end + travelMinutes(top.place, option.place) + TRAVEL.bufferMin;
    if (after <= latest) continue; // still possible after the top pick
    if ((input.visitChances?.(option.place) ?? 1) > 0) continue; // another day can take it
    if (pick === null || compareScored(option, pick) < 0) pick = option;
  }
  return pick;
}

/**
 * 4. Whatever can start soonest without breaking a promise (a must-include always qualifies).
 * When that is a meal, the must-include places for that meal compete for it by urgency.
 */
function pickSoonest(options: Option[], picker: Picker): Option | null {
  const later = options.filter((o) => o.obligation || picker.keeps.all(o)).sort(compareSoonest);
  const next = later[0];
  if (!next || next.step.role === "visit") return next ?? null;
  const rivals = later.filter((o) => o.obligation && o.step.role === next.step.role);
  return picker.urgent(rivals.filter(picker.keeps.all)) ?? picker.urgent(rivals) ?? next;
}

/**
 * The meal place with the fewest meals it could serve on the trip's other days, then the best
 * score. A dinner-only place (or one closed on the other days) goes before one that could also be
 * another day's lunch.
 */
// Decision: meal places are the scarcest thing in most bases (Florence has four lunch places,
// Venice three). Taken best-first, a lunch place used for day 2's dinner left day 1 or day 3 with
// no lunch at all; the difference in rating between two restaurants is small by comparison.
function leastFlexible(meals: Option[], input: DayInput): Option | null {
  const chances = (option: Option) => input.mealChances?.(option.place) ?? 0;
  let top: Option | null = null;
  for (const option of meals) {
    const order = top === null ? -1 : chances(option) - chances(top) || compareScored(option, top);
    if (order < 0) top = option;
  }
  return top;
}

/**
 * The must-include with the fewest other chances, then the best score. Chances are other trip
 * days that could still hold it, plus one for a lunch place that could still be tonight's dinner.
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
    const later = input.otherChances(option.place.id);
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
