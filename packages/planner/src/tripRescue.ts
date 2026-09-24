import { compareText } from "./anchors";
import { withinBudget } from "./constraints";
import { type BuiltDay, buildDay, type DayWalk, startWalk, stepWalk } from "./dayBuilder";
import { dayRuleBreaks } from "./dayRules";
import type { PoolCache } from "./pools";
import { scheduleDay } from "./schedule";
import type { Stop } from "./types";
import { isError } from "./violations";

// The last resort for a day the turns left empty (a thin base: winter closures, a low budget,
// exclusions). Rather than drop the arrangement, and with it a base the traveler chose, the day
// borrows a stop another day of the base can spare, or visits one meal place, or takes one
// open-access public space, in that order. Each keeps the rest of the trip as it was.

/** Fills an empty day in place, trying each rescue in turn; leaves it empty if none works. */
// Decision: borrowing comes first because it keeps every place and the budget; a meal place as
// a visit (a market street in the morning) keeps the budget; the public space may cost more.
export function fillEmptyDay(empty: DayWalk, walks: readonly DayWalk[], pools: PoolCache): void {
  const rescued = borrowStop(empty, walks) ?? mealPlaceDay(empty) ?? publicSpaceDay(empty, pools);
  if (!rescued) return;
  empty.ids.push(...rescued.ids);
  empty.score = rescued.score;
  for (const id of rescued.ids) (empty.input.used as Set<string>).add(id);
}

/**
 * One stop moved from another day of the same base that keeps a stop without it, when it times
 * cleanly as the empty day's only stop and the other day still times cleanly (with the same
 * roles) without it. The other day's last stops are tried first, in three rounds: an ordinary
 * stop that keeps the day rules on the empty day, then a must-include, then any ordinary stop.
 */
// Decision: a must-include may move to the day that needs it. The walk puts a must-include on
// the first day it can start, so a Monday with nothing else open (Galleria Vittorio Emanuele,
// Milan at budget 1) was left empty and the plan left Milan for Florence. The base the traveler
// chose also outranks a preference: a lone gelato at 11:00 beats a day in another city.
function borrowStop(empty: DayWalk, walks: readonly DayWalk[]): BuiltDay | null {
  const { request } = empty.input;
  const must = (id: string) => request.mustInclude.includes(id);
  const rounds: ((id: string, alone: readonly Stop[]) => boolean)[] = [
    (id, alone) => !must(id) && !breaksDayRule(alone, empty, id),
    (id) => must(id),
    (id) => !must(id),
  ];
  for (const round of rounds) {
    const borrowed = borrowOne(empty, walks, round);
    if (borrowed) return borrowed;
  }
  return null;
}

/** The first stop `allowed` accepts that another day can spare, moved to the empty day. */
function borrowOne(
  empty: DayWalk,
  walks: readonly DayWalk[],
  allowed: (id: string, alone: readonly Stop[]) => boolean,
): BuiltDay | null {
  const { input } = empty;
  const time = (walk: DayWalk, ids: readonly string[]) =>
    scheduleDay(
      ids,
      walk.input.date,
      walk.input.anchor,
      input.request,
      input.ctx,
      walk.input.transferMin,
    );
  for (const donor of walks) {
    if (donor === empty || donor.input.anchor.id !== input.anchor.id || donor.ids.length < 2) {
      continue;
    }
    const before = time(donor, donor.ids).stops;
    for (const id of [...donor.ids].reverse()) {
      const alone = time(empty, [id]);
      if (alone.violations.some(isError) || !allowed(id, alone.stops)) continue;
      const rest = donor.ids.filter((other) => other !== id);
      const after = time(donor, rest);
      const sameRoles = after.stops.every(
        (stop) => before.find((old) => old.placeId === stop.placeId)?.role === stop.role,
      );
      if (after.violations.some(isError) || !sameRoles) continue;
      donor.ids.splice(donor.ids.indexOf(id), 1);
      return { ids: [id], score: 0 };
    }
  }
  return null;
}

/**
 * The day's first stop when an ordinary meal place may be a visit (a market street reached at
 * 10:00 cannot seat lunch until noon). Only that one stop, so the day is not built around it.
 */
function mealPlaceDay(empty: DayWalk): BuiltDay | null {
  const { request } = empty.input;
  // A meal place over the budget is only ever a meal (pools.ts), never this lone visit.
  const pool = empty.input.pool.filter(
    (place) => withinBudget(place, request.maxPriceLevel) || request.mustInclude.includes(place.id),
  );
  const walk = startWalk({ ...empty.input, pool, mealVisits: true, visitCap: 1 });
  return stepWalk(walk) ? { ids: walk.ids, score: walk.score } : null;
}

/**
 * The day walked again with ONE open-access public space of the base added to its pool (open
 * 07:00 to 23:00), ignoring budget and rating but never exclusions; the best such day wins.
 */
// Decision: one place, and only for a day that is still empty, so a starved day cannot take
// every public space and leave another day empty. If even that is empty, this arrangement is
// dropped and the planner tries other bases.
function publicSpaceDay(empty: DayWalk, pools: PoolCache): BuiltDay | null {
  const strict = empty.input.pool;
  let rescued: BuiltDay | null = null;
  for (const extra of pools.openAccessExtras(empty.input.anchor.id)) {
    const pool = [...strict, extra].sort((a, b) => compareText(a.id, b.id));
    const day = buildDay({ ...empty.input, pool });
    if (day.ids.length > 0 && (rescued === null || day.score > rescued.score)) rescued = day;
  }
  return rescued;
}

/** True when the lone stop breaks a day rule on the empty day (a museum moved onto 25 December). */
function breaksDayRule(stops: readonly Stop[], empty: DayWalk, id: string): boolean {
  const place = empty.input.ctx.placesById.get(id);
  if (!place) return true;
  return (
    dayRuleBreaks(stops, [place], empty.input.date, empty.input.request.mustInclude).length > 0
  );
}
