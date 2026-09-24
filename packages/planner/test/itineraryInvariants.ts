import { transferMinutes } from "../src/anchors";
import {
  DINNER_RETURN_GRACE_MIN,
  MAX_ANCHORS_PER_TRIP,
  PACE,
  TRAVEL,
  TRIP_DAYS,
} from "../src/config";
import {
  dayWindow,
  mealWindowAllows,
  servesMeal,
  sharesLocation,
  withinDayWindow,
} from "../src/constraints";
import type { PlannerContext } from "../src/context";
import { ItinerarySchema } from "../src/schemas";
import { addDays, hoursOn } from "../src/time";
import { type LatLng, travelMinutes } from "../src/travel";
import type { Anchor, DayPlan, Itinerary, Place } from "../src/types";

// Every hard rule a plan must satisfy, recomputed from the public helpers (time, travel,
// constraints) and never from the scheduler's own code, so a scheduler bug cannot hide itself.
// The trip back to the base at the end of each day counts, and the planner must state it.
// Returns plain-language problems; tests assert the list is empty, so a failure names the rule.

/** Every broken hard rule in the itinerary, as readable strings. Empty means valid. */
export function invariantProblems(itinerary: Itinerary, ctx: PlannerContext): string[] {
  const problems: string[] = [];
  const request = itinerary.request;
  if (itinerary.days.length !== TRIP_DAYS) problems.push(`${itinerary.days.length} days`);
  const bases = new Set(itinerary.days.map((day) => day.anchorId));
  if (bases.size > MAX_ANCHORS_PER_TRIP) problems.push(`${bases.size} bases`);
  const used: Place[] = [];
  let previousAnchor: Anchor | undefined;
  itinerary.days.forEach((day, index) => {
    const anchor = ctx.anchorById.get(day.anchorId);
    if (!anchor) {
      problems.push(`day ${index}: unknown base ${day.anchorId}`);
      return;
    }
    if (day.date !== addDays(request.startDate, index)) problems.push(`day ${index}: wrong date`);
    const transfer = previousAnchor ? transferMinutes(previousAnchor, anchor) : 0;
    if (day.transferMin !== transfer) problems.push(`day ${index}: transfer ${day.transferMin}`);
    problems.push(...dayProblems(itinerary, day, index, anchor, ctx, used));
    previousAnchor = anchor;
  });
  if (!ItinerarySchema.safeParse(itinerary).success) problems.push("fails ItinerarySchema");
  for (const warning of itinerary.warnings) {
    if (warning.severity !== "warning") problems.push(`error in warnings: ${warning.code}`);
  }
  return problems;
}

function dayProblems(
  itinerary: Itinerary,
  day: DayPlan,
  index: number,
  anchor: Anchor,
  ctx: PlannerContext,
  used: Place[],
): string[] {
  const request = itinerary.request;
  const problems: string[] = [];
  const at = (stopIndex: number, text: string) => `day ${index} stop ${stopIndex}: ${text}`;
  if (day.stops.length === 0) problems.push(`day ${index}: empty`);
  const window = dayWindow(request.pace, day.transferMin);
  let position: LatLng = anchor.centroid;
  let free = window.start;
  let visits = 0;
  day.stops.forEach((stop, s) => {
    const place = ctx.placesById.get(stop.placeId);
    if (!place) {
      problems.push(at(s, `unknown place ${stop.placeId}`));
      return;
    }
    if (used.some((other) => other.id === place.id)) problems.push(at(s, `duplicate ${place.id}`));
    const twin = used.find((other) => sharesLocation(other, place));
    if (twin) problems.push(at(s, `shares a spot with ${twin.id}`));
    if (request.exclude.includes(place.id)) problems.push(at(s, `excluded ${place.id}`));
    if (ctx.anchorIdByPlaceId.get(place.id) !== anchor.id) problems.push(at(s, "outside base"));
    if (stop.end - stop.start !== place.durationMin) problems.push(at(s, "wrong visit length"));
    if (!openForWholeVisit(place, day.date, stop.start, stop.end)) problems.push(at(s, "closed"));
    if (!withinDayWindow(stop.start, stop.end, request.pace, day.transferMin)) {
      problems.push(at(s, "outside the day window"));
    }
    const travel = travelMinutes(position, place);
    if (stop.travelFromPrevMin !== travel) problems.push(at(s, "wrong travel time"));
    const earliest = free + travel + (s === 0 ? 0 : TRAVEL.bufferMin);
    if (stop.start < earliest) problems.push(at(s, `starts ${earliest - stop.start} min early`));
    if (stop.role === "visit") visits++;
    else if (!servesMeal(place, stop.role) || !mealWindowAllows(stop.role, stop.start)) {
      problems.push(at(s, `bad ${stop.role}`));
    }
    if (!stop.reason || stop.reasonSource !== "rule") problems.push(at(s, "no rule reason"));
    used.push(place);
    position = place;
    free = stop.end;
  });
  if (visits > PACE[request.pace].maxVisits) problems.push(`day ${index}: ${visits} visits`);
  const lastPlace = ctx.placesById.get(day.stops.at(-1)?.placeId ?? "");
  const back = lastPlace ? travelMinutes(lastPlace, anchor.centroid) : 0;
  if (day.returnTravelMin !== back) problems.push(`day ${index}: trip back ${day.returnTravelMin}`);
  const grace = day.stops.at(-1)?.role === "dinner" ? DINNER_RETURN_GRACE_MIN : 0; // walk home
  if (free + back > window.end + grace) {
    problems.push(`day ${index}: back at the base after the day ends`);
  }
  return problems;
}

/** True when the visit fits one open range on the date, or the hours are unknown. */
export function openForWholeVisit(place: Place, date: string, start: number, end: number) {
  const ranges = hoursOn(place, date);
  if (ranges === "unknown") return true;
  return ranges.some((range) => range.open <= start && end <= range.close);
}
