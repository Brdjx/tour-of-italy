import { compareText } from "./anchors";
import { MEALS, PACE, TRAVEL } from "./config";
import { coversMeal, servesMeal, sharesLocation, withinBudget } from "./constraints";
import type { PlannerContext } from "./context";
import { dayRuleBreaks, inSatelliteArea } from "./dayRules";
import { wantedMustIncludes } from "./planAnchors";
import { EVENING_FROM } from "./planPolicy";
import { PoolCache } from "./pools";
import { type ScheduledDay, scheduleDay } from "./schedule";
import { scorePlace } from "./score";
import { tripDates } from "./time";
import type { DaySelection } from "./trip";
import type { TripDraft } from "./tripBuilder";
import { transferInto } from "./tripWalk";
import type { Anchor, Meal, Place, Stop, TripRequest } from "./types";
import { isError } from "./violations";

// The closing pass for meals. The walk shares meal places out as each day reaches a meal, but it
// judges each day's promise ("a dinner place is still free tonight") on its own, so another day
// can take the place a day was counting on, and the day ends with no dinner while an unused
// place could have seated it. For each day still missing lunch or dinner, this tries every
// unused meal place of the base at every position, and keeps the insertion that seats the meal
// with the shortest wait and leaves the rest of the day as it was: no error, every stop in the
// same role, no meal lost, no stop newly breaking a day rule, and the meal in the base city or
// in the area the day is already visiting. That first pass only adds. A second pass, for a day
// adding could not feed, gives up one ordinary visit for the meal (withMealForVisit). Neither
// pass reorders a stop or removes a must-include.
// Measured over the sweep (docs/planner.md): without it, 2 to 5 more days in 100 miss a meal.

/** A visit is given up for a meal only when the day keeps at least this many visits. */
const MIN_VISITS_KEPT = 2;
/** A swap may not make the day's longest wait longer than this, or than it already was. */
const SWAP_WAIT_MAX_MIN = 60;

/**
 * The draft with every missing meal that an unused meal place can seat added. Pure. With `only`,
 * just that day is filled: planDay (planDay.ts) re-plans one day of a trip whose other days are
 * fixed.
 */
export function fillMissingMeals(
  draft: TripDraft,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  pools: PoolCache,
  only?: number,
): TripDraft {
  const days = draft.days.map((ids) => [...ids]);
  const kept = wantedMustIncludes(request, ctx);
  const chosen = (index: number) => only === undefined || index === only;
  // Adding first on every day, then giving up a visit where adding could not seat the meal, so a
  // swap never takes the place another day could have added without losing anything.
  fillPass(draft, days, request, ctx, dates, pools, chosen, withMeal);
  fillPass(draft, days, request, ctx, dates, pools, chosen, (day, meal, candidates) =>
    withMealForVisit(day, meal, candidates, request, kept),
  );
  return { ...draft, days };
}

/** A lunch or dinner addMissingMeals added: the day, the place, and the meal it takes. */
export interface AddedMeal {
  day: number; // 0-based
  placeId: string;
  meal: Meal;
}

/** Which days addMissingMeals may add to, and which places it may add. */
export interface AddMealsOptions {
  only?: readonly number[]; // just these days (0-based); every day when absent
  allowed?: (place: Place) => boolean; // a place it may add; any of the fill's candidates when absent
}

/**
 * The trip with each missing lunch and dinner that an unused meal place can seat added, by the
 * meal fill's first pass alone (withMeal), and what it added. Pure. It only inserts: every stop
 * keeps its place in the order and its role, no meal is lost, no stop newly breaks a day rule and
 * the day stays free of scheduler errors; a day that already has one is left alone. The meal is
 * the rules planner's own choice (mealPlacesFor: a place of the day's base, not avoided, not in
 * the trip or at the same spot as a place in it, within the budget first, a meal place one level
 * over only when none within it fits), limited to `options.allowed`. A day none of whose places
 * can take the meal that date gets nothing (mealGaps calls that "none open"). Days are filled in
 * order, so a place added to one day is taken for the next.
 */
// Decision: the add pass only, never the swap. The model chose the day's visits; a meal may join
// them but not replace one. This is how the API completes an AI day (services/api/src/plan/
// mealAdd.ts): on the recorded evals it adds 10 meals to Sonnet 5's plans and 47 to Haiku 4.5's,
// and days missing a meal fall from 26% to 20% and from 72% to 24%. Giving up a visit too would
// take both to about 17%, by taking out places the model chose.
export function addMissingMeals(
  request: TripRequest,
  days: readonly DaySelection[],
  ctx: PlannerContext,
  options: AddMealsOptions = {},
): { days: DaySelection[]; added: AddedMeal[] } {
  const ids = days.map((day) => [...day.placeIds]);
  const draft: TripDraft = { anchorIds: days.map((day) => day.anchorId), days: ids, score: 0 };
  const dates = tripDates(request.startDate, days.length);
  const pools = new PoolCache(request, ctx);
  const allowed = options.allowed ?? (() => true);
  const chosen = (index: number) => options.only === undefined || options.only.includes(index);
  const added: AddedMeal[] = [];
  fillPass(draft, ids, request, ctx, dates, pools, chosen, (day, meal, candidates, index) => {
    const filled = withMeal(day, meal, candidates.filter(allowed));
    const placeId = filled?.find((id) => !day.ids.includes(id));
    if (placeId !== undefined) added.push({ day: index, placeId, meal });
    return filled;
  });
  return {
    days: days.map((day, index) => ({ anchorId: day.anchorId, placeIds: ids[index] as string[] })),
    added,
  };
}

/** Seats one meal on one day from the candidates, or null; the index is the day's. */
type MealPass = (
  day: DayToFill,
  meal: Meal,
  candidates: readonly Place[],
  index: number,
) => string[] | null;

/**
 * One pass over the chosen days of `days` (the draft's ids, changed in place): for each day and
 * each meal, the day as it now is and the unused meal places of its base, given to `pass`.
 */
function fillPass(
  draft: TripDraft,
  days: string[][],
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  pools: PoolCache,
  chosen: (index: number) => boolean,
  pass: MealPass,
): void {
  days.forEach((_, index) => {
    if (!chosen(index)) return;
    for (const meal of ["lunch", "dinner"] as const) {
      const day = dayToFill({ ...draft, days }, index, request, ctx, dates);
      if (!day) return;
      const candidates = mealPlacesFor(day.anchor, meal, days, request, ctx, pools);
      const filled = pass(day, meal, candidates, index);
      if (filled) days[index] = filled;
    }
  });
}

/**
 * When no meal place fits as an addition: the day's ids with one ordinary visit given up for the
 * meal, or null. Each visit that is not a must-include is tried, least valuable first
 * (scorePlace on the date), and the meal is seated in the day without it by the same test as
 * withMeal, judged against the day as it was: no error, every kept stop in its role, one more
 * meal, no stop newly breaking a day rule. The first candidate that fits this way wins, giving up
 * the least valuable visit, then with the shortest wait.
 */
// Decision: a meal outranks the day's weakest visit, but not a starved day or a new gap. The walk
// judges each day's meal promise on its own, so a day can take an evening sight counting on a
// dinner place another day then takes (Pigneto until 20:20, then no Rome dinner place left within
// reach). Adding cannot fix that day; giving up the sight that used the evening can. Measured on
// three seeds: days missing a meal -1.5 points (mixed), -4.6 (must), -1.3 (holiday); visits a day
// -0.02 (mixed), -0.05 (must); no starved day, no new wait over an hour, no must-include lost.
function withMealForVisit(
  day: DayToFill,
  meal: Meal,
  candidates: readonly Place[],
  request: TripRequest,
  kept: readonly string[],
): string[] | null {
  if (candidates.length === 0) return null;
  const before = day.time(day.ids);
  if (before.violations.some(isError)) return null;
  const places = placesOf(before, day.ctx);
  const meals = mealsOf(before.stops, places);
  if (meals.includes(meal)) return null;
  const breaking = breakingStarts(before.stops, places, day.date);
  const allowedWait = Math.max(longestWait(before.stops, day.dayStart), SWAP_WAIT_MAX_MIN);
  const value = (place: Place) => scorePlace(place, request, { date: day.date });
  const visits = before.stops.filter((stop) => stop.role === "visit").length;
  if (visits <= MIN_VISITS_KEPT) return null; // a day with one visit is most of a lost day
  const droppable = before.stops
    .map((stop, index) => ({ stop, index, place: places[index] as Place }))
    .filter(({ stop, place }) => stop.role === "visit" && !kept.includes(place.id))
    .sort((a, b) => value(a.place) - value(b.place) || b.index - a.index);
  for (const candidate of candidates) {
    let best: { ids: string[]; lost: number; wait: number } | null = null;
    for (const { index, place } of droppable) {
      const lost = value(place);
      if (best !== null && lost > best.lost) break;
      const rest = day.ids.filter((_, at) => at !== index);
      const restPlaces = places.filter((_, at) => at !== index);
      const timedRest = day.time(rest);
      if (timedRest.violations.some(isError)) continue;
      for (let at = 0; at <= rest.length; at++) {
        const previous = timedRest.stops[at - 1];
        if (previous && previous.end > MEALS[meal].latestStart) break;
        if (!onTheWay(candidate, restPlaces, at, day.anchor)) continue;
        const ids = [...rest.slice(0, at), candidate.id, ...rest.slice(at)];
        const after = day.time(ids);
        if (after.violations.some(isError) || after.stops[at]?.role !== meal) continue;
        if (!sameRoles(before, after, candidate.id)) continue;
        const afterPlaces = placesOf(after, day.ctx);
        if (mealsOf(after.stops, afterPlaces).length <= meals.length) continue;
        if (!noNewBreaks(breakingStarts(after.stops, afterPlaces, day.date), breaking)) continue;
        const wait = longestWait(after.stops, day.dayStart);
        if (wait > allowedWait) continue; // giving up a visit must not open a gap in the day
        if (best === null || lost < best.lost || (lost === best.lost && wait < best.wait)) {
          best = { ids, lost, wait };
        }
      }
    }
    if (best) return best.ids;
  }
  return null;
}

/** One day of the draft and how to time it. */
interface DayToFill {
  ids: readonly string[];
  date: string;
  dayStart: number; // the start of the day window, after any transfer
  anchor: Anchor;
  ctx: PlannerContext;
  time: (ids: readonly string[]) => ScheduledDay;
}

/** Day `index` of the draft, ready to time; null for an unknown base or a missing date. */
function dayToFill(
  draft: TripDraft,
  index: number,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
): DayToFill | null {
  const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
  const date = dates[index];
  if (!anchor || date === undefined) return null;
  const transferMin = transferInto(draft.anchorIds, index, ctx);
  const time = (ids: readonly string[]) =>
    scheduleDay(ids, date, anchor, request, ctx, transferMin);
  const dayStart = PACE[request.pace].dayStart + transferMin;
  return { ids: draft.days[index] ?? [], date, dayStart, anchor, ctx, time };
}

/**
 * Unused meal places of the base that serve the meal and share no spot with a place in the
 * trip: within the budget first (pools.ts adds one level over as a fallback), then the best
 * score, then id.
 */
function mealPlacesFor(
  anchor: Anchor,
  meal: Meal,
  days: readonly string[][],
  request: TripRequest,
  ctx: PlannerContext,
  pools: PoolCache,
): Place[] {
  const inTrip = days.flat().map((id) => ctx.placesById.get(id));
  const free = pools
    .strict(anchor.id)
    .filter(
      (place) =>
        servesMeal(place, meal) &&
        !inTrip.some((other) => other && (other.id === place.id || sharesLocation(other, place))),
    );
  const budget = (place: Place) => (withinBudget(place, request.maxPriceLevel) ? 0 : 1);
  const score = (place: Place) => scorePlace(place, request);
  return free.sort(
    (a, b) => budget(a) - budget(b) || score(b) - score(a) || compareText(a.id, b.id),
  );
}

/**
 * The day's ids with one of `candidates` seated as `meal`, or null when none fits cleanly. The
 * first candidate that fits wins, at its position with the shortest longest wait.
 */
// Decision: the shortest wait, not the first position. Tried from the start of the day, lunch at
// Via Drapperie became the first stop of a Bologna day: nothing from 09:30 to 12:00, then every
// morning sight in the afternoon. After the morning's last sight the same lunch waits 10 minutes.
// There is no cap on that wait: a cap cost more missed meals than it saved long waits.
function withMeal(day: DayToFill, meal: Meal, candidates: readonly Place[]): string[] | null {
  if (candidates.length === 0) return null;
  const before = day.time(day.ids);
  if (before.violations.some(isError)) return null; // the repair owns a broken day
  const places = placesOf(before, day.ctx);
  const meals = mealsOf(before.stops, places);
  if (meals.includes(meal)) return null;
  const breaking = breakingStarts(before.stops, places, day.date);
  for (const candidate of candidates) {
    let best: { ids: string[]; wait: number } | null = null;
    for (let at = 0; at <= day.ids.length; at++) {
      const previous = before.stops[at - 1];
      if (previous && previous.end > MEALS[meal].latestStart) break; // too late from here on
      if (!onTheWay(candidate, places, at, day.anchor)) continue;
      const ids = [...day.ids.slice(0, at), candidate.id, ...day.ids.slice(at)];
      const after = day.time(ids);
      if (after.violations.some(isError) || after.stops[at]?.role !== meal) continue;
      if (!sameRoles(before, after, candidate.id)) continue;
      const afterPlaces = placesOf(after, day.ctx);
      if (mealsOf(after.stops, afterPlaces).length <= meals.length) continue; // lost a covered one
      if (!noNewBreaks(breakingStarts(after.stops, afterPlaces, day.date), breaking)) continue;
      const wait = longestWait(after.stops, day.dayStart);
      if (best === null || wait < best.wait) best = { ids, wait };
    }
    if (best) return best.ids;
  }
  return null;
}

/** True when every stop of `before` keeps its role in `after`, which adds `added`. */
function sameRoles(before: ScheduledDay, after: ScheduledDay, added: string): boolean {
  const roles = new Map(before.stops.map((stop) => [stop.placeId, stop.role]));
  return after.stops.every(
    (stop) => stop.placeId === added || roles.get(stop.placeId) === stop.role,
  );
}

/**
 * True when a meal at position `at` keeps the day's one trip out of town in one piece: a meal in
 * the base city anywhere but between two out-of-town stops, or a meal out of town right after a
 * stop in the same area (lunch in Parma after the Parma tour, never between two Bologna sights).
 */
function onTheWay(place: Place, places: readonly Place[], at: number, anchor: Anchor): boolean {
  const away = (other: Place | undefined) => other !== undefined && other.city !== anchor.name;
  const before = places.slice(0, at);
  if (place.city === anchor.name) return !(away(before.at(-1)) && away(places[at]));
  return away(before.at(-1)) && inSatelliteArea(place, before, anchor);
}

/** The places of a timed day, in order. Every id in a draft is a known place. */
function placesOf(day: ScheduledDay, ctx: PlannerContext): Place[] {
  return day.stops.map((stop) => ctx.placesById.get(stop.placeId) as Place);
}

/**
 * The meals the day has: lunch and dinner, each when a stop takes that role or an outing is
 * under way through its window (coversMeal).
 */
function mealsOf(stops: readonly Stop[], places: readonly Place[]): Meal[] {
  return (["lunch", "dinner"] as const).filter((meal) =>
    stops.some((stop, index) => {
      const place = places[index];
      return (
        stop.role === meal || (place !== undefined && coversMeal(place, stop.start, stop.end, meal))
      );
    }),
  );
}

/**
 * The start of each stop of a timed day that breaks a day rule (dayRules.ts), judged as if none
 * were a must-include: the walk may place a must-include where the preferences would not, but
 * the fill must never push one there.
 */
function breakingStarts(
  stops: readonly Stop[],
  places: readonly Place[],
  date: string,
): Map<string, number> {
  const starts = new Map<string, number>();
  for (const index of dayRuleBreaks(stops, places, date, [])) {
    const stop = stops[index];
    if (stop) starts.set(stop.placeId, stop.start);
  }
  return starts;
}

/**
 * True when every stop breaking a rule after a change already broke one before and starts no
 * later. Per stop, not a count, so a change cannot trade one stop's break for another's.
 */
function noNewBreaks(after: ReadonlyMap<string, number>, before: ReadonlyMap<string, number>) {
  for (const [id, start] of after) {
    const was = before.get(id);
    if (was === undefined || start > was) return false;
  }
  return true;
}

/**
 * The longest wait in the day before a stop other than dinner that starts before EVENING_FROM:
 * minutes between arriving and starting. The first stop's wait counts from `dayStart`.
 */
// Decision: dinner and the evening are left out. A day that ends at 16:00 and meets again for
// dinner at 19:00 is the traveler resting at the hotel; two hours with nothing to do before lunch
// is a gap in the plan.
function longestWait(stops: readonly Stop[], dayStart: number): number {
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
