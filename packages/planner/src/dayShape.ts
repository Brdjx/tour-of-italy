import { TRAVEL } from "./config";
import { coversMeal } from "./constraints";
import { dayRuleBreaks } from "./dayRules";
import { EVENING_FROM } from "./planPolicy";
import type { Meal, Place, Stop } from "./types";

// What a timed day looks like to the passes that change a finished day (route.ts reorders it,
// mealFill.ts adds a meal): which meals it has, which stops break a day rule, and the longest
// wait. Both passes keep a change only when it loses no meal, breaks no rule the day did not
// already break, and leaves the traveler waiting no longer than a set limit.

/**
 * The meals the day has: lunch and dinner, each when a stop takes that role or an outing is
 * under way through its window (coversMeal).
 */
export function mealsOf(stops: readonly Stop[], places: readonly Place[]): Meal[] {
  const meals: Meal[] = [];
  for (const meal of ["lunch", "dinner"] as const) {
    const had = stops.some((stop, index) => {
      const place = places[index];
      return (
        stop.role === meal || (place !== undefined && coversMeal(place, stop.start, stop.end, meal))
      );
    });
    if (had) meals.push(meal);
  }
  return meals;
}

/**
 * The start of each stop of a timed day that breaks a day rule (dayRules.ts), judged as if none
 * were a must-include.
 */
// Decision: the walk may place a must-include where the preferences would not (the traveler
// asked for it), but a later pass must never move one there. Counting only ordinary stops let
// the route pass push a requested Burano trip from 10:35 to 13:05, back after dark in January,
// and the Vatican Museums from 09:00 to 12:45 (252 of 1678 must-include outings in a sweep).
export function breakingStarts(
  stops: readonly Stop[],
  places: readonly Place[],
  date: string,
): Map<string, number> {
  const starts = new Map<string, number>();
  for (const index of dayRuleBreaks(stops, places, date, [])) {
    const stop = stops[index];
    if (stop) starts.set(stop.placeId, stop.start);
  }
  return starts;
}

/**
 * True when every stop breaking a rule after a change already broke one before and starts no
 * later. Per stop, not a count, so a change cannot trade one stop's break for another's, and a
 * stop that already breaks one (a December Siena trip ending after sunset) cannot move later.
 */
export function noNewBreaks(
  after: ReadonlyMap<string, number>,
  before: ReadonlyMap<string, number>,
): boolean {
  for (const [id, start] of after) {
    const was = before.get(id);
    if (was === undefined || start > was) return false;
  }
  return true;
}

/**
 * The longest wait in the day before a stop other than dinner that starts before EVENING_FROM:
 * minutes between arriving (the previous stop's end, the travel, and the buffer after the first
 * stop) and starting. The first stop's wait counts from `dayStart`, the start of the day window.
 */
// Decision: dinner and the evening are left out. A day that ends at 16:00 and meets again for
// dinner at 19:00 is the traveler resting at the hotel; two hours with nothing to do before lunch
// is a gap in the plan (the route pass moved the Guggenheim from 10:00 to 14:20 and left 09:35
// to 12:00 empty).
export function longestWait(stops: readonly Stop[], dayStart: number): number {
  let longest = 0;
  let free = dayStart;
  stops.forEach((stop, index) => {
    const arrive = free + stop.travelFromPrevMin + (index === 0 ? 0 : TRAVEL.bufferMin);
    const daytime = stop.role !== "dinner" && stop.start < EVENING_FROM;
    if (daytime) longest = Math.max(longest, stop.start - arrive);
    free = stop.end;
  });
  return longest;
}
