import { dayOrigin, transferMinutes } from "./anchors";
import { PACE } from "./config";
import type { PlannerContext } from "./context";
import { type DayWalk, startWalk, stepWalk } from "./dayBuilder";
import { fitsEmptyDay } from "./dayLimits";
import { closedForHoliday } from "./dayRules";
import { type Arrangement, wantedMustIncludes } from "./planAnchors";
import { PoolCache } from "./pools";
import type { BuildOptions, TripDraft } from "./tripBuilder";
import { chancesElsewhere, clockOf } from "./tripChances";
import { fillEmptyDay } from "./tripRescue";
import type { TripRequest } from "./types";
import { addVisit, isVisitless } from "./visitRescue";

// One trip for one arrangement of bases: the days are walked in turns (dayBuilder.ts), sharing
// one set of used places, so no place appears twice and every day gets its share of the best
// places and of the meal places.

/**
 * One trip for one arrangement, or null when some day cannot hold a single stop. The days are
 * walked in turns (nextTurn) until no day can take another stop. A day that stops only because a
 * meal place it could use is held for another day with no meal yet waits instead of finishing,
 * and gets another turn after any other day's pick or finish, which may release the hold.
 */
// Decision: waiting, not finishing. A held dinner place is released as soon as the day holding
// it eats or passes its last chance, but a finished day never took another turn: day 3 of a
// Venice trip ended at 15:55 with lunch only while Osteria da Rioba stayed free for dinner. The
// loop still ends: every turn adds a stop, finishes a day, or parks a waiting day until the next
// pick or finish, and a waiting day has eaten, so it never holds a place for another.
// Decision: turns instead of filling day 1, then day 2, then day 3. Filled in order, day 1 took
// the best of everything (7 stops and both meals) and day 3 got the leftovers (3 stops, often no
// meal). In turns, each day's first pick is the best place still open that morning, meal places
// are shared out as each day reaches lunch, and the headline sights spread over the trip.
export function buildTrip(
  arrangement: Arrangement,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  options: BuildOptions = { visitCap: PACE[request.pace].maxVisits, rescue: true },
  pools: PoolCache = new PoolCache(request, ctx),
): TripDraft | null {
  const used = new Set<string>();
  const pending = new Set(wantedMustIncludes(request, ctx));
  const fitsOn = mustIncludeDays(arrangement, request, ctx, dates, pending);
  const finished = new Set<number>();
  const walks: DayWalk[] = [];
  const otherChances = (index: number) => (id: string) =>
    (fitsOn.get(id) ?? []).filter((day) => day !== index && !finished.has(day)).length;
  for (let index = 0; index < arrangement.length; index++) {
    const day = dayInput(arrangement, index, request, ctx, dates);
    if (!day) return null;
    const pool = pools.strict(day.anchor.id).filter((place) => {
      const elsewhere = pending.has(place.id) && !fitsOn.get(place.id)?.includes(index);
      return !(elsewhere && closedForHoliday(place, day.date)); // see mustIncludeDays
    });
    const chances = {
      otherChances: otherChances(index),
      ...chancesElsewhere({ index, arrangement, walks, finished }),
    };
    const shared = { used, obligations: pending, ...chances };
    walks.push(startWalk({ ...day, ...shared, pool, visitCap: options.visitCap }));
  }
  const waiting = new Set<number>();
  const resting = () => new Set([...finished, ...waiting]);
  for (let turn = nextTurn(walks, resting()); turn !== null; turn = nextTurn(walks, resting())) {
    const walk = walks[turn] as DayWalk;
    const pick = stepWalk(walk);
    if (pick) {
      used.add(pick.place.id);
      pending.delete(pick.place.id);
    } else if (walk.heldBack) waiting.add(turn);
    else finished.add(turn);
    // Any pick or finished day can release a hold (the holder ate, moved on, or stopped).
    if (pick || finished.has(turn)) waiting.clear();
  }
  return finishTrip(arrangement, walks, options.rescue, pools);
}

/**
 * The unfinished day whose clock is earliest (its last stop ended first), then the one with the
 * fewest meals, then the earliest day; null when every day is finished.
 */
// Decision: turns by clock rather than by number of stops, so the days fill their mornings,
// middays, and evenings together. By count, a day of short stops took seven while a day with the
// Vatican and Trastevere looked starved at five; by clock, every day is about as busy (measured
// busy time within 15% across days in every base). Fewer meals breaks a tie so that where meal
// places are scarce each day gets one before any day gets a second.
function nextTurn(walks: readonly DayWalk[], finished: ReadonlySet<number>): number | null {
  let next: number | null = null;
  const meals = (walk: DayWalk) => walk.state.cursor.mealsTaken.length;
  walks.forEach((walk, index) => {
    if (finished.has(index)) return;
    const best = next === null ? undefined : (walks[next] as DayWalk);
    const order = best ? clockOf(walk) - clockOf(best) || meals(walk) - meals(best) : -1;
    if (order < 0) next = index;
  });
  return next;
}

/**
 * The trip from its finished walks, rescuing empty days if allowed (null if one stays empty) and
 * giving a day with meals but no visit one visit where it can (visitRescue.ts).
 */
function finishTrip(
  arrangement: Arrangement,
  walks: readonly DayWalk[],
  rescue: boolean,
  pools: PoolCache,
): TripDraft | null {
  if (rescue) {
    for (const walk of walks) if (walk.ids.length === 0) fillEmptyDay(walk, walks, pools);
  }
  if (walks.some((walk) => walk.ids.length === 0)) return null;
  for (const walk of walks) if (isVisitless(walk)) addVisit(walk, walks, pools);
  let score = 0;
  for (const walk of walks) score += walk.score;
  const days = walks.map((walk) => [...walk.ids]);
  return { anchorIds: [...arrangement], days, score: Math.round(score * 1e6) / 1e6 };
}

/** The fixed part of day `index`'s input: date, base, transfer, request; null if unknown. */
function dayInput(
  arrangement: Arrangement,
  index: number,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
) {
  const anchor = ctx.anchorById.get(arrangement[index] ?? "");
  const date = dates[index];
  if (!anchor || date === undefined) return null;
  const transferMin = transferInto(arrangement, index, ctx);
  return { date, anchor, transferMin, request, ctx };
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
