import { MIN_SUGGEST_RATING, PACE, TRIP_DAYS } from "../../src/config";
import { withinBudget } from "../../src/constraints";
import { placesOfAnchor } from "../../src/context";
import { addDays, hoursOn, isValidIsoDate } from "../../src/time";
import { travelMinutes } from "../../src/travel";
import type { DayPlan, TripRequest } from "../../src/types";
import { realContext } from "../plannerFixtures";

// The hand-written trips in trips.ts are three days long, worked out by hand. So that changing
// TRIP_DAYS stays a one-line change, they are fitted to the trip length here: cut when trips are
// shorter, and padded when they are longer with one quiet visit a day at the last day's base
// (timed from the travel model and hoursOn, never by the scheduler). With TRIP_DAYS = 3 this
// changes nothing.

/** The written days fitted to TRIP_DAYS. */
export function fitToTripLength(request: TripRequest, days: DayPlan[]): DayPlan[] {
  if (days.length >= TRIP_DAYS) return days.slice(0, TRIP_DAYS);
  const used = new Set(days.flatMap((day) => day.stops.map((stop) => stop.placeId)));
  const fitted = [...days];
  while (fitted.length < TRIP_DAYS) {
    const day = extraDay(request, fitted, used);
    fitted.push(day);
    for (const stop of day.stops) used.add(stop.placeId);
  }
  return fitted;
}

/** A valid day after the last of `days`, at the same base, with one visit not yet in the trip. */
export function extraDay(
  request: TripRequest,
  days: readonly DayPlan[],
  used: ReadonlySet<string> = new Set(days.flatMap((d) => d.stops.map((s) => s.placeId))),
): DayPlan {
  const last = days[days.length - 1];
  if (!last) throw new Error("a padded trip needs a written day to follow");
  // The day after the last written day, so a trip with a bad start date still pads.
  const date = isValidIsoDate(last.date) ? addDays(last.date, 1) : last.date;
  return paddingDay(request, last.anchorId, date, used);
}

/**
 * One day at the base with one quiet visit: a place in the base city, not a meal place, with
 * listed or public-space hours that hold the whole visit once it can be reached, within budget,
 * rated well, and not sharing a spot with a place already in the trip.
 * Its only warnings are the two missing meals.
 */
function paddingDay(
  request: TripRequest,
  anchorId: string,
  date: string,
  used: ReadonlySet<string>,
): DayPlan {
  const ctx = realContext();
  const anchor = ctx.anchorById.get(anchorId);
  if (!anchor) throw new Error("a padded trip needs a known base on its last day");
  // Highest id first: the famous sights the tests name have low ids.
  for (const place of placesOfAnchor(ctx, anchor.id).reverse()) {
    const hours = hoursOn(place, date);
    const fair =
      place.city === anchor.name &&
      !place.mealCapable &&
      hours !== "unknown" &&
      (place.rating ?? 0) >= MIN_SUGGEST_RATING &&
      withinBudget(place, request.maxPriceLevel) &&
      !used.has(place.id) &&
      !request.exclude.includes(place.id) &&
      place.sharedLocationWith.every((id) => !used.has(id));
    if (!fair) continue;
    const travel = travelMinutes(anchor.centroid, place);
    const reach = PACE[request.pace].dayStart + travel;
    const range = hours.find(
      (open) => Math.max(reach, open.open) + place.durationMin <= open.close,
    );
    if (!range) continue;
    const start = Math.max(reach, range.open);
    const end = start + place.durationMin;
    const stop = {
      placeId: place.id,
      start,
      end,
      travelFromPrevMin: travel,
      role: "visit" as const,
    };
    return { date, anchorId: anchor.id, transferMin: 0, stops: [stop] };
  }
  throw new Error(`no place left in ${anchor.name} to pad the trip`);
}

/** The warnings the padding days carry, as "CODE day placeId" keys: no lunch and no dinner. */
export function paddingWarnings(writtenDays = 3): string[] {
  const keys: string[] = [];
  for (let day = writtenDays; day < TRIP_DAYS; day++) {
    keys.push(`MEAL_MISSING ${day} -`, `MEAL_MISSING ${day} -`);
  }
  return keys;
}

/** The details of those warnings, in the validator's words. */
export function paddingMealDetails(writtenDays = 3): string[] {
  const details: string[] = [];
  for (let day = writtenDays; day < TRIP_DAYS; day++) {
    details.push(`Day ${day + 1} has no lunch stop.`, `Day ${day + 1} has no dinner stop.`);
  }
  return details;
}

/** The expected warnings of a written trip, without those of days a shorter trip cuts off. */
export function fittedWarnings(keys: readonly string[]): string[] {
  const kept = keys.filter((key) => {
    const day = Number(key.split(" ")[1]);
    return Number.isNaN(day) || day < TRIP_DAYS; // "-" marks a trip-level warning
  });
  return [...kept, ...paddingWarnings()];
}
