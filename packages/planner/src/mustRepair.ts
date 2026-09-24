import { transferMinutes } from "./anchors";
import type { PlannerContext } from "./context";
import { mayVisit } from "./dayLimits";
import { wantedMustIncludes } from "./planAnchors";
import { scheduleDay } from "./schedule";
import { isError } from "./scheduleChecks";
import type { TripDraft } from "./tripBuilder";
import type { Stop, TripRequest, Violation } from "./types";

// A repair pass after the greedy walk. The walk places must-include places as it goes and can
// still fill a gap with an ordinary stop that a must-include needed later. For every must-include
// left out, this tries each day at its base and each position in that day, removing only
// ordinary stops until the day times cleanly. It never removes a must-include and never
// reorders the stops it keeps.

/** The draft with as many missing must-includes inserted as possible. Pure. */
export function repairMustIncludes(
  draft: TripDraft,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
): TripDraft {
  const wanted = wantedMustIncludes(request, ctx);
  const days = draft.days.map((ids) => [...ids]);
  for (const id of wanted) {
    if (days.some((ids) => ids.includes(id))) continue;
    const base = ctx.anchorIdByPlaceId.get(id);
    for (let index = 0; index < days.length; index++) {
      if (draft.anchorIds[index] !== base) continue;
      const repaired = insertInto(days[index] ?? [], id, index, draft, request, ctx, dates, wanted);
      if (repaired) {
        days[index] = repaired;
        break;
      }
    }
  }
  return { ...draft, days };
}

/** The day's ids with `id` inserted at the first position that can be made to time cleanly. */
function insertInto(
  ids: readonly string[],
  id: string,
  index: number,
  draft: TripDraft,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  wanted: readonly string[],
): string[] | null {
  const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
  const date = dates[index];
  if (!anchor || date === undefined) return null;
  const previous = index === 0 ? undefined : ctx.anchorById.get(draft.anchorIds[index - 1] ?? "");
  const transferMin = previous ? transferMinutes(previous, anchor) : 0;
  const time = (order: readonly string[]) =>
    scheduleDay(order, date, anchor, request, ctx, transferMin);
  for (let position = 0; position <= ids.length; position++) {
    let order = [...ids.slice(0, position), id, ...ids.slice(position)];
    // Each round removes one ordinary stop or ends, so this runs at most ids.length times.
    for (;;) {
      const { stops, violations } = time(order);
      const firstBad = firstProblem(stops, violations, ctx, wanted);
      if (firstBad === null) return order;
      const drop = ordinaryAtOrBefore(order, firstBad, wanted);
      if (drop === null) break;
      order = order.filter((_, at) => at !== drop);
    }
  }
  return null;
}

/**
 * The index of the first stop with an error, or of an ordinary restaurant timed as a visit (the
 * planner never makes one), or null when the day is clean.
 */
function firstProblem(
  stops: readonly Stop[],
  violations: readonly Violation[],
  ctx: PlannerContext,
  wanted: readonly string[],
): number | null {
  let first: number | null = null;
  for (const violation of violations) {
    if (!isError(violation)) continue;
    const at = violation.stopIndex ?? 0;
    if (first === null || at < first) first = at;
  }
  stops.forEach((stop, at) => {
    const place = ctx.placesById.get(stop.placeId);
    if (!place || stop.role !== "visit" || mayVisit(place, wanted)) return;
    if (first === null || at < first) first = at;
  });
  return first;
}

/** The ordinary (not must-include) stop nearest before or at `at`, or null when there is none. */
function ordinaryAtOrBefore(
  order: readonly string[],
  at: number,
  wanted: readonly string[],
): number | null {
  for (let index = Math.min(at, order.length - 1); index >= 0; index--) {
    if (!wanted.includes(order[index] ?? "")) return index;
  }
  // Nothing ordinary before the problem: remove the first ordinary stop after it instead, since
  // a later ordinary stop can still cause a visit-cap error reported at an earlier index.
  for (let index = at + 1; index < order.length; index++) {
    if (!wanted.includes(order[index] ?? "")) return index;
  }
  return null;
}
