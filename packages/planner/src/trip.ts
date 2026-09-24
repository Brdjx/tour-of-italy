import { transferMinutes } from "./anchors";
import type { PlannerContext } from "./context";
import { ruleReason, withMealsCovered } from "./reasons";
import { type ScheduledDay, scheduleDay } from "./schedule";
import { addDays } from "./time";
import type { Anchor, DayPlan, Stop, TripRequest, Violation } from "./types";
import { isError, makeViolation } from "./violations";

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
    const stops = attachReasons(scheduled.stops, request, ctx, previous[index]?.stops ?? []);
    const returnTravelMin = scheduled.returnTravelMin;
    days.push({ date, anchorId: anchor.id, transferMin, stops, returnTravelMin });
    violations.push(...scheduled.violations);
    lastAnchor = anchor;
  });
  return { days, violations };
}

/**
 * Adds a reason to every stop. A stop keeps its reason from `previous` when the same place had
 * the same role there and the reason came from the AI; every other stop gets a fresh rule reason
 * (so "close to your previous stop" stays true after an edit).
 */
export function attachReasons(
  stops: readonly Stop[],
  request: TripRequest,
  ctx: PlannerContext,
  previous: readonly Stop[] = [],
): Stop[] {
  const seated = stops.flatMap((stop) => (stop.role === "visit" ? [] : [stop.role]));
  return stops.map((stop, index) => {
    const kept = previous.find((old) => old.placeId === stop.placeId && old.role === stop.role);
    if (kept?.reason !== undefined && kept.reasonSource === "ai") {
      return { ...stop, reason: kept.reason, reasonSource: "ai" };
    }
    const place = ctx.placesById.get(stop.placeId);
    if (!place) return { ...stop };
    const prevId = index === 0 ? undefined : stops[index - 1]?.placeId;
    const prevPlace = prevId === undefined ? null : (ctx.placesById.get(prevId) ?? null);
    const rule = ruleReason(place, request, stop.role, prevPlace);
    const reason = withMealsCovered(rule, place, stop, seated);
    return { ...stop, reason, reasonSource: "rule" };
  });
}

/**
 * The ids with every stop that scheduleDay reports as an error removed, repeated until the day
 * times cleanly. A last line of defense for planDeterministic: the greedy walk uses the same
 * timing as scheduleDay, so in practice nothing is ever removed (the sweep tests assert it).
 */
export function withoutErrorStops(
  ids: readonly string[],
  schedule: (ids: readonly string[]) => ScheduledDay,
): string[] {
  let current = [...ids];
  // Each round removes at least one id or returns, so this ends after ids.length + 1 rounds.
  for (;;) {
    const { stops, violations } = schedule(current);
    const bad = new Set<string>();
    for (const violation of violations) {
      if (!isError(violation)) continue;
      const stop = violation.stopIndex === undefined ? undefined : stops[violation.stopIndex];
      bad.add(stop?.placeId ?? violation.placeId ?? "");
    }
    const next = current.filter((id) => !bad.has(id));
    if (next.length === current.length) return current;
    current = next;
  }
}
