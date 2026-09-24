import { compareText } from "./anchors";
import type { PlannerContext } from "./context";
import { unplacedMustIncludes } from "./mustInclude";
import { repairMustIncludes } from "./mustRepair";
import { EPOCH_ISO } from "./planPolicy";
import { scheduleDay } from "./schedule";
import { isError } from "./scheduleChecks";
import { addDays, tripDates } from "./time";
import { type DaySelection, scheduleTrip, withoutErrorStops } from "./trip";
import { chooseTrip, type TripDraft } from "./tripBuilder";
import type { FallbackReason, Itinerary, ItineraryMeta, TripRequest, Violation } from "./types";
import { validateItinerary } from "./validate";

// planDeterministic: a whole trip from the rules alone. It is the plan when the AI layer is off
// and the fallback whenever the AI path fails, so it must always return TRIP_DAYS days with no
// error violation. Steps: choose bases and build days greedily (tripBuilder.ts), insert any
// must-include the walk left out where it still fits (mustRepair.ts), time the days with
// scheduleDay and add rule reasons (trip.ts), then explain any must-include still left out.

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
  const draft = repairMustIncludes(chosen, request, ctx, dates);
  const trip = scheduleTrip(request, cleanSelection(draft, request, ctx), ctx);
  const placedIds = new Set(trip.days.flatMap((day) => day.stops.map((stop) => stop.placeId)));
  const mustWarnings = unplacedMustIncludes(request, ctx, {
    dates,
    anchorIds: draft.anchorIds,
    placedIds,
  });
  const itinerary: Itinerary = {
    request: copyRequest(request),
    days: trip.days,
    source: "deterministic",
    warnings: [],
    meta: makeMeta(opts, startedAt),
  };
  const own = trip.violations.filter((violation) => !isError(violation));
  itinerary.warnings = chooseWarnings(own, mustWarnings, validateItinerary(itinerary, ctx));
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
 * The warnings to show. Once the validator reports anything, its warnings are the source of
 * truth (the web app shows the same list after every edit); until then, scheduleDay's. Must-
 * include explanations are added unless the chosen list already covers that place.
 */
// Decision: warnings only. An error from the validator on a planner output is a bug that the
// sweep and property tests catch; it is never copied into a list the traveler sees.
export function chooseWarnings(
  own: readonly Violation[],
  mustInclude: readonly Violation[],
  fromValidator: readonly Violation[],
): Violation[] {
  const validatorWarnings = fromValidator.filter((violation) => !isError(violation));
  const base = fromValidator.length > 0 ? validatorWarnings : [...own];
  const extra = mustInclude.filter(
    (warning) =>
      !base.some((other) => other.code === warning.code && other.placeId === warning.placeId),
  );
  return [...base, ...extra].sort(compareViolations);
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
