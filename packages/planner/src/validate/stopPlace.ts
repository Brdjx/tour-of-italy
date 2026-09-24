import { MIN_SUGGEST_RATING } from "../config";
import { isExcluded, isOpenDuring, servesMeal, sharesLocation, withinBudget } from "../constraints";
import { anchorOfPlace, type PlannerContext } from "../context";
import { openStatusOn } from "../time";
import { formatDuration } from "../travel";
import type { Place, Stop, TripRequest, Violation } from "../types";
import { makeViolation, type ViolationTarget } from "../violations";
import type { DayFacts } from "./days";
import {
  dateText,
  dayText,
  noteText,
  priceText,
  rangesText,
  spanText,
  weekdayPlural,
} from "./text";

// Checks that depend on which place a stop is: trip membership (duplicates, exclusions, shared
// spots), the base, meals, opening hours on the day's date, budget, and rating.

/** Places already seen in the trip, in visiting order, for duplicate and same-spot checks. */
export interface TripState {
  firstDayOf: Map<string, number>; // place id -> index of the first day it appears on
  placed: Place[]; // known places in trip order, each once
}

export function newTripState(): TripState {
  return { firstDayOf: new Map(), placed: [] };
}

/** Duplicate, excluded, and same-spot checks. Updates the trip state. */
export function checkMembership(
  stop: Stop,
  place: Place | undefined,
  request: TripRequest,
  trip: TripState,
  target: ViolationTarget,
): Violation[] {
  const out: Violation[] = [];
  const name = place?.name ?? "This place";
  const firstDay = trip.firstDayOf.get(stop.placeId);
  if (firstDay !== undefined) {
    const detail = `${name} is already in this trip on ${dayText(firstDay)}.`;
    out.push(makeViolation("DUPLICATE_PLACE", detail, target));
  }
  if (isExcluded({ id: stop.placeId }, request)) {
    out.push(makeViolation("EXCLUDED_PLACE", `You asked to leave out ${name}.`, target));
  }
  if (place && firstDay === undefined) {
    for (const other of trip.placed) {
      if (!sharesLocation(place, other)) continue;
      const detail = `${name} is at the same spot as ${other.name}, which is also in this trip.`;
      out.push(makeViolation("SAME_LOCATION", detail, target));
    }
    trip.placed.push(place);
  }
  if (firstDay === undefined && target.day !== undefined) {
    trip.firstDayOf.set(stop.placeId, target.day);
  }
  return out;
}

/** Visit length, base, meal role, hours, budget, and rating for a known place. */
export function checkPlace(
  stop: Stop,
  place: Place,
  day: DayFacts,
  request: TripRequest,
  ctx: PlannerContext,
  timed: boolean,
  target: ViolationTarget,
): Violation[] {
  const out: Violation[] = [];
  if (timed && stop.end - stop.start !== place.durationMin) {
    const detail = `${place.name} is planned for ${formatDuration(stop.end - stop.start)}, but a visit takes ${formatDuration(place.durationMin)}.`;
    out.push(makeViolation("INVALID_TIME", detail, target));
  }
  if (day.anchor && ctx.anchorIdByPlaceId.get(place.id) !== day.anchor.id) {
    const home = anchorOfPlace(ctx, place.id)?.name ?? "another";
    const detail = `${place.name} belongs to the ${home} base, but ${dayText(day.index)} is based in ${day.anchor.name}.`;
    out.push(makeViolation("OUTSIDE_ANCHOR", detail, target));
  }
  if ((stop.role === "lunch" || stop.role === "dinner") && !servesMeal(place, stop.role)) {
    out.push(
      makeViolation("NOT_A_MEAL_PLACE", `${place.name} does not serve ${stop.role}.`, target),
    );
  }
  if (timed && day.date !== null) out.push(...checkHours(stop, place, day.date, target));
  const price = place.priceLevel;
  const limit = request.maxPriceLevel;
  if (price !== null && limit !== null && !withinBudget(place, limit)) {
    const detail = `${place.name} is ${priceText(price)}, over your limit of ${priceText(limit)}.`;
    out.push(makeViolation("OVER_BUDGET", detail, target));
  }
  if (place.rating !== null && place.rating < MIN_SUGGEST_RATING) {
    const detail = `${place.name} is rated ${place.rating} out of 5, below the ${MIN_SUGGEST_RATING} we usually suggest.`;
    out.push(makeViolation("LOW_RATING", detail, target));
  }
  return out;
}

/**
 * Opening hours on the day's date. A season or date rule that shuts the place all day is
 * SEASONAL_CLOSED; a weekly closed day or a visit outside the open ranges is CLOSED_AT_TIME;
 * unknown hours are a HOURS_UNKNOWN warning.
 */
function checkHours(stop: Stop, place: Place, date: string, target: ViolationTarget): Violation[] {
  const status = openStatusOn(place, date);
  if (status.state === "unknown") {
    const detail = `Opening hours for ${place.name} are not confirmed, so check before you go.`;
    return [makeViolation("HOURS_UNKNOWN", detail, target)];
  }
  if (status.state === "closed" && status.reason === "weekly") {
    const detail = `${place.name} is closed on ${weekdayPlural(date)}.`;
    return [makeViolation("CLOSED_AT_TIME", detail, target)];
  }
  if (status.state === "closed") {
    const detail = `${place.name} is closed on ${dateText(date)}${noteText(status.rule?.source)}.`;
    return [makeViolation("SEASONAL_CLOSED", detail, target)];
  }
  if (isOpenDuring(place, date, stop.start, stop.end) === "yes") return [];
  const detail = `${place.name} is open ${rangesText(status.ranges)} on ${dateText(date)}, but this visit runs ${spanText(stop.start, stop.end)}.`;
  return [makeViolation("CLOSED_AT_TIME", detail, target)];
}
