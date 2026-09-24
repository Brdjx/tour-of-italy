import { compareText, dayOrigin, transferMinutes } from "./anchors";
import type { PlannerContext } from "./context";
import { buildDay, type DayWalk, startWalk, stepWalk } from "./dayBuilder";
import { fitsEmptyDay } from "./dayLimits";
import { closedForHoliday } from "./dayRules";
import { type Arrangement, wantedMustIncludes } from "./planAnchors";
import { PoolCache } from "./pools";
import { timeStep } from "./schedule";
import type { TripDraft } from "./tripBuilder";
import type { Place, TripRequest } from "./types";

// One trip for one arrangement of bases: the days are walked in turns (dayBuilder.ts), sharing
// one set of used places, so no place appears twice and every day gets its share of the best
// places and of the meal places.

/** A day with no meal yet keeps a claim on its last meal places while it has this many or fewer. */
const MEAL_RESERVE_MAX = 2;

/**
 * One trip for one arrangement, or null when some day cannot hold a single stop. The days are
 * walked in turns (nextTurn) until no day can take another stop. With `rescue`, a day the turns
 * left empty may take one public space (rescueEmptyDay).
 */
// Decision: turns instead of filling day 1, then day 2, then day 3. Filled in order, day 1 took
// the best of everything (7 stops and both meals) and day 3 got the leftovers. In turns, each
// day's first pick is the best place still open that morning, meal places are shared out as
// each day reaches lunch, and the headline sights spread over the trip. Measured: filling in
// order starves a day in 8 to 12 more trips in 100 (docs/planner.md).
export function buildTrip(
  arrangement: Arrangement,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  rescue = true,
  pools: PoolCache = new PoolCache(request, ctx),
): TripDraft | null {
  const used = new Set<string>();
  const pending = new Set(wantedMustIncludes(request, ctx));
  const fitsOn = mustIncludeDays(arrangement, request, ctx, dates, pending);
  const finished = new Set<number>();
  const walks: DayWalk[] = [];
  for (let index = 0; index < arrangement.length; index++) {
    const anchor = ctx.anchorById.get(arrangement[index] ?? "");
    const date = dates[index];
    if (!anchor || date === undefined) return null;
    const pool = pools.strict(anchor.id).filter((place) => {
      const elsewhere = pending.has(place.id) && !fitsOn.get(place.id)?.includes(index);
      return !(elsewhere && closedForHoliday(place, date)); // see mustIncludeDays
    });
    const transferMin = transferInto(arrangement, index, ctx);
    const others = () => otherDays(index, arrangement, walks, finished);
    const later = () => others().filter((walk) => walks.indexOf(walk) > index);
    const mealWanted = (place: Place) => wantedByMealless(place, others());
    const mealChances = (place: Place) => mealsElsewhere(place, others());
    const visitChances = (place: Place) => visitsOn(place, later());
    const chances = { mealWanted, mealChances, visitChances };
    const day = { date, anchor, transferMin, request, ctx, pool, used, ...chances };
    walks.push(startWalk({ ...day, obligations: pending }));
  }
  for (let turn = nextTurn(walks, finished); turn !== null; turn = nextTurn(walks, finished)) {
    const pick = stepWalk(walks[turn] as DayWalk);
    if (!pick) finished.add(turn);
    else {
      used.add(pick.place.id);
      pending.delete(pick.place.id);
    }
  }
  if (rescue) {
    for (const walk of walks) if (walk.ids.length === 0) rescueEmptyDay(walk, pools);
  }
  if (walks.some((walk) => walk.ids.length === 0)) return null;
  let score = 0;
  for (const walk of walks) score += walk.score;
  const days = walks.map((walk) => [...walk.ids]);
  return { anchorIds: [...arrangement], days, score: Math.round(score * 1e6) / 1e6 };
}

/** The unfinished day whose clock is earliest (its last stop ended first); null when none is. */
// Decision: turns by clock rather than by number of stops, so the days fill their mornings,
// middays, and evenings together. By count, a day of short stops took seven while a day with the
// Vatican and Trastevere looked starved at five. Ties go to the earlier day.
function nextTurn(walks: readonly DayWalk[], finished: ReadonlySet<number>): number | null {
  let next: number | null = null;
  walks.forEach((walk, index) => {
    if (finished.has(index)) return;
    const best = next === null ? undefined : (walks[next] as DayWalk);
    if (!best || walk.state.cursor.clock < best.state.cursor.clock) next = index;
  });
  return next;
}

/** The other unfinished days at the same base as day `index`. */
function otherDays(
  index: number,
  arrangement: Arrangement,
  walks: readonly DayWalk[],
  finished: ReadonlySet<number>,
): DayWalk[] {
  return walks.filter(
    (_, day) => day !== index && !finished.has(day) && arrangement[day] === arrangement[index],
  );
}

/**
 * True when one of the other days has no meal yet, could still seat one at the place, and has at
 * most MEAL_RESERVE_MAX places left where it could. A day already fed then leaves the place alone
 * (dayBuilder.ts, savedForAnotherDay).
 */
// Decision: where meal places are scarce (Bologna and Milan have three or four for six meals), a
// fed day leaves the last ones to a day that has none. Without this, 2 more trips in 100 over a
// holiday ended with a starved day (docs/planner.md).
function wantedByMealless(place: Place, others: readonly DayWalk[]): boolean {
  return others.some((walk) => {
    if (walk.state.fed || !canSeat(walk, place)) return false;
    const left = walk.input.pool.filter((other) => !walk.input.used.has(other.id));
    return left.filter((other) => canSeat(walk, other)).length <= MEAL_RESERVE_MAX;
  });
}

/**
 * How many lunches and dinners the place could still serve on the other days: each meal a day
 * has not taken yet and the place could seat on its date (dayPicks.ts, leastFlexible).
 */
function mealsElsewhere(place: Place, others: readonly DayWalk[]): number {
  let count = 0;
  for (const walk of others) {
    const latest = walk.limits.get(place.id);
    for (const meal of ["lunch", "dinner"] as const) {
      if (latest?.[meal] !== undefined && !walk.state.cursor.mealsTaken.includes(meal)) count++;
    }
  }
  return count;
}

/**
 * How many of `days` could still start a visit to the place: its chances after this day, with
 * `days` the later unfinished days at the same base (dayPicks.ts, lastChance).
 */
// Decision: later days only. Counting every other day, day 2 and day 3 of a Rome trip each
// counted on the other for the Vatican Museums, both mornings went to sights open all week, and
// the Vatican was lost; the last day that can hold a place now takes it.
function visitsOn(place: Place, days: readonly DayWalk[]): number {
  let count = 0;
  for (const walk of days) {
    const latest = walk.limits.get(place.id)?.visit;
    const arrive = timeStep(place, walk.input.date, walk.state.cursor).arrive;
    if (latest !== undefined && arrive <= latest) count++;
  }
  return count;
}

/** True when the walk could still seat a lunch or dinner at the place today. */
function canSeat(walk: DayWalk, place: Place): boolean {
  const latest = walk.limits.get(place.id);
  const clock = walk.state.cursor.clock;
  return [latest?.lunch, latest?.dinner].some((last) => last !== undefined && last >= clock);
}

/**
 * A day the turns left empty (a thin base: winter closures, a low budget, exclusions), walked
 * again with ONE open-access public space of the base added to its pool (open 07:00 to 23:00),
 * ignoring budget and rating but never exclusions; the best such day wins.
 */
// Decision: one place, and only for a day that is still empty, so a starved day cannot take
// every public space. If even that is empty, the arrangement is dropped and the planner tries
// other bases. Measured on thin bases: without it, 3 more trips in 100 leave a chosen base.
function rescueEmptyDay(empty: DayWalk, pools: PoolCache): void {
  let rescued: { ids: string[]; score: number } | null = null;
  for (const extra of pools.openAccessExtras(empty.input.anchor.id)) {
    const pool = [...empty.input.pool, extra].sort((a, b) => compareText(a.id, b.id));
    const day = buildDay({ ...empty.input, pool });
    if (day.ids.length > 0 && (rescued === null || day.score > rescued.score)) rescued = day;
  }
  if (!rescued) return;
  empty.ids.push(...rescued.ids);
  empty.score = rescued.score;
  for (const id of rescued.ids) (empty.input.used as Set<string>).add(id);
}

/** The transfer into day `index` of an arrangement: 0 on day 1 and when the base stays. */
export function transferInto(arrangement: Arrangement, index: number, ctx: PlannerContext): number {
  const anchor = ctx.anchorById.get(arrangement[index] ?? "");
  const previous = index === 0 ? undefined : ctx.anchorById.get(arrangement[index - 1] ?? "");
  return anchor && previous ? transferMinutes(previous, anchor) : 0;
}

/**
 * For each must-include: the days at its base where it could be the only stop, leaving out a
 * holiday on which most museums close (closedForHoliday) when another of those days is not one.
 */
// Decision: the traveler's museum goes on an open day, not on 25 December. The walk took a
// must-include on whichever day reached it first, so 338 of 972 holiday trips put the Uffizi or
// the Colosseum on Christmas Day while the next day had it open. On the holiday day the place is
// left out of the pool (buildTrip); if every other day is full it still goes in, by the repair.
function mustIncludeDays(
  arrangement: Arrangement,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  pending: ReadonlySet<string>,
): Map<string, number[]> {
  const days = new Map<string, number[]>();
  for (const id of pending) {
    const place = ctx.placesById.get(id);
    const fits: number[] = [];
    arrangement.forEach((anchorId, index) => {
      const anchor = ctx.anchorById.get(anchorId);
      const date = dates[index];
      if (!place || !anchor || date === undefined) return;
      if (ctx.anchorIdByPlaceId.get(id) !== anchorId) return;
      const transferMin = transferInto(arrangement, index, ctx);
      const origin = dayOrigin(anchor, request);
      if (fitsEmptyDay(place, date, request.pace, transferMin, origin)) fits.push(index);
    });
    const open = fits.filter((index) => !place || !closedForHoliday(place, dates[index] ?? ""));
    days.set(id, open.length > 0 ? open : fits);
  }
  return days;
}
