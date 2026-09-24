import { PACE, TRAVEL } from "../../src/config";
import { coversMeal } from "../../src/constraints";
import { dayRuleBreaks, inSatelliteArea } from "../../src/dayRules";
import { EVENING_FROM, MEAL_WAIT_MAX_MIN } from "../../src/planPolicy";
import { type ScheduledDay, scheduleDay } from "../../src/schedule";
import type { Anchor, DayPlan, Place, Stop, TripRequest } from "../../src/types";
import { ctx } from "./arbitraries";

// Checks on a planned day for the properties about the passes that change a finished day (the
// route pass, the meal fill, meal sharing), written from the scheduler's clock (scheduleDay) and
// the day rules alone, so a bug in a pass's own checks cannot hide itself here.

export function placeOf(id: string): Place {
  const place = ctx.placesById.get(id);
  if (!place) throw new Error(`unknown place ${id}`);
  return place;
}

export function anchorOf(id: string): Anchor {
  const anchor = ctx.anchorById.get(id);
  if (!anchor) throw new Error(`unknown base ${id}`);
  return anchor;
}

/**
 * The longest daytime wait: before a stop other than dinner starting before the evening, the
 * first stop's counted from the day's start.
 */
export function longestIdle(stops: readonly Stop[], dayStart: number): number {
  let longest = 0;
  let free = dayStart;
  stops.forEach((stop, index) => {
    const arrive = free + stop.travelFromPrevMin + (index === 0 ? 0 : TRAVEL.bufferMin);
    if (stop.role !== "dinner" && stop.start < EVENING_FROM) {
      longest = Math.max(longest, stop.start - arrive);
    }
    free = stop.end;
  });
  return longest;
}

/** The meals a planned day has: a stop in that role, or an outing under way through it. */
export function mealsOf(
  stops: readonly { placeId: string; role: string; start: number; end: number }[],
) {
  return (["lunch", "dinner"] as const).filter((meal) =>
    stops.some((s) => s.role === meal || coversMeal(placeOf(s.placeId), s.start, s.end, meal)),
  );
}

/** True when `place` could sit at `at` without splitting the day's one trip out of town. */
export function onTheWay(
  place: Place,
  places: readonly Place[],
  at: number,
  anchor: Anchor,
): boolean {
  const away = (other: Place | undefined) => other !== undefined && other.city !== anchor.name;
  const before = places.slice(0, at);
  if (place.city === anchor.name) return !(away(before.at(-1)) && away(places[at]));
  return away(before.at(-1)) && inSatelliteArea(place, before, anchor);
}

/**
 * The day with its stops in `order` timed, when that keeps what the planned day got right: no
 * error, every stop still there in the same role, no stop newly breaking a day rule (or breaking
 * one later), and no daytime wait over MEAL_WAIT_MAX_MIN or the longest the day had; else null.
 */
export function cleanChange(
  day: DayPlan,
  order: readonly string[],
  request: TripRequest,
): ScheduledDay | null {
  const timed = scheduleDay(order, day.date, anchorOf(day.anchorId), request, ctx, day.transferMin);
  if (timed.violations.some((v) => v.severity === "error")) return null;
  const roles = new Map(day.stops.map((stop) => [stop.placeId, stop.role]));
  if (timed.stops.some((s) => roles.has(s.placeId) && roles.get(s.placeId) !== s.role)) {
    return null;
  }
  const breaking = new Map<string, number>();
  const ids = day.stops.map((stop) => stop.placeId);
  for (const i of dayRuleBreaks(day.stops, ids.map(placeOf), day.date, [])) {
    breaking.set(ids[i] ?? "", day.stops[i]?.start ?? 0);
  }
  const after = timed.stops.map((stop) => placeOf(stop.placeId));
  const newBreak = dayRuleBreaks(timed.stops, after, day.date, []).some((i) => {
    const stop = timed.stops[i];
    const was = stop ? breaking.get(stop.placeId) : undefined;
    return stop === undefined || was === undefined || stop.start > was;
  });
  if (newBreak) return null;
  const dayStart = PACE[request.pace].dayStart + day.transferMin;
  const cap = Math.max(longestIdle(day.stops, dayStart), MEAL_WAIT_MAX_MIN);
  return longestIdle(timed.stops, dayStart) <= cap ? timed : null;
}
