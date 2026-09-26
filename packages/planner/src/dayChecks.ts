import type { PlannerContext } from "./context";
import { withDay } from "./planDay";
import { EPOCH_ISO } from "./planPolicy";
import { type DaySelection, scheduleTrip } from "./trip";
import type { Itinerary, TripRequest, Violation } from "./types";
import { validateItinerary } from "./validate";
import { dayText } from "./validate/text";
import { isError, makeViolation } from "./violations";

// The validator's verdict on a trip held as ids, and which of its errors a re-planned day brought.
// Shared by the one-day check (dayBases.ts) and the route check (dayRoute.ts).

/** The key of an error, to tell a new one from one the trip already had. */
export const errorKey = (v: Violation) => `${v.code}|${v.day ?? ""}|${v.placeId ?? ""}`;

/** The validator's errors for the trip timed from its ids. */
export function tripErrors(
  request: TripRequest,
  days: readonly DaySelection[],
  ctx: PlannerContext,
): Violation[] {
  const itinerary: Itinerary = {
    request,
    days: scheduleTrip(request, days, ctx).days,
    source: "deterministic",
    warnings: [],
    meta: { attempts: 0, latencyMs: 0, generatedAt: EPOCH_ISO },
  };
  return validateItinerary(itinerary, ctx).filter(isError);
}

/**
 * True for a day after `dayIndex` that has no stops: a day of a route still waiting to be planned
 * (dayRoute.ts plans a route's days in order, and sends each one's days with the later ones empty).
 */
export function isWaiting(days: readonly DaySelection[], dayIndex: number, day: number): boolean {
  return day > dayIndex && days[day]?.placeIds.length === 0;
}

/**
 * The errors of the trip with day `dayIndex` replaced by `day` that it did not have before: any
 * error on that day, and any other error whose code, day and place the trip before did not have,
 * except on a later day still waiting to be planned (isWaiting). `before` is tripErrors of the
 * trip as it was.
 */
// Decision: an error the trip already had elsewhere is not the re-plan's to fix, and it cannot
// fix it without changing another day. So a trip the traveler has already broken (an edit the page
// flagged) can still have a day re-planned, and the re-plan can never make it worse.
// Decision: a day still waiting its turn in a route is judged in its turn, not now. Its errors
// (no stops yet, a must-include the validator says fits there) move with each day planned before
// it, and holding them against this day would refuse a route the check had already allowed.
export function newTripErrors(
  request: TripRequest,
  days: readonly DaySelection[],
  dayIndex: number,
  day: DaySelection,
  ctx: PlannerContext,
  before: readonly Violation[] = tripErrors(request, days, ctx),
): Violation[] {
  const had = new Set(before.map(errorKey));
  const after = tripErrors(request, withDay(days, dayIndex, day), ctx);
  return after.filter(
    (error) =>
      error.day === dayIndex ||
      (!had.has(errorKey(error)) &&
        (error.day === undefined || !isWaiting(days, dayIndex, error.day))),
  );
}

/**
 * The traveler's must-includes that `rulesDay` (planDay's day for the same day and city) holds
 * and `day` leaves out, each as a MUST_INCLUDE_MISSING error on day `dayIndex`. The check a day
 * from the AI passes as well as newTripErrors, on the server and on the page.
 */
// Decision: a day of a route cannot lose a place asked for that the rules' day holds. newTripErrors
// cannot see that loss: the trip it compares against has the route's days to plan again empty,
// so a must-include one of them held is already missing there, and when the validator finds room
// for it on a day the route keeps (the first day of its city that fits it), the error is one the
// trip "already had". Found in review (2026-09-26): Rome three days with Da Enzo al 29 on day 3,
// routed Rome, Florence, Rome, took a day 3 without it, and the trip lost it. The rules' day is the
// one the route's preview promised and the one the fallback plans, so this never refuses a day
// the fallback could not replace.
export function mustIncludesLeftOut(
  request: TripRequest,
  dayIndex: number,
  rulesDay: DaySelection,
  day: DaySelection,
  ctx: PlannerContext,
): Violation[] {
  const kept = new Set(day.placeIds);
  const asked = new Set(request.mustInclude);
  return [...new Set(rulesDay.placeIds)]
    .filter((id) => asked.has(id) && !kept.has(id))
    .map((id) => {
      const name = ctx.placesById.get(id)?.name ?? "a place";
      const detail = `You asked for ${name}, and it fits on ${dayText(dayIndex)}, but it is not in the plan.`;
      return makeViolation("MUST_INCLUDE_MISSING", detail, { day: dayIndex, placeId: id });
    });
}
