import { compareText } from "./anchors";
import { PACE } from "./config";
import { sharesLocation, withinBudget } from "./constraints";
import type { DayWalk } from "./dayBuilder";
import { breakingStarts, longestWait, noNewBreaks } from "./dayShape";
import { MEAL_WAIT_MAX_MIN } from "./planPolicy";
import type { PoolCache } from "./pools";
import { type ScheduledDay, scheduleDay } from "./schedule";
import { scorePlace } from "./score";
import type { Place } from "./types";
import { isError } from "./violations";

// A day the walk left with meals and no visit: a Milan day at budget 1 that is a 12:00 lunch and
// nothing else, while an arcade in the middle of town stays unused. It gets one visit: a visit
// another day of the base can spare (that day keeps at least one), or else one open-access public
// space of the base city, as tripRescue.ts gives an empty day. The visit is inserted where it
// keeps every stop in its role, adds no error, no new day-rule break, and no wait over
// MEAL_WAIT_MAX_MIN (or over the longest the day already had), with the shortest wait winning.

/** Adds one visit, in place, to a day that has stops but no visit. */
// Decision: in every attempt, not only the rescue ones. The day is not empty, so the attempts
// that spread a thin base over lower visit caps would cut every other day to one visit to find
// this one; a borrowed visit or a free public space costs the trip far less. A public space may
// be over the budget (the Galleria's shops are, walking through it is free); the plan says so.
export function addVisit(day: DayWalk, walks: readonly DayWalk[], pools: PoolCache): void {
  const added = borrowVisit(day, walks) ?? publicSpaceVisit(day, pools);
  if (!added) return;
  day.ids.splice(0, day.ids.length, ...added.ids);
  day.score = Math.round((day.score + added.score) * 1e6) / 1e6;
  (day.input.used as Set<string>).add(added.id);
}

/** True when the timed day has at least one stop and no visit. */
export function isVisitless(walk: DayWalk): boolean {
  return walk.ids.length > 0 && timed(walk, walk.ids).stops.every((s) => s.role !== "visit");
}

function timed(walk: DayWalk, ids: readonly string[]): ScheduledDay {
  const { input } = walk;
  return scheduleDay(ids, input.date, input.anchor, input.request, input.ctx, input.transferMin);
}

interface Added {
  id: string;
  ids: string[];
  score: number;
}

/** A visit moved over from a day of the same base that keeps at least one visit without it. */
function borrowVisit(day: DayWalk, walks: readonly DayWalk[]): Added | null {
  const mustInclude = day.input.request.mustInclude;
  for (const donor of walks) {
    if (donor === day || donor.input.anchor.id !== day.input.anchor.id) continue;
    const before = timed(donor, donor.ids);
    const visits = before.stops.filter((stop) => stop.role === "visit");
    if (visits.length < 2) continue;
    for (const stop of [...visits].reverse()) {
      if (mustInclude.includes(stop.placeId)) continue;
      const rest = donor.ids.filter((id) => id !== stop.placeId);
      const ids = insertVisit(day, stop.placeId);
      if (!ids || !keepsShape(donor, before, rest)) continue;
      donor.ids.splice(0, donor.ids.length, ...rest);
      return { id: stop.placeId, ids, score: 0 };
    }
  }
  return null;
}

/**
 * One unused open-access place of the base city: within the budget first (the pool's), then the
 * best score.
 */
function publicSpaceVisit(day: DayWalk, pools: PoolCache): Added | null {
  const { anchor, request, ctx, used, pool } = day.input;
  const score = (place: Place) => scorePlace(place, request);
  const open = pool.filter((place) => place.hoursConfidence === "open_access");
  const overBudget = (place: Place) => (withinBudget(place, request.maxPriceLevel) ? 0 : 1);
  const extras = [...open, ...pools.openAccessExtras(anchor.id)]
    .filter((place) => place.city === anchor.name && !used.has(place.id))
    .filter((place) => ![...used].some((id) => twin(ctx.placesById.get(id), place)))
    .sort(
      (a, b) => overBudget(a) - overBudget(b) || score(b) - score(a) || compareText(a.id, b.id),
    );
  for (const place of extras) {
    const ids = insertVisit(day, place.id);
    if (ids) return { id: place.id, ids, score: score(place) };
  }
  return null;
}

function twin(placed: Place | undefined, place: Place): boolean {
  return placed !== undefined && sharesLocation(placed, place);
}

/** The day's ids with `id` inserted as a visit where it fits best, or null. */
function insertVisit(day: DayWalk, id: string): string[] | null {
  const before = timed(day, day.ids);
  let best: { ids: string[]; wait: number } | null = null;
  for (let at = 0; at <= day.ids.length; at++) {
    const ids = [...day.ids.slice(0, at), id, ...day.ids.slice(at)];
    const after = timed(day, ids);
    if (after.stops[at]?.role !== "visit" || !keepsShape(day, before, ids, after)) continue;
    const wait = longestWait(after.stops, dayStart(day));
    if (best === null || wait < best.wait) best = { ids, wait };
  }
  return best?.ids ?? null;
}

/**
 * True when `ids` time cleanly with every stop of `before` in the same role, no new day-rule
 * break, and no wait over MEAL_WAIT_MAX_MIN or the longest `before` had.
 */
function keepsShape(
  walk: DayWalk,
  before: ScheduledDay,
  ids: readonly string[],
  after: ScheduledDay = timed(walk, ids),
): boolean {
  if (after.violations.some(isError)) return false;
  const roles = new Map(before.stops.map((stop) => [stop.placeId, stop.role]));
  const moved = after.stops.some((s) => roles.has(s.placeId) && roles.get(s.placeId) !== s.role);
  if (moved) return false;
  const { ctx, date } = walk.input;
  const places = (day: ScheduledDay) =>
    day.stops.map((s) => ctx.placesById.get(s.placeId) as Place);
  const breaking = breakingStarts(before.stops, places(before), date);
  if (!noNewBreaks(breakingStarts(after.stops, places(after), date), breaking)) return false;
  const cap = Math.max(longestWait(before.stops, dayStart(walk)), MEAL_WAIT_MAX_MIN);
  return longestWait(after.stops, dayStart(walk)) <= cap;
}

/** The start of the day window, after any transfer. */
function dayStart(walk: DayWalk): number {
  return PACE[walk.input.request.pace].dayStart + walk.input.transferMin;
}
