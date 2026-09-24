import { compareText } from "./anchors";
import type { PlannerContext } from "./context";
import { fillMissingMeals } from "./mealFill";
import { shareMeals } from "./mealShare";
import { repairMustIncludes } from "./mustRepair";
import { EPOCH_ISO } from "./planPolicy";
import { PoolCache } from "./pools";
import { shortenRoutes } from "./route";
import { scheduleDay } from "./schedule";
import { addDays, tripDates } from "./time";
import { type DaySelection, scheduleTrip, withoutErrorStops } from "./trip";
import { chooseTrip, type TripDraft } from "./tripBuilder";
import type { FallbackReason, Itinerary, ItineraryMeta, TripRequest, Violation } from "./types";
import { validateItinerary } from "./validate";
import { isError, isWarning } from "./violations";

// planDeterministic: a whole trip from the rules alone. It is the plan when the AI layer is off
// and the fallback whenever the AI path fails, so it must always return TRIP_DAYS days with no
// error violation. Steps:
//   1. choose bases and build days greedily (tripBuilder.ts, tripWalk.ts, dayBuilder.ts), each
//      candidate trip with any must-include the walk left out inserted where it still fits
//      (mustRepair.ts);
//   2. reorder each day to travel less where that keeps every rule (route.ts), then repair again;
//   3. seat any missing lunch or dinner an unused meal place can take (mealFill.ts), move a meal
//      to a day with none from a day with two (mealShare.ts), and fill again;
//   4. time the days with scheduleDay and add rule reasons (trip.ts);
//   5. take the warnings, including why any must-include is missing, from the validator.

/** Options for planDeterministic. Nothing here changes which places are chosen. */
export interface PlanOptions {
  generatedAt?: string; // ISO timestamp for meta.generatedAt; wins over `now`
  now?: () => number; // injected clock in ms since the epoch, for generatedAt and latencyMs
  fallbackReason?: FallbackReason; // why the rules-only planner ran, copied to meta
}

/**
 * Thrown only when no base in the context can hold one stop on every trip day, which the
 * shipped dataset cannot produce (a request excludes at most 10 places). An itinerary with an
 * empty day would be an error-level plan, so the planner refuses instead of returning one.
 */
export class NoFeasiblePlanError extends Error {
  readonly code = "NO_FEASIBLE_PLAN";

  constructor() {
    super("No base can hold a stop on every day of this trip with these settings");
    this.name = "NoFeasiblePlanError";
  }
}

/**
 * A full trip from the rules alone. Deterministic: the same request, context, and options give
 * identical JSON. Never calls Date.now. Throws RangeError on an invalid startDate and
 * NoFeasiblePlanError when no base can fill every day (see above); never for a request that
 * passes TripRequestSchema against the shipped dataset.
 */
export function planDeterministic(
  request: TripRequest,
  ctx: PlannerContext,
  opts: PlanOptions = {},
): Itinerary {
  const startedAt = opts.now?.();
  const dates = tripDates(request.startDate);
  const chosen = chooseTrip(request, ctx, dates);
  if (!chosen) throw new NoFeasiblePlanError();
  // Decision: the repair runs again after the route pass. A shorter order can move a
  // must-include earlier and open the gap a missing one needs (Pienza after the Duomo), and the
  // validator judges the final order, so the planner must too.
  const routed = repairMustIncludes(
    shortenRoutes(chosen, request, ctx, dates),
    request,
    ctx,
    dates,
  );
  // Decision: meals are filled last, after every pass that may remove an ordinary stop. The fill
  // only adds and the sharing only moves meal places, so no must-include is ever moved.
  const pools = new PoolCache(request, ctx);
  const fed = fillMissingMeals(routed, request, ctx, dates, pools);
  // A day that gave a meal away may take an unused place the first fill could not seat there.
  const shared = shareMeals(fed, request, ctx, dates, pools);
  const refed = shared === fed ? fed : fillMissingMeals(shared, request, ctx, dates, pools);
  const trip = scheduleTrip(request, cleanSelection(refed, request, ctx), ctx);
  const itinerary: Itinerary = {
    request: copyRequest(request),
    days: trip.days,
    source: "deterministic",
    warnings: [],
    meta: makeMeta(opts, startedAt),
  };
  itinerary.warnings = planWarnings(itinerary, ctx);
  if (startedAt !== undefined && opts.now) {
    itinerary.meta.latencyMs = Math.max(0, opts.now() - startedAt);
  }
  return itinerary;
}

/**
 * The draft's days with any stop scheduleDay would reject removed. A defensive last step: the
 * greedy walk times stops exactly as scheduleDay does, so for its own drafts this never removes
 * anything (the sweep tests assert it); it exists so a future bug degrades to a shorter day
 * instead of an error-level plan.
 */
export function cleanSelection(
  draft: TripDraft,
  request: TripRequest,
  ctx: PlannerContext,
): DaySelection[] {
  const trial = scheduleTrip(request, selectionOf(draft), ctx);
  if (!trial.violations.some(isError)) return selectionOf(draft);
  return draft.anchorIds.map((anchorId, index) => {
    const anchor = ctx.anchorById.get(anchorId);
    const ids = draft.days[index] ?? [];
    const day = trial.days[index];
    if (!anchor || !day) return { anchorId, placeIds: ids };
    const date = addDays(request.startDate, index);
    const placeIds = withoutErrorStops(ids, (current) =>
      scheduleDay(current, date, anchor, request, ctx, day.transferMin),
    );
    return { anchorId, placeIds };
  });
}

function selectionOf(draft: TripDraft): DaySelection[] {
  return draft.anchorIds.map((anchorId, index) => ({
    anchorId,
    placeIds: draft.days[index] ?? [],
  }));
}

/**
 * The warnings the traveler sees for a plan: the validator's, in a stable order. planDeterministic
 * and rescheduleDay both use it, so a new plan and an edited one show the same list the server
 * would (F10), including why a must-include is missing.
 */
// Decision: warnings only. An error from the validator on a planner output is a bug that the
// sweep and property tests catch; it is never copied into a list the traveler sees.
export function planWarnings(itinerary: Itinerary, ctx: PlannerContext): Violation[] {
  return validateItinerary(itinerary, ctx).filter(isWarning).sort(compareViolations);
}

/**
 * @deprecated planDeterministic no longer calls this; use planWarnings. Kept, unchanged, so code
 * written against the earlier API still compiles. It returns the validator's warnings when the
 * validator reported anything, else `own`, plus any must-include warning not already covered.
 */
export function chooseWarnings(
  own: readonly Violation[],
  mustInclude: readonly Violation[],
  fromValidator: readonly Violation[],
): Violation[] {
  const shown = fromValidator.length > 0 ? fromValidator.filter(isWarning) : [...own];
  const extra = mustInclude.filter(
    (warning) =>
      !shown.some((other) => other.code === warning.code && other.placeId === warning.placeId),
  );
  return [...shown, ...extra].sort(compareViolations);
}

/** Trip-level first, then by day, stop, code, place, and detail, so the order is stable. */
export function compareViolations(a: Violation, b: Violation): number {
  return (
    (a.day ?? -1) - (b.day ?? -1) ||
    (a.stopIndex ?? -1) - (b.stopIndex ?? -1) ||
    compareText(a.code, b.code) ||
    compareText(a.placeId ?? "", b.placeId ?? "") ||
    compareText(a.detail, b.detail)
  );
}

function makeMeta(opts: PlanOptions, startedAt: number | undefined): ItineraryMeta {
  // Date.UTC with the milliseconds in the last field is the epoch instant itself, written in
  // the form the package's source guard allows (no local-time Date constructor).
  const fromClock =
    startedAt === undefined
      ? EPOCH_ISO
      : new Date(Date.UTC(1970, 0, 1, 0, 0, 0, startedAt)).toISOString();
  const generatedAt = opts.generatedAt ?? fromClock;
  return {
    attempts: 0,
    latencyMs: 0,
    ...(opts.fallbackReason === undefined ? {} : { fallbackReason: opts.fallbackReason }),
    generatedAt,
  };
}

/** A copy of the request, so later edits to the caller's object cannot change the plan. */
function copyRequest(request: TripRequest): TripRequest {
  return {
    ...request,
    interests: [...request.interests],
    anchors: request.anchors === "auto" ? "auto" : [...request.anchors],
    mustInclude: [...request.mustInclude],
    exclude: [...request.exclude],
  };
}
