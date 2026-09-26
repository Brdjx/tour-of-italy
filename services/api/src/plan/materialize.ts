import {
  chooseWarnings,
  type DayPlan,
  type Itinerary,
  type ItineraryMeta,
  MAX_ANCHORS_PER_TRIP,
  type PlannerContext,
  scheduleTrip,
  type TripRequest,
  type Violation,
  validateItinerary,
} from "@italy/planner";
import type { LlmSelection } from "../llm/client";
import type { Shortlist } from "./candidates";
import { applyAiReasons, type ReasonStats } from "./reasons";
import { sanitizeSummary } from "./summary";

// Turns the model's selection (bases and ordered ids) into a timed itinerary and lists every
// error that would stop it reaching the traveler: ids or bases outside the shortlist, anything
// the scheduler could not time, and every error the independent validator finds.

export interface Materialized {
  itinerary: Itinerary; // timed, with reasons and summary applied; source "ai"
  errors: Violation[]; // empty when the plan may be shown
  reasonStats: ReasonStats;
}

function error(code: Violation["code"], detail: string, day?: number, placeId?: string): Violation {
  return {
    code,
    severity: "error",
    ...(day === undefined ? {} : { day }),
    ...(placeId === undefined ? {} : { placeId }),
    detail,
  };
}

/**
 * Errors for anything the model was not offered. The validator knows the dataset, not the
 * shortlist, so without this an over-budget or low-rated place could slip in unrequested.
 */
export function shortlistViolations(
  selection: LlmSelection,
  shortlist: Shortlist,
  ctx: PlannerContext,
): Violation[] {
  const out: Violation[] = [];
  selection.days.forEach((day, index) => {
    if (!shortlist.anchorIds.has(day.anchorId)) {
      out.push(error("UNKNOWN_ANCHOR", "This base is not one of the base options.", index));
    }
    for (const id of day.placeIds) {
      if (shortlist.placeIds.has(id)) continue;
      const detail = ctx.placesById.has(id)
        ? "This place is not in the candidate list."
        : "This id is not a place in the data.";
      out.push(error("UNKNOWN_PLACE", detail, index, id));
    }
  });
  return out;
}

/** Violations with the same code, day, and place reported once. */
export function dedupe(violations: readonly Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const v of violations) {
    const key = `${v.code}|${v.day ?? ""}|${v.placeId ?? ""}|${v.stopIndex ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * The selection timed, with its reasons and summary, and its errors. `added` holds the meals code
 * added after the check (mealAdd.ts): they keep their rule reasons.
 */
export function materializeSelection(
  selection: LlmSelection,
  request: TripRequest,
  shortlist: Shortlist,
  ctx: PlannerContext,
  meta: ItineraryMeta,
  added: ReadonlySet<string> = new Set(),
): Materialized {
  const picks = selection.days.map((day) => ({ anchorId: day.anchorId, placeIds: day.placeIds }));
  const scheduled = scheduleTrip(request, picks, ctx);
  const reasoned = applyAiReasons(scheduled.days, selection, ctx, undefined, added);
  const days: DayPlan[] = scheduled.days.map((day, index) => ({
    ...day,
    stops: reasoned.days[index] ?? day.stops,
  }));
  const itinerary: Itinerary = {
    request: structuredClone(request),
    days,
    source: "ai",
    warnings: [],
    meta,
  };
  // Decision: a whole-trip answer keeps to the prompt's limit of MAX_ANCHORS_PER_TRIP bases. The
  // validator allows a base a day for routes the traveler sets (dayRoute.ts in the planner); a
  // third base the model chose on its own is still TOO_MANY_ANCHORS, with the same detail.
  const fromValidator = validateItinerary(itinerary, ctx, { maxBases: MAX_ANCHORS_PER_TRIP });
  const errors = dedupe([
    ...shortlistViolations(selection, shortlist, ctx),
    ...scheduled.violations.filter((v) => v.severity === "error"),
    ...fromValidator.filter((v) => v.severity === "error"),
  ]);
  // Decision: the warnings are exactly the validator's, in the planner's order, so the browser
  // re-validating this plan shows the same list (failure vector F10).
  itinerary.warnings = chooseWarnings([], [], fromValidator);
  const planIds = new Set(days.flatMap((day) => day.stops.map((stop) => stop.placeId)));
  const summary = sanitizeSummary(selection.summary, planIds, ctx);
  if (summary !== undefined) itinerary.summary = summary;
  return { itinerary, errors, reasonStats: reasoned.stats };
}
