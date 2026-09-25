import { transferMinutes } from "./anchors";
import type { PlannerContext } from "./context";
import { contradictedClaim } from "./reasonClaims";
import { isHighestRated, ruleReason, type TripDays } from "./reasons";
import { scheduleDay } from "./schedule";
import { addDays } from "./time";
import type { Anchor, DayPlan, Stop, TripRequest, Violation } from "./types";
import { makeViolation } from "./violations";

// Timing a whole trip from ids: the planner's last step, and the same step the AI path and a
// shared link need ("these ids on these days, now give me times, transfers, and reasons").

/** One day of a selection: a base and place ids in visiting order. */
export interface DaySelection {
  anchorId: string;
  placeIds: readonly string[];
}

/** Timed days plus every violation scheduleDay reported (errors and warnings). */
export interface ScheduledTrip {
  days: DayPlan[];
  violations: Violation[];
}

/**
 * Times each day of `selection` with scheduleDay. Day i is startDate plus i; the transfer is
 * the travel time from the previous known base (0 on day 1 and when the base does not change).
 * Stops get rule reasons, keeping a reason from `previous` when the same place keeps its role.
 * Each day also gets returnTravelMin, its trip back to the base, for the timetable.
 * An unknown base gives an empty day and UNKNOWN_ANCHOR. Throws RangeError on a bad startDate.
 */
export function scheduleTrip(
  request: TripRequest,
  selection: readonly DaySelection[],
  ctx: PlannerContext,
  previous: readonly DayPlan[] = [],
): ScheduledTrip {
  const days: DayPlan[] = [];
  const violations: Violation[] = [];
  const tripDays = selection.map((day, index) => ({
    date: addDays(request.startDate, index),
    anchorId: day.anchorId,
  }));
  let lastAnchor: Anchor | undefined;
  selection.forEach((day, index) => {
    const date = addDays(request.startDate, index);
    const anchor = ctx.anchorById.get(day.anchorId);
    if (!anchor) {
      const detail = "This day's base is not in the data.";
      violations.push(makeViolation("UNKNOWN_ANCHOR", detail, { day: index }));
      days.push({ date, anchorId: day.anchorId, transferMin: 0, stops: [] });
      return;
    }
    const transferMin = lastAnchor ? transferMinutes(lastAnchor, anchor) : 0;
    const scheduled = scheduleDay(day.placeIds, date, anchor, request, ctx, transferMin, {
      dayIndex: index,
    });
    const stops = attachReasons(scheduled.stops, request, ctx, previous[index]?.stops ?? [], {
      days: tripDays,
      index,
    });
    const returnTravelMin = scheduled.returnTravelMin;
    days.push({ date, anchorId: anchor.id, transferMin, stops, returnTravelMin });
    violations.push(...scheduled.violations);
    lastAnchor = anchor;
  });
  return { days, violations };
}

/**
 * Adds a reason to every stop. A stop keeps its reason from `previous` when the same place had
 * the same role there, the reason came from the AI, and what it says about the stop's meal, time
 * of day and place in the day or trip still holds as the stop is now timed (contradictedClaim,
 * given `trip`); every other stop gets a fresh rule reason (so "close to your previous stop"
 * stays true after an edit). With `trip` (every day's date and base, and which day these stops
 * are on) the rule reasons also say what the date means for each stop; without it they say only
 * what holds on any date.
 */
// Decision: an edit on the page (a move, a removal, a swap) times the day again in the browser,
// so an AI reason carried over is checked again, like the API checks it on a new plan. "To start
// the day" moved to third place, or "morning views" moved to 15:00, would otherwise follow its
// stop. A reason that no longer holds gives way to the rule reason, and the row's mark turns from
// the AI's to the rules' with it (reasonSource). Without `trip` the check cannot place the stop in
// its trip or on a date, so no AI reason is carried over.
export function attachReasons(
  stops: readonly Stop[],
  request: TripRequest,
  ctx: PlannerContext,
  previous: readonly Stop[] = [],
  trip?: TripDays,
): Stop[] {
  const seated = stops.flatMap((stop) => (stop.role === "visit" ? [] : [stop.role]));
  const places = stops.map((stop) => ctx.placesById.get(stop.placeId));
  const ratings = places.map((place) => place?.rating);
  const date = trip?.days[trip.index]?.date;
  return stops.map((stop, index) => {
    const kept = previous.find((old) => old.placeId === stop.placeId && old.role === stop.role);
    if (
      kept?.reason !== undefined &&
      kept.reasonSource === "ai" &&
      stillHolds(kept.reason, stops, index, ctx, trip)
    ) {
      return { ...stop, reason: kept.reason, reasonSource: "ai" };
    }
    const place = places[index];
    if (!place) return { ...stop };
    const prevPlace = index === 0 ? null : (places[index - 1] ?? null);
    const day = {
      start: stop.start,
      end: stop.end,
      seated,
      highestRated: isHighestRated(ratings, index),
      ...(date === undefined ? {} : { date, trip }),
    };
    const reason = ruleReason(place, request, stop.role, prevPlace, day);
    return { ...stop, reason, reasonSource: "rule" };
  });
}

/**
 * True when the reason makes no claim that the stop at `index`, as timed, contradicts. False
 * without the trip.
 */
function stillHolds(
  reason: string,
  stops: readonly Stop[],
  index: number,
  ctx: PlannerContext,
  trip: TripDays | undefined,
): boolean {
  if (!trip) return false;
  // The check reads this day's stops, and only the date and base of the others.
  const days = trip.days.map((day, at) => ({
    date: day.date,
    anchorId: day.anchorId,
    stops: at === trip.index ? stops : [],
  }));
  return contradictedClaim(reason, { days, day: trip.index, index }, ctx) === null;
}
