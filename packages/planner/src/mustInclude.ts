import { transferMinutes } from "./anchors";
import { MAX_ANCHORS_PER_TRIP } from "./config";
import type { PlannerContext } from "./context";
import { fitsEmptyDay } from "./dayLimits";
import { chosenAnchorIds } from "./planAnchors";
import { makeViolation } from "./scheduleChecks";
import { hoursOn } from "./time";
import type { Place, TripRequest, Violation } from "./types";

// Plain reasons for must-include places the plan could not hold. Each one becomes a
// MUST_INCLUDE_UNPLACEABLE warning, so the traveler always learns why a place they asked for is
// missing instead of it vanishing silently.

/** The trip as planned: one base per day, and every place id it holds. */
export interface PlannedTrip {
  dates: readonly string[];
  anchorIds: readonly string[]; // one base id per day
  placedIds: ReadonlySet<string>;
}

/** A MUST_INCLUDE_UNPLACEABLE warning for every must-include id the trip does not hold. */
export function unplacedMustIncludes(
  request: TripRequest,
  ctx: PlannerContext,
  trip: PlannedTrip,
): Violation[] {
  const warnings: Violation[] = [];
  const seen = new Set<string>();
  for (const id of request.mustInclude) {
    if (trip.placedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const place = ctx.placesById.get(id);
    const detail = place
      ? `${place.name} could not be included. ${reasonFor(place, request, ctx, trip)}`
      : "A place you asked for is not in the data, so it could not be included.";
    warnings.push(makeViolation("MUST_INCLUDE_UNPLACEABLE", detail, { placeId: id }));
  }
  return warnings;
}

/** The first reason that applies, from the most to the least fundamental. */
function reasonFor(
  place: Place,
  request: TripRequest,
  ctx: PlannerContext,
  trip: PlannedTrip,
): string {
  if (request.exclude.includes(place.id)) return "It is also on your excluded list.";
  if (trip.dates.every((date) => isClosed(place, date))) {
    return "It is closed on every day of the trip.";
  }
  const anchor = ctx.anchorById.get(ctx.anchorIdByPlaceId.get(place.id) ?? "");
  const baseName = anchor?.name ?? "its area";
  const dayIndexes = trip.anchorIds.flatMap((id, index) => (id === anchor?.id ? [index] : []));
  if (dayIndexes.length === 0) {
    const chosen = chosenAnchorIds(request, ctx);
    if (chosen.length > 0) return `Its base, ${baseName}, is not one of the bases you chose.`;
    return `Its base, ${baseName}, is not in this trip. A trip uses at most ${MAX_ANCHORS_PER_TRIP} bases.`;
  }
  const openDays = dayIndexes.filter((index) => !isClosed(place, trip.dates[index] ?? ""));
  if (openDays.length === 0) return `It is closed on the days this trip spends in ${baseName}.`;
  if (!openDays.some((index) => fitsTripDay(place, request, ctx, trip, index))) {
    return `Its visit does not fit its opening hours within a ${request.pace} day in ${baseName}.`;
  }
  return `There was no room for it alongside the other stops in ${baseName}.`;
}

function isClosed(place: Place, date: string): boolean {
  const hours = hoursOn(place, date);
  return hours !== "unknown" && hours.length === 0;
}

/** True when the place fits the given day if it were the day's first and only stop. */
function fitsTripDay(
  place: Place,
  request: TripRequest,
  ctx: PlannerContext,
  trip: PlannedTrip,
  index: number,
): boolean {
  const anchor = ctx.anchorById.get(trip.anchorIds[index] ?? "");
  const date = trip.dates[index];
  if (!anchor || date === undefined) return false;
  const before = index === 0 ? undefined : ctx.anchorById.get(trip.anchorIds[index - 1] ?? "");
  const transferMin = before ? transferMinutes(before, anchor) : 0;
  return fitsEmptyDay(place, date, request.pace, transferMin, anchor.centroid);
}
