import { MAX_ANCHORS_PER_TRIP, TRIP_DAYS } from "./config";
import type { PlannerContext } from "./context";
import type { Itinerary, Violation } from "./types";
import { buildDayFacts, checkDayHeader, type DayFacts } from "./validate/days";
import { checkDayTotals, checkReturn } from "./validate/dayTotals";
import { checkMustIncludes } from "./validate/mustInclude";
import { newTripState } from "./validate/stopPlace";
import { checkStops } from "./validate/stops";
import { listText } from "./validate/text";
import { isError, makeViolation } from "./violations";

// The independent validator. It never calls the scheduler: every check is recomputed from the
// plan's own dates, bases, and stop times, using only the shared rules (constraints.ts, time.ts,
// travel.ts, the bases in the context, and config.ts). If the scheduler has a bug, this catches
// it; that separation is the product's main safety argument, so keep it.

export { LATEST_MINUTE } from "./validate/days";
export { VIOLATION_SEVERITY } from "./violations";

/**
 * Every violation in the itinerary, errors and warnings (codes and severities in
 * violations.ts). A plan with any error must never reach the traveler; warnings travel
 * with it. The order is stable: trip shape first, then each day (the day, its stops in order,
 * the trip back to its base, its totals), then must-include places. Pure: never throws for any
 * value of the Itinerary type and never changes its input. A value outside the type (a pace that
 * is not a Pace) can throw, so parse untrusted input (a shared link, a stored plan) with
 * ItinerarySchema first.
 */
export function validateItinerary(itinerary: Itinerary, ctx: PlannerContext): Violation[] {
  const days = buildDayFacts(itinerary, ctx);
  const out: Violation[] = [...checkTripShape(itinerary, days)];
  const trip = newTripState();
  for (const day of days) {
    out.push(...checkDayHeader(day, itinerary.request, ctx));
    out.push(...checkStops(day, itinerary.request, ctx, trip));
    out.push(...checkReturn(day, ctx));
    out.push(...checkDayTotals(day, ctx));
  }
  out.push(...checkMustIncludes(itinerary, days, ctx));
  return out;
}

/** Only the errors, for callers that decide whether a plan may be shown. */
export function validationErrors(itinerary: Itinerary, ctx: PlannerContext): Violation[] {
  return validateItinerary(itinerary, ctx).filter(isError);
}

/** Day count and the number of distinct bases. */
function checkTripShape(itinerary: Itinerary, days: readonly DayFacts[]): Violation[] {
  const out: Violation[] = [];
  const count = itinerary.days.length;
  if (count !== TRIP_DAYS) {
    const detail = `This plan has ${count} ${count === 1 ? "day" : "days"}, but a trip has ${TRIP_DAYS}.`;
    out.push(makeViolation("WRONG_DAY_COUNT", detail));
  }
  // Decision: every distinct anchor id counts, known or not. An unknown base is still a place
  // the traveler would have to travel to, and it already has its own UNKNOWN_ANCHOR error.
  const names = new Map<string, string>();
  for (const day of days) {
    if (names.has(day.plan.anchorId)) continue;
    names.set(day.plan.anchorId, day.anchor?.name ?? "an unknown base");
  }
  if (names.size > MAX_ANCHORS_PER_TRIP) {
    const detail = `This plan uses ${names.size} bases (${listText([...names.values()])}), but a trip has at most ${MAX_ANCHORS_PER_TRIP}, so too much of it would be spent in transit.`;
    out.push(makeViolation("TOO_MANY_ANCHORS", detail));
  }
  return out;
}
