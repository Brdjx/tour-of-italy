import { transferMinutes } from "./anchors";
import { PACE } from "./config";
import type { PlannerContext } from "./context";
import { breakingStarts, longestWait, mealsOf, noNewBreaks } from "./dayShape";
import { MAX_IDLE_MIN } from "./planPolicy";
import { scheduleDay } from "./schedule";
import type { TripDraft } from "./tripBuilder";
import type { Place, StopRole, TripRequest } from "./types";
import { isError } from "./violations";

// A last polish of each day: the same stops in an order that travels less. The greedy walk picks
// stops by time and score, so it can cross a city twice (Testaccio, then Pigneto, then Eataly
// back next to Testaccio). This pass tries 2-opt moves (reverse one stretch of the day) and keeps
// a move only when the day still times with no error, every stop keeps its role, no meal is lost
// (an outing can stop covering lunch when it moves), no stop newly breaks a day rule (a
// must-include included), the day starts no later and ends no later, no wait before a stop other
// than dinner grows past MAX_IDLE_MIN (or past the longest the day already had), and the total
// travel (the trip back included) goes down. Less travel inside the same span of the day means
// more free time, but only when the time saved is not spent waiting for a museum to open.

/** At most this many improving moves per day; each saves at least 5 minutes of travel. */
const MAX_MOVES = 50;

/** The draft with each day's order shortened where that keeps every rule. Pure. */
export function shortenRoutes(
  draft: TripDraft,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
): TripDraft {
  const days = draft.days.map((ids, index) => shortenDay(ids, index, draft, request, ctx, dates));
  return { ...draft, days };
}

/** How a timed order of a day measures up. */
interface Measured {
  ids: string[];
  clean: boolean; // scheduleDay reports no error
  travel: number; // every leg plus the trip back to the base
  firstStart: number; // when the first stop starts
  dayEnd: number; // back at the base
  roles: Map<string, StopRole>;
  meals: number; // lunch and dinner, each counted when a stop seats it or an outing covers it
  breaking: Map<string, number>; // start of each stop breaking a day rule, must-includes too
  wait: number; // the longest wait before a stop other than dinner (longestWait)
}

function shortenDay(
  ids: readonly string[],
  index: number,
  draft: TripDraft,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
): string[] {
  const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
  const date = dates[index];
  if (!anchor || date === undefined || ids.length < 3) return [...ids];
  const previous = index === 0 ? undefined : ctx.anchorById.get(draft.anchorIds[index - 1] ?? "");
  const transferMin = previous ? transferMinutes(previous, anchor) : 0;
  const measure = (order: string[]): Measured => {
    const day = scheduleDay(order, date, anchor, request, ctx, transferMin);
    const places = order.map((id) => ctx.placesById.get(id)).filter((p): p is Place => !!p);
    const last = day.stops.at(-1);
    let travel = day.returnTravelMin;
    for (const stop of day.stops) travel += stop.travelFromPrevMin;
    return {
      ids: order,
      clean: !day.violations.some(isError),
      travel,
      firstStart: day.stops[0]?.start ?? 0,
      dayEnd: (last?.end ?? 0) + day.returnTravelMin,
      roles: new Map(day.stops.map((stop) => [stop.placeId, stop.role])),
      meals: mealsOf(day.stops, places).length,
      breaking: breakingStarts(day.stops, places, date),
      wait: longestWait(day.stops, PACE[request.pace].dayStart + transferMin),
    };
  };
  let current = measure([...ids]);
  if (!current.clean) return [...ids]; // the repair and clean-up steps own broken days
  for (let move = 0; move < MAX_MOVES; move++) {
    const better = firstImprovement(current, measure);
    if (!better) break;
    current = better;
  }
  return current.ids;
}

/** The first 2-opt reversal, in a fixed order, that improves the day; null when none does. */
function firstImprovement(
  current: Measured,
  measure: (order: string[]) => Measured,
): Measured | null {
  const n = current.ids.length;
  for (let from = 0; from < n - 1; from++) {
    for (let to = from + 1; to < n; to++) {
      const order = [
        ...current.ids.slice(0, from),
        ...current.ids.slice(from, to + 1).reverse(),
        ...current.ids.slice(to + 1),
      ];
      const candidate = measure(order);
      if (improves(candidate, current)) return candidate;
    }
  }
  return null;
}

/**
 * True when the candidate keeps every rule and role, fits the same span, waits no longer, and
 * travels less.
 */
// Decision: the wait limit is MAX_IDLE_MIN, the walk's own "can start now". Without it, 482 of
// 32,805 days in a grid sweep gained an hour or more of idling (to 90 minutes or more) to save
// a few minutes of walking: Rialto at 08:35, then nothing until lunch at 12:00.
function improves(candidate: Measured, current: Measured): boolean {
  if (!candidate.clean || !noNewBreaks(candidate.breaking, current.breaking)) return false;
  if (candidate.meals < current.meals) return false;
  if (candidate.firstStart > current.firstStart || candidate.dayEnd > current.dayEnd) return false;
  if (candidate.wait > Math.max(current.wait, MAX_IDLE_MIN)) return false;
  if (candidate.travel >= current.travel) return false;
  for (const [id, role] of current.roles) {
    if (candidate.roles.get(id) !== role) return false;
  }
  return true;
}
