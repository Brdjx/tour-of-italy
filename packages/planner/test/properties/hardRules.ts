import {
  DINNER_RETURN_GRACE_MIN,
  MAX_ANCHORS_PER_TRIP,
  MEALS,
  PACE,
  TRAVEL,
  TRIP_DAYS,
} from "../../src/config";
import type { PlannerContext } from "../../src/context";
import { addDays, hoursOn } from "../../src/time";
import { type LatLng, travelMinutes } from "../../src/travel";
import type { Anchor, DayPlan, Itinerary, Meal, Place, Stop } from "../../src/types";

// The hard rules re-checked from first principles for the property tests: the config tables
// (PACE, MEALS, TRAVEL), hoursOn for opening, and travelMinutes for legs (the trip back to the
// base at the end of each day included). Nothing here calls the
// scheduler, the validator, or the constraint helpers they share, so a bug in any of those
// cannot also hide itself here. Each problem is a readable string; an empty list means valid.

/** Every broken hard rule, or [] when the plan could safely reach a traveler. */
export function hardRuleProblems(itinerary: Itinerary, ctx: PlannerContext): string[] {
  const problems: string[] = [];
  const { request, days } = itinerary;
  if (days.length !== TRIP_DAYS) problems.push(`has ${days.length} days, not ${TRIP_DAYS}`);
  const bases = new Set(days.map((day) => day.anchorId));
  if (bases.size > MAX_ANCHORS_PER_TRIP) problems.push(`uses ${bases.size} bases`);
  const seen = new Set<string>();
  let previous: Anchor | undefined;
  days.forEach((day, index) => {
    const anchor = ctx.anchorById.get(day.anchorId);
    if (day.date !== addDays(request.startDate, index)) problems.push(`day ${index}: wrong date`);
    if (!anchor) {
      problems.push(`day ${index}: unknown base ${day.anchorId}`);
      return;
    }
    const transfer = previous && previous.id !== anchor.id ? centroidLeg(previous, anchor) : 0;
    if (day.transferMin !== transfer) {
      problems.push(`day ${index}: transfer ${day.transferMin}, expected ${transfer}`);
    }
    problems.push(...dayProblems(itinerary, day, index, anchor, ctx, seen));
    previous = anchor;
  });
  return problems;
}

/** Problems with a must-include place that is neither planned nor explained by a warning. */
export function silentlyDroppedMustIncludes(itinerary: Itinerary): string[] {
  const placed = new Set(itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId)));
  const explained = new Set(
    itinerary.warnings
      .filter((warning) => warning.code === "MUST_INCLUDE_UNPLACEABLE")
      .map((warning) => warning.placeId),
  );
  return itinerary.request.mustInclude
    .filter((id) => !placed.has(id) && !explained.has(id))
    .map((id) => `must-include ${id} is missing with no warning`);
}

function centroidLeg(from: Anchor, to: Anchor): number {
  return travelMinutes(from.centroid, to.centroid);
}

function dayProblems(
  itinerary: Itinerary,
  day: DayPlan,
  index: number,
  anchor: Anchor,
  ctx: PlannerContext,
  seen: Set<string>,
): string[] {
  const { request } = itinerary;
  const pace = PACE[request.pace];
  const windowStart = pace.dayStart + day.transferMin;
  const problems: string[] = [];
  if (day.stops.length === 0) problems.push(`day ${index}: no stops`);
  let from: LatLng = anchor.centroid;
  let free = windowStart;
  let visits = 0;
  let last: { stop: Stop; place: Place } | null = null;
  const mealsSeated = new Set<Meal>();
  day.stops.forEach((stop, s) => {
    const at = (text: string) => problems.push(`day ${index} stop ${s} (${stop.placeId}): ${text}`);
    const place = ctx.placesById.get(stop.placeId);
    if (!place) {
      at("unknown place");
      return;
    }
    last = { stop, place };
    if (seen.has(place.id)) at("duplicate in the trip");
    seen.add(place.id);
    if (request.exclude.includes(place.id)) at("excluded by the traveler");
    if (ctx.anchorIdByPlaceId.get(place.id) !== anchor.id) at("belongs to another base");
    if (!Number.isInteger(stop.start) || !Number.isInteger(stop.end)) at("times not whole");
    if (stop.end - stop.start !== place.durationMin) at("visit length differs from the data");
    if (!insideOneOpenRange(place, day.date, stop)) at("not inside one open range");
    if (stop.start < windowStart || stop.end > pace.dayEnd) at("outside the day window");
    const leg = travelMinutes(from, place);
    if (stop.travelFromPrevMin !== leg)
      at(`claims ${stop.travelFromPrevMin} min travel, is ${leg}`);
    const earliest = free + leg + (s === 0 ? 0 : TRAVEL.bufferMin);
    if (stop.start < earliest) at(`starts ${earliest - stop.start} min before it can be reached`);
    if (stop.role === "visit" || mealsSeated.has(stop.role)) visits++;
    else mealsSeated.add(stop.role);
    if (stop.role !== "visit") checkMeal(place, stop, stop.role, at);
    from = place;
    free = stop.end;
  });
  if (visits > pace.maxVisits) problems.push(`day ${index}: ${visits} visits`);
  problems.push(...returnProblems(day, index, anchor, pace.dayEnd, last));
  return problems;
}

/** The day must end with time to get back to the base, and state that trip back correctly. */
function returnProblems(
  day: DayPlan,
  index: number,
  anchor: Anchor,
  dayEnd: number,
  last: { stop: Stop; place: Place } | null,
): string[] {
  const back = last ? travelMinutes(last.place, anchor.centroid) : 0;
  const problems: string[] = [];
  if (day.returnTravelMin !== undefined && day.returnTravelMin !== back) {
    problems.push(`day ${index}: claims ${day.returnTravelMin} min back to the base, is ${back}`);
  }
  // After a dinner that ends the day, the walk home may run DINNER_RETURN_GRACE_MIN past it.
  const grace = last?.stop.role === "dinner" ? DINNER_RETURN_GRACE_MIN : 0;
  if (last && last.stop.end + back > dayEnd + grace) {
    problems.push(`day ${index}: back at the base after the day ends`);
  }
  return problems;
}

/** The whole visit inside one open range on the date; unknown hours only need the window. */
export function insideOneOpenRange(place: Place, date: string, stop: Stop): boolean {
  const ranges = hoursOn(place, date);
  if (ranges === "unknown") return true;
  return ranges.some((range) => range.open <= stop.start && stop.end <= range.close);
}

/** A lunch or dinner at a place that serves it, starting inside the meal window. */
function checkMeal(place: Place, stop: Stop, meal: Meal, report: (text: string) => void): void {
  if (!place.meals.includes(meal)) report(`${meal} at a place that does not serve it`);
  const window = MEALS[meal];
  if (stop.start < window.earliestStart || stop.start > window.latestStart) {
    report(`${meal} starts outside its window`);
  }
}
