import { transferMinutes } from "./anchors";
import { sharesLocation } from "./constraints";
import type { PlannerContext } from "./context";
import { mayVisit } from "./dayLimits";
import { closedForHoliday, dayRuleBreaks } from "./dayRules";
import { wantedMustIncludes } from "./planAnchors";
import { scheduleDay } from "./schedule";
import type { TripDraft } from "./tripBuilder";
import type { Stop, TripRequest, Violation } from "./types";
import { isError } from "./violations";

// A repair pass after the greedy walk. The walk places must-include places as it goes and can
// still fill a gap with an ordinary stop that a must-include needed later. For every must-include
// left out, this tries each day at its base and each position in that day, removing only
// ordinary stops until the day times cleanly. It never removes a must-include and never
// reorders the stops it keeps. It checks the hard rules only (scheduleDay), not the day rules,
// so a must-include the walk's preferences kept out still gets in wherever it validly fits.

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
    if (days.some((ids) => ids.includes(id)) || twinIsPlaced(id, days, ctx)) continue;
    const base = ctx.anchorIdByPlaceId.get(id);
    for (const index of daysToTry(id, days.length, dates, ctx)) {
      if (draft.anchorIds[index] !== base) continue;
      const repaired = insertInto(
        { ids: days[index] ?? [], id, index, draft, dates, wanted },
        request,
        ctx,
      );
      if (repaired) {
        days[index] = repaired;
        break;
      }
    }
  }
  return { ...draft, days };
}

/** Day indexes in trip order, except that a holiday the place closes for comes last. */
function daysToTry(id: string, count: number, dates: readonly string[], ctx: PlannerContext) {
  const place = ctx.placesById.get(id);
  const holiday = (index: number) =>
    place !== undefined && closedForHoliday(place, dates[index] ?? "") ? 1 : 0;
  return Array.from({ length: count }, (_, index) => index).sort((a, b) => holiday(a) - holiday(b));
}

/** True when a place sharing a spot with `id` is already in the trip: the first one keeps it. */
function twinIsPlaced(id: string, days: readonly string[][], ctx: PlannerContext): boolean {
  const place = ctx.placesById.get(id);
  if (!place) return false;
  return days.some((ids) =>
    ids.some((other) => {
      const placed = ctx.placesById.get(other);
      return placed !== undefined && sharesLocation(place, placed);
    }),
  );
}

/** One insertion to try: must-include `id` into day `index` of the draft. */
interface Insertion {
  ids: readonly string[]; // the day's current ids
  id: string; // the must-include to insert
  index: number; // the day
  draft: TripDraft;
  dates: readonly string[];
  wanted: readonly string[]; // every must-include: never removed to make room
}

/**
 * The day's ids with the must-include inserted where it can be made to time cleanly, or null
 * when no position can. Of the positions that work, the best is one where the must-include keeps
 * the day rules as an ordinary stop would (an outing by noon), then the one that removes the
 * fewest stops, then the earliest.
 */
// Decision: fewest removals, not the first position that works. From the start of the day, a
// requested cicchetti crawl (dinner at 19:00) went first and every morning stop was removed to
// make room, leaving a Venice day with nothing before 19:00. Early positions still win ties,
// since they keep the rest of the day's order and suit outings, which belong in the morning. At
// each position the pass removes the ordinary stop nearest before the first problem, since that
// is the stop whose time the must-include most likely needs.
function insertInto(
  insertion: Insertion,
  request: TripRequest,
  ctx: PlannerContext,
): string[] | null {
  const { ids, id, index, draft, dates, wanted } = insertion;
  const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
  const date = dates[index];
  if (!anchor || date === undefined) return null;
  const previous = index === 0 ? undefined : ctx.anchorById.get(draft.anchorIds[index - 1] ?? "");
  const transferMin = previous ? transferMinutes(previous, anchor) : 0;
  const time = (order: readonly string[]) =>
    scheduleDay(order, date, anchor, request, ctx, transferMin);
  let best: { order: string[]; rank: number } | null = null;
  for (let position = 0; position <= ids.length; position++) {
    let order = [...ids.slice(0, position), id, ...ids.slice(position)];
    // Each round removes one ordinary stop or ends, so this runs at most ids.length times.
    for (;;) {
      const { stops, violations } = time(order);
      const firstBad = firstProblem({ stops, violations }, date, ctx, wanted);
      if (firstBad === null) {
        const breaks = mustBreaksRule(stops, order.indexOf(id), date, ctx) ? 1 : 0;
        const rank = breaks * 1000 + (ids.length + 1 - order.length); // then the earliest
        if (best === null || rank < best.rank) best = { order, rank };
        break;
      }
      const drop = ordinaryAtOrBefore(order, firstBad, wanted);
      if (drop === null) break;
      order = order.filter((_, at) => at !== drop);
    }
  }
  return best?.order ?? null;
}

/**
 * The index of the first stop with an error, of an ordinary meal place timed as a visit (the
 * planner never makes one), or of a stop that breaks a day rule (dayRules.ts: a meal place
 * visited before the meal it could have been, a park pushed past sunset), or null when the day
 * is clean.
 */
// Decision: the repair also keeps the day rules. Inserting a must-include pushes the stops after
// it later, and a walk in the porticoes planned for 15:00 must not end up at 18:05 in January.
function firstProblem(
  timed: { stops: readonly Stop[]; violations: readonly Violation[] },
  date: string,
  ctx: PlannerContext,
  wanted: readonly string[],
): number | null {
  const { stops, violations } = timed;
  const places = stops
    .map((stop) => ctx.placesById.get(stop.placeId))
    .filter((p) => p !== undefined);
  const problems = dayRuleBreaks(stops, places, date, wanted);
  for (const violation of violations) {
    if (isError(violation)) problems.push(violation.stopIndex ?? 0);
  }
  stops.forEach((stop, at) => {
    const place = places[at];
    if (stop.role === "visit" && place && !mayVisit(place, wanted)) problems.push(at);
  });
  return problems.length === 0 ? null : Math.min(...problems);
}

/** True when the stop at `at` breaks a day rule judged as an ordinary stop (dayRules.ts). */
function mustBreaksRule(
  stops: readonly Stop[],
  at: number,
  date: string,
  ctx: PlannerContext,
): boolean {
  const places = stops
    .map((stop) => ctx.placesById.get(stop.placeId))
    .filter((p) => p !== undefined);
  return dayRuleBreaks(stops, places, date, []).includes(at);
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
