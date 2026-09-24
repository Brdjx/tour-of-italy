import { MAX_TRAVEL_MINUTES, PACE } from "../config";
import { coversMeal } from "../constraints";
import type { PlannerContext } from "../context";
import { formatDuration, latestReturn, travelMinutes } from "../travel";
import type { Meal, Place, Stop, Violation } from "../types";
import { makeViolation } from "../violations";
import { countVisits, type DayFacts, hasValidTimes, isMinuteCount } from "./days";
import { clockText, dayTitle } from "./text";

// Checks on a day as a whole, after its stops: the visit cap, the two meals, and the trip back
// to the base at the end of the day (the time it takes, and the day's claim about it).

/** The visit cap and the two meals. */
export function checkDayTotals(day: DayFacts, ctx: PlannerContext): Violation[] {
  const stops = day.plan.stops;
  if (stops.length === 0) return []; // EMPTY_DAY already says it all
  const out: Violation[] = [];
  const target = { day: day.index };
  const title = dayTitle(day.index);
  const visits = countVisits(stops);
  const max = PACE[day.pace].maxVisits;
  if (visits > max) {
    const detail = `${title} has ${visits} visits, but a ${day.pace} day has at most ${max}.`;
    out.push(makeViolation("TOO_MANY_VISITS", detail, target));
  }
  const meals: Meal[] = ["lunch", "dinner"];
  for (const meal of meals) {
    if (stops.some((stop) => stop.role === meal || outingCovers(stop, meal, ctx))) continue;
    out.push(makeViolation("MEAL_MISSING", `${title} has no ${meal} stop.`, target));
  }
  return out;
}

/** True when the stop is an outing under way through the meal's whole window (constraints.ts). */
function outingCovers(stop: Stop, meal: Meal, ctx: PlannerContext): boolean {
  const place = ctx.placesById.get(stop.placeId);
  return (
    place !== undefined && hasValidTimes(stop) && coversMeal(place, stop.start, stop.end, meal)
  );
}

/**
 * The trip back to the base: the last stop must leave time to get there before the day window
 * closes (a little later after a dinner: latestReturn), and a day that states its trip back
 * (returnTravelMin) must state it correctly.
 */
// Decision: the last stop is the last one whose place is known, as in the scheduler; a plan with
// an unknown place already has an UNKNOWN_PLACE error. A last stop outside the window itself
// already has OUTSIDE_DAY_WINDOW, so the trip back is only checked for one inside it.
export function checkReturn(day: DayFacts, ctx: PlannerContext): Violation[] {
  const last = lastKnownStop(day, ctx);
  const origin = day.origin;
  if (!origin || !day.anchor) return [];
  const returnMin = last ? travelMinutes(last.place, origin) : 0;
  const out: Violation[] = [];
  const claimed = day.plan.returnTravelMin;
  if (claimed !== undefined && claimed !== returnMin) {
    const says = isMinuteCount(claimed, MAX_TRAVEL_MINUTES)
      ? `lists ${formatDuration(claimed)} for the trip back to ${day.anchor.name}`
      : "has a trip back that is not a valid number of minutes";
    const detail = `${dayTitle(day.index)} ${says}, but it takes ${formatDuration(returnMin)}.`;
    out.push(makeViolation("WRONG_TRAVEL", detail, { day: day.index }));
  }
  if (!last || !hasValidTimes(last.stop)) return out;
  const { start, end } = day.window;
  const deadline = latestReturn(end, last.stop.role);
  if (last.stop.start < start || last.stop.end > end || last.stop.end + returnMin <= deadline) {
    return out;
  }
  const name = last.place.name;
  const back = clockText(last.stop.end + returnMin);
  const after = last.stop.role === "dinner" ? ", the latest return after dinner" : "";
  const detail = `${name} ends at ${clockText(last.stop.end)}, and the trip back to the ${day.anchor.name} base takes ${formatDuration(returnMin)}, so the day would end at ${back}, after ${clockText(deadline)}${after}.`;
  const target = { day: day.index, stopIndex: last.index, placeId: last.place.id };
  out.push(makeViolation("OUTSIDE_DAY_WINDOW", detail, target));
  return out;
}

function lastKnownStop(
  day: DayFacts,
  ctx: PlannerContext,
): { stop: Stop; place: Place; index: number } | null {
  for (let index = day.plan.stops.length - 1; index >= 0; index--) {
    const stop = day.plan.stops[index] as Stop;
    const place = ctx.placesById.get(stop.placeId);
    if (place) return { stop, place, index };
  }
  return null;
}
