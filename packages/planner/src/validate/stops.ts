import { MAX_TRAVEL_MINUTES, MEALS, TRAVEL } from "../config";
import { mealWindowAllows } from "../constraints";
import type { PlannerContext } from "../context";
import { formatDuration, type LatLng, travelMinutes } from "../travel";
import type { Meal, Place, Stop, TripRequest, Violation } from "../types";
import { makeViolation, type ViolationTarget } from "../violations";
import { type DayFacts, hasValidTimes, isMinuteCount } from "./days";
import { checkMembership, checkPlace, type TripState } from "./stopPlace";
import { clockText, spanText } from "./text";

// Checks on the stops of one day, in visiting order. Timing is recomputed from each stop's own
// start and end and the travel model; nothing the plan claims about travel is taken on trust.

/** A stop with valid times, remembered to check the gap to the next one. */
interface TimedStop {
  stop: Stop;
  place: Place | undefined;
}

/** Every stop-level violation for one day. */
export function checkStops(
  day: DayFacts,
  request: TripRequest,
  ctx: PlannerContext,
  trip: TripState,
): Violation[] {
  const out: Violation[] = [];
  let previous: TimedStop | null = null;
  day.plan.stops.forEach((stop, stopIndex) => {
    const target = { day: day.index, stopIndex, placeId: stop.placeId };
    const place = ctx.placesById.get(stop.placeId);
    const name = place?.name ?? "This stop";
    const timed = hasValidTimes(stop);
    if (!place) {
      out.push(
        makeViolation("UNKNOWN_PLACE", `Stop ${stopIndex + 1} is not a place in our data.`, target),
      );
    }
    out.push(...checkMembership(stop, place, request, trip, target));
    if (!timed) out.push(makeViolation("INVALID_TIME", invalidTimeText(stop, name), target));
    if (place) out.push(...checkPlace(stop, place, day, request, ctx, timed, target));
    if (timed) out.push(...checkMealWindow(stop, name, target));
    out.push(...checkTravelClaim(stop, stopIndex, day, ctx, place, target));
    if (!timed) return;
    const current = { stop, place };
    out.push(...checkWindow(current, stopIndex, day, target));
    if (previous) out.push(...checkOverlap(previous, current, target));
    previous = current;
  });
  return out;
}

function invalidTimeText(stop: Stop, name: string): string {
  const whole = Number.isInteger(stop.start) && Number.isInteger(stop.end);
  if (!whole) return `${name} has a start or end time that is not a whole minute.`;
  if (stop.end <= stop.start) return `${name} does not end after it starts.`;
  return `${name} has a time outside the day.`;
}

/** A lunch or dinner must START inside its meal window. */
function checkMealWindow(stop: Stop, name: string, target: ViolationTarget): Violation[] {
  if (stop.role !== "lunch" && stop.role !== "dinner") return [];
  const meal: Meal = stop.role;
  if (mealWindowAllows(meal, stop.start)) return [];
  const { earliestStart, latestStart } = MEALS[meal];
  const detail = `${capitalize(meal)} at ${name} starts at ${clockText(stop.start)}, but ${meal} must start between ${clockText(earliestStart)} and ${clockText(latestStart)}.`;
  return [makeViolation("MEAL_OUTSIDE_WINDOW", detail, target)];
}

/**
 * travelFromPrevMin must equal the travel model's minutes from the previous stop, or from the
 * day's base for the first stop. Skipped when either end is not a known place or base.
 */
function checkTravelClaim(
  stop: Stop,
  stopIndex: number,
  day: DayFacts,
  ctx: PlannerContext,
  place: Place | undefined,
  target: ViolationTarget,
): Violation[] {
  const name = place?.name ?? "This stop";
  if (!isMinuteCount(stop.travelFromPrevMin, MAX_TRAVEL_MINUTES)) {
    const detail = `${name} has a travel time that is not a valid number of minutes.`;
    return [makeViolation("WRONG_TRAVEL", detail, target)];
  }
  const from = travelOrigin(stopIndex, day, ctx);
  if (!from || !place) return [];
  const minutes = travelMinutes(from.point, place);
  if (stop.travelFromPrevMin === minutes) return [];
  const actual =
    minutes === 0 ? "they are on the same spot" : `it is ${formatDuration(minutes)} away`;
  const detail = `${name} lists ${stop.travelFromPrevMin} min of travel from ${from.name}, but ${actual}.`;
  return [makeViolation("WRONG_TRAVEL", detail, target)];
}

/** Where the traveler comes from before a stop: the previous stop, or the base for the first. */
function travelOrigin(
  stopIndex: number,
  day: DayFacts,
  ctx: PlannerContext,
): { point: LatLng; name: string } | null {
  if (stopIndex === 0) {
    return day.anchor && day.origin
      ? { point: day.origin, name: `the ${day.anchor.name} base` }
      : null;
  }
  const previous = ctx.placesById.get(day.plan.stops[stopIndex - 1]?.placeId ?? "");
  return previous ? { point: previous, name: previous.name } : null;
}

/**
 * Every stop must fit the pace's day window after the transfer, meals included, and the first
 * stop cannot start before the traveler could get there from the base.
 */
// Decision: meals are inside the window too (docs/decisions.md: one day window, meals inside
// it), so the rule is the same for every role and matches withinDayWindow in constraints.ts.
function checkWindow(
  current: TimedStop,
  stopIndex: number,
  day: DayFacts,
  target: ViolationTarget,
): Violation[] {
  const { stop, place } = current;
  const name = place?.name ?? "This stop";
  const { start, end } = day.window;
  if (stop.start < start || stop.end > end) {
    const after =
      day.transferMin > 0
        ? ` after the move from ${day.previousAnchor?.name ?? "the last base"}`
        : "";
    const windowText = start <= end ? spanText(start, end) : "no time at all";
    const detail = `${name} runs ${spanText(stop.start, stop.end)}, outside this ${day.pace} day, which runs ${windowText}${after}.`;
    return [makeViolation("OUTSIDE_DAY_WINDOW", detail, target)];
  }
  if (stopIndex !== 0 || !place || !day.anchor || !day.origin) return [];
  // Decision: the day starts at the base (plan 7.7: the clock starts at the base centroid), so
  // the first stop is reached from there and a day trip cannot begin at the day's first minute.
  const firstLeg = travelMinutes(day.origin, place);
  const earliest = start + firstLeg;
  if (stop.start >= earliest) return [];
  const detail = `${name} starts at ${clockText(stop.start)}, but the day starts at ${clockText(start)} at the ${day.anchor.name} base, ${formatDuration(firstLeg)} away, so ${clockText(earliest)} is the earliest start.`;
  return [makeViolation("OUTSIDE_DAY_WINDOW", detail, target)];
}

/** The next stop cannot start before the previous one ends plus travel plus the buffer. */
function checkOverlap(
  previous: TimedStop,
  current: TimedStop,
  target: ViolationTarget,
): Violation[] {
  // Decision: with an unknown place on either side the travel is taken as 0; the plan already
  // has an UNKNOWN_PLACE error, and the buffer still catches stops that touch or overlap.
  const travel = previous.place && current.place ? travelMinutes(previous.place, current.place) : 0;
  const earliest = previous.stop.end + travel + TRAVEL.bufferMin;
  if (current.stop.start >= earliest) return [];
  const name = current.place?.name ?? "This stop";
  const before = previous.place?.name ?? "the stop before";
  const away = travel > 0 ? `, ${formatDuration(travel)} away,` : "";
  const detail = `${name} starts at ${clockText(current.stop.start)}, but ${before} ends at ${clockText(previous.stop.end)}${away} plus ${TRAVEL.bufferMin} min to spare, so ${clockText(earliest)} is the earliest start.`;
  return [makeViolation("OVERLAP", detail, target)];
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
