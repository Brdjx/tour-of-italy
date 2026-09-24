import {
  compareViolations,
  type DaySelection,
  type Itinerary,
  type PlannerContext,
  scheduleTrip,
  type TripRequest,
  type Violation,
  validateItinerary,
} from "@italy/planner";

// Rebuilding a shared plan from ids: time the days with the planner, then leave out whatever
// the validator flags, one stop per day per round, until the trip is clean or cannot be.

/**
 * Times the selection, then leaves out the stops the validator flags, until the trip is clean.
 * A must-include that cannot be kept is dropped from the request too. Null when the trip cannot
 * be made clean by leaving stops out (an empty day, too many bases, too many visits).
 */
export function rebuildValid(
  request: TripRequest,
  selection: DaySelection[],
  ctx: PlannerContext,
  generatedAt: string,
): { itinerary: Itinerary; dropped: number } | null {
  let current = selection;
  let currentRequest = request;
  let dropped = 0;
  const maxRounds = selection.reduce((sum, day) => sum + day.placeIds.length, 0) + 2;
  for (let round = 0; round < maxRounds; round++) {
    const itinerary = sharedItinerary(currentRequest, current, ctx, generatedAt);
    const violations = validateItinerary(itinerary, ctx);
    const errors = violations.filter((violation) => violation.severity === "error");
    if (errors.length === 0) {
      const warnings = violations
        .filter((violation) => violation.severity === "warning")
        .sort(compareViolations);
      return { itinerary: { ...itinerary, warnings }, dropped };
    }
    const bad = flaggedPlaceIds(errors, itinerary);
    const missing = new Set(
      errors.flatMap((error) => (error.code === "MUST_INCLUDE_MISSING" ? [error.placeId] : [])),
    );
    const next = current.map((day) => ({
      ...day,
      placeIds: day.placeIds.filter((id) => !bad.has(id)),
    }));
    const removed = count(current) - count(next);
    if (removed === 0 && missing.size === 0) return null;
    dropped += removed;
    current = next;
    currentRequest = {
      ...currentRequest,
      mustInclude: currentRequest.mustInclude.filter((id) => !missing.has(id)),
    };
  }
  return null;
}

function sharedItinerary(
  request: TripRequest,
  selection: DaySelection[],
  ctx: PlannerContext,
  generatedAt: string,
): Itinerary {
  const trip = scheduleTrip(request, selection, ctx);
  return {
    request,
    days: trip.days,
    source: "deterministic",
    warnings: [],
    meta: { attempts: 0, latencyMs: 0, generatedAt },
  };
}

/**
 * The place id of the earliest flagged stop on each day. Only the earliest: a closed stop is
 * still timed, so it can push every later stop out of its hours, and removing all of them at
 * once would throw away stops that fit fine once the first one is gone.
 */
function flaggedPlaceIds(errors: Violation[], itinerary: Itinerary): Set<string> {
  const earliest = new Map<number, { index: number; id: string }>();
  const loose = new Set<string>();
  for (const error of errors) {
    if (error.code === "MUST_INCLUDE_MISSING") continue;
    const stop =
      error.day === undefined || error.stopIndex === undefined
        ? undefined
        : itinerary.days[error.day]?.stops[error.stopIndex];
    if (stop && error.day !== undefined && error.stopIndex !== undefined) {
      const current = earliest.get(error.day);
      if (!current || error.stopIndex < current.index) {
        earliest.set(error.day, { index: error.stopIndex, id: stop.placeId });
      }
    } else if (error.placeId !== undefined) {
      loose.add(error.placeId);
    }
  }
  if (earliest.size > 0) return new Set([...earliest.values()].map((entry) => entry.id));
  return loose;
}

function count(selection: DaySelection[]): number {
  return selection.reduce((sum, day) => sum + day.placeIds.length, 0);
}
