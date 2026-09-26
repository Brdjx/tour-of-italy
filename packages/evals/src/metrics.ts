import { parseSelectionText } from "@italy/api/llm/schema";
import type { Shortlist } from "@italy/api/plan/candidates";
import {
  type Itinerary,
  ItinerarySchema,
  mealGaps,
  PACE,
  type PlannerContext,
  type PlanSource,
  scheduleTrip,
  validateItinerary,
  validationErrors,
} from "@italy/planner";
import type { CheckResult } from "./expectations";
import type { CallRecord } from "./recording";

// The eval metrics (one plan at a time, then summed up per model). Every function here is pure and
// takes plain values, so the math is tested on hand-built inputs (test/metrics.test.ts).

/** What a plan looks like, whoever chose its places. */
export interface PlanShape {
  finalValid: boolean; // zero validator errors and a valid response shape
  preferenceMatch: number | null; // share of visits with a requested interest; null without interests
  visitsPerDay: number; // non-meal stops per day
  paceCap: number; // the pace's most visits per day
  travelMinPerDay: number; // legs between stops plus the way back to the base, per day
  transferMinPerTrip: number; // time moving between bases, whole trip
  anchors: number; // distinct bases
  days: number;
  daysMissingMeal: number; // days with no lunch or no dinner, as the validator's MEAL_MISSING says
  daysNoneOpen: number; // of those, days where no place could take any meal they lack (mealGaps)
}

export interface MustIncludeCount {
  placed: number;
  placeable: number;
}

/** One plan, measured. */
export interface PlanMeasure {
  caseId: string;
  run: number;
  source: PlanSource | "error"; // "error" when the pipeline threw (never expected)
  fallbackReason: string | null; // why the rules-only plan was used; null when it was not a fallback
  answered: boolean; // the model returned at least one answer
  firstPassValid: boolean; // the first answer became the plan as written: nothing tidied or added, no repair
  repairTried: boolean; // the pipeline asked for a repair
  calls: number; // model calls, retries included
  shape: PlanShape | null; // null when the pipeline threw
  mustInclude: MustIncludeCount | null; // in the model's first answer (the plan, for the baseline)
  latencyMs: number | null; // null when not measured (simulated answers, the baseline)
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  stale: boolean; // replayed against a candidate list that has changed since recording
  checks: CheckResult[];
  mealsAdded: number; // lunches and dinners code added to the model's answer (mealAdd.ts)
  daysMissingMealBefore: number | null; // days missing a meal before those were added; null: no plan
}

/** No validator errors and the response schema holds: the only way a plan may reach a traveler. */
export function isFinalValid(itinerary: Itinerary, ctx: PlannerContext): boolean {
  return (
    validationErrors(itinerary, ctx).length === 0 && ItinerarySchema.safeParse(itinerary).success
  );
}

/** Share of non-meal stops with at least one of the requested interests among their tags. */
export function preferenceMatch(itinerary: Itinerary, ctx: PlannerContext): number | null {
  const interests = new Set(itinerary.request.interests);
  if (interests.size === 0) return null;
  let visits = 0;
  let matched = 0;
  for (const day of itinerary.days) {
    for (const stop of day.stops) {
      if (stop.role !== "visit") continue;
      visits++;
      const tags = ctx.placesById.get(stop.placeId)?.tags ?? [];
      if (tags.some((tag) => interests.has(tag))) matched++;
    }
  }
  return visits === 0 ? null : matched / visits;
}

/**
 * Days with no lunch or no dinner stop. An outing under way through a meal's whole window counts
 * as that meal, as it does for the traveler.
 */
// Decision: counted from the validator's MEAL_MISSING warnings on the plan as it stands, not from
// the warnings the plan carries, so the number cannot depend on what a pipeline chose to report.
export function daysMissingMeal(itinerary: Itinerary, ctx: PlannerContext): number {
  const days = new Set<number>();
  for (const violation of validateItinerary(itinerary, ctx)) {
    if (violation.code === "MEAL_MISSING" && violation.day !== undefined) days.add(violation.day);
  }
  return days.size;
}

/**
 * Days missing a meal where no place could take any meal they lack: every one of their missing
 * meals is "none open" (mealGaps, packages/planner/src/mealSupply.ts). The rest of the days
 * missing a meal are "not planned": a place could have taken it.
 */
export function daysNoneOpen(itinerary: Itinerary, ctx: PlannerContext): number {
  const noneOpen = new Map<number, boolean>();
  for (const gap of mealGaps(itinerary, ctx)) {
    noneOpen.set(gap.day, (noneOpen.get(gap.day) ?? true) && gap.cause === "none_open");
  }
  return [...noneOpen.values()].filter(Boolean).length;
}

/**
 * Days missing a meal in the plan as it was before code added the meals `added` names (the trace's
 * meal_added changes): the same days with those places taken out and timed again.
 */
export function daysMissingMealBefore(
  itinerary: Itinerary,
  added: readonly { day: number; placeId?: string | undefined }[],
  ctx: PlannerContext,
): number {
  if (added.length === 0) return daysMissingMeal(itinerary, ctx);
  const out = new Set(added.map((change) => `${change.day}|${change.placeId}`));
  const days = itinerary.days.map((day, index) => ({
    anchorId: day.anchorId,
    placeIds: day.stops.map((stop) => stop.placeId).filter((id) => !out.has(`${index}|${id}`)),
  }));
  const before = { ...itinerary, days: scheduleTrip(itinerary.request, days, ctx).days };
  return daysMissingMeal(before, ctx);
}

export function planShape(itinerary: Itinerary, ctx: PlannerContext): PlanShape {
  const days = itinerary.days.length || 1;
  let visits = 0;
  let travel = 0;
  let transfer = 0;
  for (const day of itinerary.days) {
    transfer += day.transferMin;
    travel += day.returnTravelMin ?? 0;
    for (const stop of day.stops) {
      travel += stop.travelFromPrevMin;
      if (stop.role === "visit") visits++;
    }
  }
  return {
    finalValid: isFinalValid(itinerary, ctx),
    preferenceMatch: preferenceMatch(itinerary, ctx),
    visitsPerDay: visits / days,
    paceCap: PACE[itinerary.request.pace].maxVisits,
    // Decision: moving between bases is reported apart from travel within a day. Otherwise a
    // two-city plan would look like a badly ordered one-city plan.
    travelMinPerDay: travel / days,
    transferMinPerTrip: transfer,
    anchors: new Set(itinerary.days.map((day) => day.anchorId)).size,
    days: itinerary.days.length,
    daysMissingMeal: daysMissingMeal(itinerary, ctx),
    daysNoneOpen: daysNoneOpen(itinerary, ctx),
  };
}

/** The placeable must-includes (those the shortlist offers) found in a list of place ids. */
function countMustInclude(ids: Iterable<string>, shortlist: Shortlist): MustIncludeCount {
  const present = new Set(ids);
  const placed = shortlist.mustInclude.filter((id) => present.has(id)).length;
  return { placed, placeable: shortlist.mustInclude.length };
}

/**
 * Must-includes in the model's first answer, or null when the model never answered.
 */
// Decision: measured on the first answer, not the final plan. The final plan contains every
// placeable must-include by construction (a missing one is a validator error), so only the first
// answer says whether the model followed the instruction. An answer that cannot be parsed
// places none.
export function firstAnswerMustInclude(
  calls: readonly CallRecord[],
  shortlist: Shortlist,
): MustIncludeCount | null {
  const first = calls.find((call) => call.response !== undefined)?.response;
  if (first === undefined) return null;
  const cutOff = first.stopReason === "refusal" || first.stopReason === "max_tokens";
  const parsed = cutOff ? null : parseSelectionText(first.rawText);
  const ids = parsed?.ok ? parsed.selection.days.flatMap((day) => day.placeIds) : [];
  return countMustInclude(ids, shortlist);
}

/** Must-includes in a finished plan (used for the rules-only baseline). */
export function planMustInclude(itinerary: Itinerary, shortlist: Shortlist): MustIncludeCount {
  const ids = itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
  return countMustInclude(ids, shortlist);
}

/** Nearest-rank percentile (p in 0..100) of the values, or null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

/** The mean, or null for an empty list. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Numerator over denominator, or null when the denominator is zero. */
export function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}
