import {
  type Anchor,
  addDays,
  coversMeal,
  type DaySelection,
  type DaySlot,
  type FirstChoice,
  type Itinerary,
  isMealPlace,
  type Meal,
  openStatusOn,
  orderDay,
  PACE,
  type Place,
  type PlannerContext,
  type ScheduledDay,
  type Stop,
  scheduleDay,
  scheduleTrip,
  servesMeal,
  sharesLocation,
  type TripRequest,
  transferMinutes,
  type Violation,
  validateItinerary,
} from "@italy/planner";
import type { LlmSelection } from "../llm/client";
import type { Shortlist } from "./candidates";

// The tidy step: what code does to the model's answer before the check. The model picks each
// day's base and places, but code assigns every time, so the model cannot see when a place is
// closed or when a day runs out. Tidying keeps the model's choices and does only this:
//   1. drops a place closed all day on that day's date (a must-include only when the answer
//      also has it on a day it is open);
//   2. drops a place already in the trip, and an ordinary place at the same spot (or the same
//      experience) as one already in the trip or as a must-include, except that a day those
//      drops would empty keeps one of its places, and a day they would leave with meal places
//      only keeps one of its visits, and the day that had it first loses it;
//   3. puts a day whose order cannot be timed in an order the rules-only planner's day walk
//      finds for the same places (packages/planner/src/orderDay.ts);
//   4. drops a day's last ordinary visits until the pace's visit limit holds;
//   5. drops the ordinary visits a day's hours cannot hold, the last first, until it times cleanly;
//   6. puts each visit step 5 dropped back into the day's final order where the day holds it,
//      so a drop that another position makes needless is undone; a meal place dropped in step 4
//      or 5 goes back only as a lunch or dinner the day lacks, and a meal place the day's order
//      times as a visit moves to where it is a lunch or dinner the day lacks;
//   7. moves each offered place steps 1, 4 and 5 dropped for good to another day at its base
//      that is open for it and holds it the same way, the day with the fewest stops first.
// It never changes a base, never adds a place the answer does not have, never drops a meal the
// day needs, and keeps every must-include in the answer on one of its days. A day holding
// anything it cannot judge (an id not offered, a place of another base, an unknown base) is not
// reordered, trimmed, or given a place: the check reports it and the repair turn fixes it.

export type TidyRule =
  | "closed"
  | "duplicate"
  | "same_spot"
  | "over_visit_limit"
  | "does_not_fit"
  | "reordered"
  | "moved_day";

/** The rules whose drops may move to another day (step 7). */
export type MovableRule = "closed" | "over_visit_limit" | "does_not_fit";

export interface TidyChange {
  rule: TidyRule;
  day: number; // 0-based day index
  placeId?: string; // the place taken out; absent when the day was reordered
  toDay?: number; // moved_day only: the day the place was moved to
  cause?: MovableRule; // moved_day only: the rule that took the place off `day`
}

export interface Tidied {
  selection: LlmSelection; // a copy with each day's tidied place ids
  changes: TidyChange[]; // what was changed, in the order it was done; empty for no change
}

/** The model's answer, tidied. Pure: the input is never changed. */
export function tidySelection(
  selection: LlmSelection,
  request: TripRequest,
  shortlist: Shortlist,
  ctx: PlannerContext,
): Tidied {
  const changes: TidyChange[] = [];
  const open = withoutClosed(
    selection.days.map((day) => day.placeIds),
    request,
    ctx,
    changes,
  );
  const unique = withoutRepeats(open, request, ctx, changes);
  const slots = daySlots(selection, request, ctx);
  // The trip as tidied so far, which the validator sees when a place goes back (step 6) or
  // moves (step 7).
  const trip: DaySelection[] = selection.days.map((day, index) => ({
    anchorId: day.anchorId,
    placeIds: unique[index] ?? [],
  }));
  const jobs = unique.map((ids, index): DayJob | null => {
    const slot = slots[index];
    const offered = (id: string) =>
      shortlist.placeIds.has(id) && ctx.anchorIdByPlaceId.get(id) === slot?.anchor.id;
    // Decision: a day with an unknown base, or a place not offered for its base, keeps the
    // model's order and length, and no place moves to it. The check sends such a day back to
    // the model whatever its order, and the repaired answer is tidied again.
    if (!slot || !ids.every(offered)) return null;
    const job = { index, slot, request, ctx, changes, trip };
    trip[index] = { anchorId: slot.anchor.id, placeIds: tidyDay(ids, job) };
    return job;
  });
  const moved = withMoves(jobs, changes, trip, shortlist, ctx);
  const days = selection.days.map((day, index) => ({
    ...day,
    placeIds: moved[index] ?? [],
    reasons: withMovedReasons(day.reasons, index, selection, changes),
  }));
  return { selection: { ...selection, days }, changes };
}

/**
 * Each day without the places closed all day on its date (a weekly closed day, a season, or a
 * date rule). A must-include stays unless the answer also has it on a day it is open.
 */
// Decision: a must-include the model put only on its closed day is not dropped. Dropped, it can
// leave a plan that passes without a place the traveler asked for: when that day is the trip's
// only one at its base, the validator only warns (MUST_INCLUDE_UNPLACEABLE), though another base
// order would fit it. Kept, the check reports the closure with its date, and the repair turn or
// the rules-only planner places it.
function withoutClosed(
  days: readonly (readonly string[])[],
  request: TripRequest,
  ctx: PlannerContext,
  changes: TidyChange[],
): string[][] {
  const closedOn = (placeId: string, day: number) => {
    const place = ctx.placesById.get(placeId);
    const date = addDays(request.startDate, day);
    return place !== undefined && openStatusOn(place, date).state === "closed";
  };
  const openElsewhere = (placeId: string, day: number) =>
    days.some((ids, other) => other !== day && ids.includes(placeId) && !closedOn(placeId, other));
  return days.map((ids, day) =>
    ids.filter((placeId) => {
      if (!closedOn(placeId, day)) return true;
      if (request.mustInclude.includes(placeId) && !openElsewhere(placeId, day)) return true;
      changes.push({ rule: "closed", day, placeId });
      return false;
    }),
  );
}

/** One place of the answer once closed places are out: its day, its position, and the place. */
interface Entry {
  day: number;
  index: number;
  placeId: string;
  place: Place | undefined; // undefined for an id that is not a place
}

/** An entry the repeat rules take out, and the entry in the trip it repeats. */
interface Repeat {
  rule: "duplicate" | "same_spot";
  rival: Entry;
}

/**
 * Each place once in the trip, and never two at one spot. The first one in trip order stays,
 * except that a must-include keeps its spot against an ordinary place anywhere in the trip, and a
 * day these drops would empty keeps one of its places (keepEveryDay).
 */
// Decision: closed places go first, so a place the model put on its closed day and again on an
// open day keeps the open one. Two must-includes at one spot both stay: the traveler asked for
// both, and the validator only warns (SAME_LOCATION).
function withoutRepeats(
  days: readonly string[][],
  request: TripRequest,
  ctx: PlannerContext,
  changes: TidyChange[],
): string[][] {
  const must = new Set(request.mustInclude);
  const grid: Entry[][] = days.map((ids, day) =>
    ids.map((placeId, index) => ({ day, index, placeId, place: ctx.placesById.get(placeId) })),
  );
  const mustEntries = grid.flat().filter((entry) => must.has(entry.placeId));
  const firsts = new Map<string, Entry>();
  const repeats = new Map<Entry, Repeat>();
  const kept: Entry[] = [];
  for (const entry of grid.flat()) {
    const first = firsts.get(entry.placeId);
    if (first) {
      repeats.set(entry, { rule: "duplicate", rival: first });
      continue;
    }
    firsts.set(entry.placeId, entry);
    const rivals = must.has(entry.placeId) ? [] : [...kept, ...mustEntries];
    const rival = rivals.find((other) => atOneSpot(other, entry));
    if (rival) {
      repeats.set(entry, { rule: "same_spot", rival });
      continue;
    }
    kept.push(entry);
  }
  keepEveryDay(grid, repeats, mustEntries, must);
  for (const entry of grid.flat()) {
    const repeat = repeats.get(entry);
    if (repeat) changes.push({ rule: repeat.rule, day: entry.day, placeId: entry.placeId });
  }
  return grid.map((entries) => entries.filter((e) => !repeats.has(e)).map((e) => e.placeId));
}

/** True when two entries are two places at one spot (never one place with itself). */
function atOneSpot(a: Entry, b: Entry): boolean {
  return a.place !== undefined && b.place !== undefined && sharesLocation(a.place, b.place);
}

/**
 * For each day the repeat rules would empty, one of its places stays and the entry it repeats
 * goes instead: the one whose day keeps the most stops, a visit before a meal place, then the
 * first. Then, for each day they would leave with meal places only, one of its visits stays the
 * same way, when the day it repeats keeps another visit. Only an entry that repeats a kept one on
 * a day with another stop to keep can stay, and only one with no other place in the trip at its
 * spot; never against a must-include's spot. Changes `repeats` in place.
 */
// Decision: the day that would be empty needs the place more than the day that had it first. The
// owner's failed plan of 2026-09-25 (as rebuilt from its log) put its Sunday on places closed that
// day and places days 1 and 2 had used, so day 3 was empty and the plan fell back; kept there, the
// Spanish Steps make a day the check passes, and day 1 keeps eight of its nine stops. Of 293
// recorded answers (the 132 live plans of the failure hunt of 2026-09-25 and the two live evals of
// that day), 12 tidied to an empty day: this passes all 12, and moving drops alone (step 7) 8.
// One place is enough to keep the day: step 7 then moves what days 1 and 2 cannot hold to it, and
// a day the model filled keeps the rest of its choices. Keeping each repeat on whichever of its
// days had fewer stops passed as many answers and gave day 3 more stops, but left more days with
// under two visits or without lunch or dinner (512 of 879 against 500), and it moves more of the
// model's choices between days.
// Decision: a day of meal places only keeps one repeated visit too, when the day it repeats keeps
// another visit, so the swap never empties a day of visits in turn. The empty-day rule did not
// apply to such a day, since its meal kept it from being empty: in a live run of the everything
// eval on 2026-09-25, day 3 was a dinner alone once St. Mark's Basilica, which day 1 also had, was
// dropped from it, though day 1 had five visits. On the 359 recorded answers of the failure hunt
// and the prover of that day, days of meals only fall from 3 to 1, 4 answers change, and no
// answer that passed the check stops passing.
function keepEveryDay(
  grid: readonly Entry[][],
  repeats: Map<Entry, Repeat>,
  mustEntries: readonly Entry[],
  must: ReadonlySet<string>,
): void {
  const keptOn = (day: number) =>
    grid.flat().filter((entry) => entry.day === day && !repeats.has(entry));
  const lonely = (entry: Entry, rival: Entry) =>
    !grid
      .flat()
      .some(
        (other) =>
          other !== entry &&
          other !== rival &&
          (!repeats.has(other) || mustEntries.includes(other)) &&
          atOneSpot(other, entry),
      );
  const isMeal = (entry: Entry) => entry.place !== undefined && isMealPlace(entry.place);
  const isVisit = (entry: Entry) => entry.place !== undefined && !isMealPlace(entry.place);
  /** Keeps one repeat on `day` (a visit when `visitOnly`), or none when none may stay. */
  const keepOne = (day: number, visitOnly: boolean) => {
    const options = [...repeats].flatMap(([entry, repeat]) => {
      const left = keptOn(repeat.rival.day);
      const spare = left.length;
      if (entry.day !== day || repeats.has(repeat.rival) || spare < 2) return [];
      if (visitOnly && (!isVisit(entry) || left.filter(isVisit).length < 2)) return [];
      const spot = repeat.rule === "same_spot";
      if (spot && (must.has(repeat.rival.placeId) || !lonely(entry, repeat.rival))) return [];
      return [{ entry, repeat, spare }];
    });
    options.sort(
      (a, b) =>
        b.spare - a.spare ||
        Number(isMeal(a.entry)) - Number(isMeal(b.entry)) ||
        a.entry.index - b.entry.index,
    );
    const chosen = options[0];
    if (!chosen) return;
    repeats.delete(chosen.entry);
    repeats.set(chosen.repeat.rival, { rule: chosen.repeat.rule, rival: chosen.entry });
  };
  grid.forEach((entries, day) => {
    if (entries.length === 0) return;
    if (keptOn(day).length === 0) keepOne(day, false);
    const kept = keptOn(day);
    if (kept.length > 0 && kept.every(isMeal)) keepOne(day, true);
  });
}

/** Each day's date, base, and transfer, worked out as scheduleTrip does; null for an unknown base. */
function daySlots(
  selection: LlmSelection,
  request: TripRequest,
  ctx: PlannerContext,
): (DaySlot | null)[] {
  let previous: Anchor | undefined;
  return selection.days.map((day, index) => {
    const anchor = ctx.anchorById.get(day.anchorId);
    if (!anchor) return null;
    const transferMin = previous ? transferMinutes(previous, anchor) : 0;
    previous = anchor;
    return { date: addDays(request.startDate, index), anchor, transferMin };
  });
}

/** One day and everything needed to time it. */
interface DayJob {
  index: number;
  slot: DaySlot;
  request: TripRequest;
  ctx: PlannerContext;
  changes: TidyChange[];
  trip: readonly DaySelection[]; // every day of the answer, tidied up to this one
}

/** The day's places ordered and trimmed. Records "reordered" when the kept ones moved. */
function tidyDay(ids: readonly string[], job: DayJob): string[] {
  let order = timedOrder(ids, job);
  let extra = overLimit(order, job);
  while (extra !== null) {
    job.changes.push({ rule: "over_visit_limit", day: job.index, placeId: extra });
    const dropped = extra;
    order = timedOrder(
      order.filter((id) => id !== dropped),
      job,
    );
    extra = overLimit(order, job);
  }
  order = withoutMisfits(order, job);
  order = withDropsBack(ids, order, job);
  order = withMealsSeated(order, job);
  const before = ids.filter((id) => order.includes(id));
  if (order.some((id, i) => id !== before[i])) {
    job.changes.push({ rule: "reordered", day: job.index });
  }
  return order;
}

/**
 * The model's order when it times without an error. Otherwise the order with the fewest errors
 * among the model's and two walks of the rules-only planner over the same places (the places a
 * walk cannot fit go last, in the model's order); the model's order wins a tie.
 */
// Decision: the model's order is a choice too, so it stays whenever the scheduler can time it,
// and a walk replaces it only when it does strictly better: tidying never makes a day worse.
// Decision: two walks, because a fixed set of places trips each one up differently. The
// planner's own picks can seat the wrong meal place while waiting for lunch, and taking every
// place as soon as it can start can run a long visit through a meal. On 400 random answers with
// shuffled days, 90 plans passed with the first walk alone, 80 with the second, and 97 with the
// better of the two for each day.
function timedOrder(ids: readonly string[], job: DayJob): string[] {
  let best = { order: [...ids], errors: timingErrors(ids, job) };
  for (const first of FIRST_CHOICES) {
    if (best.errors === 0) break;
    const walk = orderDay(ids, job.slot, job.request, job.ctx, first);
    const order = [...walk.ordered, ...walk.unfitted];
    const errors = timingErrors(order, job);
    if (errors < best.errors) best = { order, errors };
  }
  return best.order;
}

const FIRST_CHOICES: readonly FirstChoice[] = ["must_includes", "every_place"];

/** The day timed in this order by the scheduler, as the check times it. */
function timeDay(ids: readonly string[], job: DayJob): ScheduledDay {
  const { slot, request, ctx } = job;
  return scheduleDay(ids, slot.date, slot.anchor, request, ctx, slot.transferMin);
}

/** An error the scheduler found while timing the day, except the visit limit (the trim's job). */
const isTimingError = (v: Violation) => v.severity === "error" && v.code !== "TOO_MANY_VISITS";

/** The scheduler's errors for the day in this order, except the visit limit. */
function timingErrors(ids: readonly string[], job: DayJob): number {
  return timeDay(ids, job).violations.filter(isTimingError).length;
}

/**
 * The visit to drop when the day has more visits than its pace allows: the last one in the day
 * that the traveler did not ask for. Null when the day is within the limit, or when only
 * must-includes are left to drop.
 */
// Decision: the last ones go, and the day is ordered again after each one. An over-full day
// runs out of time at its end, and a walk puts the places it could not fit last. Visits are
// counted from the scheduler's roles, as the validator counts them, so a meal place that can
// only be a visit counts too.
function overLimit(ids: readonly string[], job: DayJob): string | null {
  const { request } = job;
  const visits = timeDay(ids, job).stops.filter((stop) => stop.role === "visit");
  if (visits.length <= PACE[request.pace].maxVisits) return null;
  const ordinary = visits.filter((stop) => !request.mustInclude.includes(stop.placeId));
  return ordinary.at(-1)?.placeId ?? null;
}

/**
 * The day without the ordinary visits its hours cannot hold. While the scheduler finds an error,
 * one visit goes (misfit) and the day is ordered again. Of the days seen on the way, the one
 * with the fewest errors is kept, the one with fewer drops on a tie, and only its drops are
 * recorded.
 */
// Decision: a day the model filled with more than its hours hold is tidied like one over the
// visit limit: code, not the model, sees the hours, so code takes out what does not fit and the
// model's other choices stay ("code tidies, AI chooses"). On the recorded first answers of the
// two live evals of 2026-09-25 (Sonnet 5, 15 cases, 3 runs each), 14 of 45 and 14 of 44 passed
// the check after tidying without this rule, and 43 and 42 with it. The rest leave out a
// must-include, which only the model can add.
// Decision: a drop is kept only when it lowers the day's errors, at once or after later drops.
// An error no drop can mend (a must-include on its closed day) would otherwise strip the day to
// its must-includes and meals and still fail; kept whole, the check reports it and the repair
// turn or the rules-only planner fixes it.
function withoutMisfits(order: string[], job: DayJob): string[] {
  let current = order;
  let errors = timingErrors(current, job);
  let best = { order: current, errors, drops: 0 };
  const dropped: string[] = [];
  while (errors > 0) {
    const out = misfit(current, job);
    if (out === null) break;
    dropped.push(out);
    current = timedOrder(
      current.filter((id) => id !== out),
      job,
    );
    errors = timingErrors(current, job);
    if (errors < best.errors) best = { order: current, errors, drops: dropped.length };
  }
  for (const placeId of dropped.slice(0, best.drops)) {
    job.changes.push({ rule: "does_not_fit", day: job.index, placeId });
  }
  return best.order;
}

/**
 * The visit to drop from a day the scheduler cannot time: the last droppable visit with an error
 * of its own, or else the last droppable visit, whose time may let a meal or a must-include
 * after it fit. Null when only must-includes and the meals the day needs are left, or when the
 * day has one stop.
 */
// Decision: the last one goes, as for the visit limit. The day walk puts the places it cannot
// fit last, so the latest visits are the ones the hours cannot hold.
// Decision: a day's only stop never goes. Dropping it would trade its timing errors for an empty
// day, and the fewest-errors pick could keep that; the check reports the stop instead.
function misfit(ids: readonly string[], job: DayJob): string | null {
  if (ids.length <= 1) return null;
  const { stops, violations } = timeDay(ids, job);
  const erring = new Set(violations.filter(isTimingError).map((v) => v.stopIndex));
  const droppable = stops.flatMap((_, index) => (canDrop(stops, index, job) ? [index] : []));
  const index = droppable.filter((i) => erring.has(i)).at(-1) ?? droppable.at(-1);
  return index === undefined ? null : (stops[index]?.placeId ?? null);
}

const DAY_MEALS: readonly Meal[] = ["lunch", "dinner"];

/**
 * True when the day can lose this stop: a visit the traveler did not ask for that is not a meal
 * the day needs. The day needs its lunch and dinner stops, and a meal place timed as a visit
 * while the day has nothing for a meal it serves: with the visits before it gone, it may still
 * be that meal.
 */
// Decision: a day without lunch or dinner is only warned about (MEAL_MISSING), so the check
// alone would not stop tidying from dropping the only restaurant the model chose for it. An
// outing through a meal's window stands in for that meal, as in the check, so a restaurant the
// outing leaves no room for can go; the outing itself is a visit like any other. On the same
// recorded answers, dropping meal places like any visit dropped as many places and lost two more
// meals.
function canDrop(stops: readonly Stop[], index: number, job: DayJob): boolean {
  const { request, ctx } = job;
  const stop = stops[index];
  const place = stop && ctx.placesById.get(stop.placeId);
  if (!stop || !place || stop.role !== "visit" || request.mustInclude.includes(stop.placeId)) {
    return false;
  }
  const lacks = (meal: Meal) => !stops.some((other) => hasMeal(other, meal, ctx));
  return !DAY_MEALS.some((meal) => servesMeal(place, meal) && lacks(meal));
}

/** True when the stop is the day's lunch or dinner, or an outing under way through its window. */
function hasMeal(stop: Stop, meal: Meal, ctx: PlannerContext): boolean {
  if (stop.role === meal) return true;
  const place = ctx.placesById.get(stop.placeId);
  return place !== undefined && coversMeal(place, stop.start, stop.end, meal);
}

/**
 * The day with some of the places steps 4 and 5 dropped put back where it holds them after all:
 * the visits withoutMisfits dropped, and the meal places either step dropped (goesBack). Each one,
 * in the model's order, is tried at every position of the day's order. Of the positions where the
 * day is no worse (holdsAsWell), a meal place is the day's lunch or dinner (isMealIn), and the
 * check finds nothing new (nothingNew), it goes in at the one that gives the day the most meals,
 * then moves its other stops least, then comes first. Its record goes with it, so the changes
 * still list exactly what left the day.
 */
// Decision: a drop is undone by insertion into the day's final order, and nothing else moves. The
// drop loop takes the latest visit, and a day walk puts the places it cannot fit last, so an
// early-closing museum (the Bargello, 08:15 to 13:50) was dropped at 14:50 although it fits as
// the day's first stop. On the 45 recorded first answers of the live eval of 2026-09-25, 27 of
// the 59 drops were not needed in some order of the same places, and insertion puts back 12 of
// them (13 before meal places went back only as meals). Moving any one place to any position of
// the walk's order kept 19, but it lost 12 of 3,000 random answers, doubled the time, and
// reorders days that need no drop. Insertion loses none: it times the day once per drop and
// position, and asks the check only where that timing holds.
// Decision: a meal place goes back only as a lunch or dinner the day lacks, never as a visit
// (decided for the owner on 2026-09-25). As a visit it was mostly a second meal: 114 of the 136
// meal places put back on 3,000 random answers were timed as visits, 56 of them next to the day's
// lunch or dinner, at most an hour apart. The rules-only planner draws the same line: a meal
// place is only ever a meal unless the traveler asked for it (mayVisit in
// packages/planner/src/dayLimits.ts), and tidying never drops a must-include. Timed as lunch or
// dinner, it is a meal no other stop is, since the scheduler gives each meal to one stop and a
// meal stop keeps its meal (holdsAsWell). An outing through the meal's window does not count
// here, so lunch in Parma before the afternoon's cheese and prosciutto tour still goes back:
// counting it would leave out 34 more meal places on 3,000 random answers, and 60 more in
// Bologna. A restaurant dropped while an outing or another restaurant was the meal it serves,
// whose cover a later drop took away, goes back as that meal when the day holds it (3 of 3,000
// random answers, and 13 of 3,000 in Bologna, lost a meal that way; none do now).
// Decision: a meal place is what isMealPlace says: every restaurant, and the markets, cafes, and
// food walks the reviewed list gives meals (Mercato Testaccio, Rasputin, the cicchetti crawl),
// as for the planner. Counting restaurants alone, 27 of those went back as visits on 3,000 random
// answers, and on 15 days one the visit limit dropped stayed out though the day lacked the meal it
// could be (27 in Bologna).
// Decision: the visit limit's drops stay out, except a meal place's, and so do a place closed on
// its date, one already in the trip, and one at the same spot as another: no position mends
// those. The trim counts a meal place timed as a visit (overLimit), but as a meal it adds no
// visit, and the day may have lost that meal since. Without this, 3 days of the 89 recorded
// answers of the two live evals, all in plans that pass, lacked a meal a restaurant the trim
// dropped could be (lunch at Il Sorpasso in two runs of one case, dinner at Osteria Fernanda), and
// so did 46 days of 3,000 random answers and 64 in Bologna; none do now.
// Decision: the position that moves the other stops least, not the first that holds the place.
// Both put back about as many places (651 and 656 on 3,000 random answers, before meal places
// went back only as meals), but the first position is often the day's start, where a restaurant
// waits for noon as lunch and every morning stop moves to the afternoon: the day's first stop
// moved an hour or more on 90 days, against 216 with the first position. A position that gives
// the day a meal it lacked comes before that: 13 more meals on 6,000 random answers, for 7 more
// days whose first stop moved.
// Decision: the model's order of the drops, tried once. Other orders (meals first, the reverse,
// the order they were dropped in) and a second round put back at most two more places on 6,000
// random answers, and up to two fewer on the recorded ones.
function withDropsBack(ids: readonly string[], order: string[], job: DayJob): string[] {
  const records = new Map<string | undefined, TidyChange>();
  for (const change of job.changes) {
    if (change.day === job.index && goesBack(change, job.ctx)) records.set(change.placeId, change);
  }
  let current = order;
  for (const placeId of ids) {
    const record = records.get(placeId);
    if (!record) continue;
    const next = insertion(placeId, current, job);
    if (next === null) continue;
    current = next;
    job.changes.splice(job.changes.indexOf(record), 1);
  }
  return current;
}

/**
 * The day's order with the place inserted, or null when no position takes it. Of the positions
 * where the day is no worse (holdsAsWell), a meal place is the day's lunch or dinner (isMealIn),
 * and the check finds nothing new (nothingNew), the one that gives the day the most meals, then
 * moves its other stops least, then comes first.
 */
function insertion(placeId: string, order: readonly string[], job: DayJob): string[] | null {
  const place = job.ctx.placesById.get(placeId);
  const asMeal = place !== undefined && isMealPlace(place);
  const look = lookAt(order, job);
  const fits: { order: string[]; look: DayLook; moved: number }[] = [];
  for (let at = 0; at <= order.length; at++) {
    const next = [...order.slice(0, at), placeId, ...order.slice(at)];
    const nextLook = lookAt(next, job);
    if (!holdsAsWell(nextLook, look, job)) continue;
    if (asMeal && !isMealIn(nextLook, placeId)) continue;
    fits.push({ order: next, look: nextLook, moved: minutesMoved(look.stops, nextLook.stops) });
  }
  // Stable, so the earliest position wins a tie.
  fits.sort((a, b) => b.look.meals.length - a.look.meals.length || a.moved - b.moved);
  const wasEmpty = order.length === 0 ? job.index : undefined;
  let found: Findings | null = null;
  for (const fit of fits) {
    found ??= findings(order, job);
    if (nothingNew(findings(fit.order, job), found, placeId, wasEmpty)) return fit.order;
  }
  return null;
}

/** The drops that may move to another day: a closure, the visit limit, or the hours. */
const MOVABLE: ReadonlySet<TidyRule> = new Set<MovableRule>([
  "closed",
  "over_visit_limit",
  "does_not_fit",
]);

const isMovable = (rule: TidyRule): rule is MovableRule => MOVABLE.has(rule);

/**
 * Step 7: each place a day lost to its closed day, the visit limit, or the hours, that the model
 * was offered, and that is not in the trip or at the spot of a place that is, moved to another day
 * at its base: one open on that day's date, with the fewest stops first, then the earliest,
 * inserted as a put-back is (insertion). Its record becomes moved_day, with the rule that took it
 * off its day as its cause, and the record of its repeat on the day it joins, if there is one,
 * goes. `trip` is the trip after steps 1 to 6, which
 * each job reads and this updates; `jobs` has each day's job, or null for a day that was not
 * tidied.
 */
// Decision: moving the model's own choice to another day is not adding a place. The model chose
// it for the trip, and a day that cannot hold it (full at the pace, out of time, or closed) is the
// only reason it would go; steps 4 and 5 still decide what each day holds. In the failure hunt's
// run of the owner's request, days 1 and 2 dropped the Trastevere walk and Giolitti while day 3
// was empty, and they were the only Rome places open that Sunday left unused. On the 293 recorded
// answers, moves keep 138 more stops (4,347 against 4,209), day 3 averages 3.02 visits and 0.98
// meals against 2.78 and 0.89, and no answer that passed the check stops passing.
// Decision: a meal place moves only as a lunch or dinner the day lacks, never as a visit, as for
// a put-back; a visit moves under the same checks, so a day never passes its visit limit or its
// hours to take one. The day with the fewest stops first, since it needs the place most.
// Decision: only a place the model was offered moves. The closed rule runs before any day is
// judged, so it also drops a place the shortlist left out (over budget, say) from its closed day.
// Moved to an open day, that place would be an id the check rejects (UNKNOWN_PLACE), in a plan
// that passes without it.
function withMoves(
  jobs: readonly (DayJob | null)[],
  changes: TidyChange[],
  trip: DaySelection[],
  shortlist: Shortlist,
  ctx: PlannerContext,
): string[][] {
  for (const change of [...changes]) {
    const place = ctx.placesById.get(change.placeId ?? "");
    const cause = change.rule;
    if (!isMovable(cause) || place === undefined) continue;
    if (!shortlist.placeIds.has(place.id)) continue;
    const target = moveTarget(place, change.day, trip, jobs, ctx);
    if (target === null) continue;
    trip[target.day] = { anchorId: target.anchorId, placeIds: target.order };
    const repeat = changes.findIndex(
      (other) =>
        other.day === target.day && other.placeId === place.id && other.rule === "duplicate",
    );
    changes[changes.indexOf(change)] = { ...change, rule: "moved_day", toDay: target.day, cause };
    if (repeat >= 0) changes.splice(repeat, 1);
  }
  return trip.map((day) => [...day.placeIds]);
}

/** The day a dropped place moves to, with its base and new order, or null when no day takes it. */
function moveTarget(
  place: Place,
  from: number,
  trip: readonly DaySelection[],
  jobs: readonly (DayJob | null)[],
  ctx: PlannerContext,
): { day: number; anchorId: string; order: string[] } | null {
  const inTrip = trip.some((day) =>
    day.placeIds.some((id) => {
      const other = ctx.placesById.get(id);
      return id === place.id || (other !== undefined && sharesLocation(other, place));
    }),
  );
  if (inTrip) return null;
  const base = ctx.anchorIdByPlaceId.get(place.id);
  const targets = trip.flatMap((day, index) => {
    const job = jobs[index];
    if (!job || index === from || day.anchorId !== base) return [];
    if (openStatusOn(place, job.slot.date).state === "closed") return [];
    return [{ index, job, day }];
  });
  targets.sort((a, b) => a.day.placeIds.length - b.day.placeIds.length || a.index - b.index);
  for (const { index, job, day } of targets) {
    const order = insertion(place.id, day.placeIds, job);
    if (order !== null) return { day: index, anchorId: day.anchorId, order };
  }
  return null;
}

/**
 * Day `day`'s reasons, with the model's reason for each place moved to it (the first one it wrote
 * for that place on the day it came from), unless the day has its own. The claims check
 * (applyAiReasons) still drops one that does not hold for the stop as timed on its new day.
 */
function withMovedReasons(
  reasons: LlmSelection["days"][number]["reasons"],
  day: number,
  selection: LlmSelection,
  changes: readonly TidyChange[],
): LlmSelection["days"][number]["reasons"] {
  const joined = changes.flatMap((change) => {
    if (change.rule !== "moved_day" || change.toDay !== day) return [];
    const reason = selection.days[change.day]?.reasons.find((r) => r.placeId === change.placeId);
    return reason && !reasons.some((r) => r.placeId === reason.placeId) ? [reason] : [];
  });
  return joined.length === 0 ? reasons : [...reasons, ...joined];
}

/**
 * The day with each meal place its order times as a visit moved, by removal and insertion, to
 * where it is a lunch or dinner the day lacks, when that gives the day more meals. Its record is
 * "reordered", since the day keeps the same places.
 */
// Decision: a restaurant at 15:30 is a lunch the model placed too late, not a visit it chose,
// and the model cannot see the times. On 341 recorded answers (the failure hunt of 2026-09-25
// before and after this change, and the two live evals of that day), 103 meal places were timed
// as visits; seated this way, 53 are, the days gain 50 meals, and no answer that passed stops
// passing. It moves only that place, and only where the day holds as well and the check finds
// nothing new, as a put-back does.
function withMealsSeated(order: string[], job: DayJob): string[] {
  let current = order;
  for (const placeId of order) {
    const look = lookAt(current, job);
    const place = job.ctx.placesById.get(placeId);
    const asVisit = look.stops.some((stop) => stop.placeId === placeId && stop.role === "visit");
    if (!asVisit || place === undefined || !isMealPlace(place)) continue;
    if (!DAY_MEALS.some((meal) => servesMeal(place, meal) && !look.meals.includes(meal))) continue;
    const next = insertion(
      placeId,
      current.filter((id) => id !== placeId),
      job,
    );
    if (next !== null && lookAt(next, job).meals.length > look.meals.length) current = next;
  }
  return current;
}

/** True for a drop that may go back: one for the hours, or a meal place's over the visit limit. */
function goesBack(change: TidyChange, ctx: PlannerContext): boolean {
  if (change.rule === "does_not_fit") return true;
  const place = change.placeId === undefined ? undefined : ctx.placesById.get(change.placeId);
  return change.rule === "over_visit_limit" && place !== undefined && isMealPlace(place);
}

/** True when the place is the day's lunch or dinner in this timing, not a visit. */
function isMealIn(look: DayLook, placeId: string): boolean {
  const stop = look.stops.find((other) => other.placeId === placeId);
  return stop !== undefined && stop.role !== "visit";
}

/** The day timed in one order, and what the put-back compares: errors, meals, and visits. */
interface DayLook {
  stops: Stop[];
  errors: number; // timing errors, as timingErrors counts them
  meals: Meal[]; // the day's lunch and dinner, a stop or an outing through the window
  visits: number; // stops timed as visits, as the validator counts them
}

function lookAt(ids: readonly string[], job: DayJob): DayLook {
  const { stops, violations } = timeDay(ids, job);
  return {
    stops,
    errors: violations.filter(isTimingError).length,
    meals: DAY_MEALS.filter((meal) => stops.some((stop) => hasMeal(stop, meal, job.ctx))),
    visits: stops.filter((stop) => stop.role === "visit").length,
  };
}

/**
 * True when the day with a place put back is no worse than without it: no more timing errors,
 * no meal lost, each lunch or dinner stop still that meal, and no visit over the pace's limit (a
 * day already over it, with only must-includes, gains no visit).
 */
// Decision: a meal stop keeps its meal. A restaurant put back ahead of the day's dinner place
// would take dinner from it and leave it a visit, a second dinner the model did not plan: 3 of
// the 34 places the recorded answers would otherwise get back did that.
function holdsAsWell(next: DayLook, now: DayLook, job: DayJob): boolean {
  const limit = Math.max(PACE[job.request.pace].maxVisits, now.visits);
  const keepsMeal = (stop: Stop) =>
    stop.role === "visit" ||
    next.stops.some((other) => other.placeId === stop.placeId && other.role === stop.role);
  return (
    next.errors <= now.errors &&
    now.meals.every((meal) => next.meals.includes(meal)) &&
    now.stops.every(keepsMeal) &&
    next.visits <= limit
  );
}

/** How far the stops of `before` moved in `after`, in minutes of start time, summed. */
function minutesMoved(before: readonly Stop[], after: readonly Stop[]): number {
  let moved = 0;
  for (const stop of before) {
    const now = after.find((other) => other.placeId === stop.placeId);
    moved += Math.abs((now?.start ?? stop.start) - stop.start);
  }
  return moved;
}

/** Each finding of the check once, with how often it occurs; stop indexes are left out. */
type Findings = Map<string, { finding: Violation; count: number }>;

/**
 * The check's findings on the trip with this day in this order: the scheduler's and the
 * validator's, as materialize gathers them. Stop indexes are left out of the key, since an
 * insertion moves every later stop.
 */
function findings(ids: readonly string[], job: DayJob): Findings {
  const picks = job.trip.map((day, index) =>
    index === job.index ? { ...day, placeIds: ids } : day,
  );
  const scheduled = scheduleTrip(job.request, picks, job.ctx);
  const itinerary: Itinerary = {
    request: job.request,
    days: scheduled.days,
    source: "ai",
    warnings: [],
    meta: CHECK_META,
  };
  const out: Findings = new Map();
  for (const finding of [...scheduled.violations, ...validateItinerary(itinerary, job.ctx)]) {
    const key = `${finding.code}|${finding.severity}|${finding.day ?? ""}|${finding.placeId ?? ""}`;
    const seen = out.get(key);
    out.set(key, { finding, count: (seen?.count ?? 0) + 1 });
  }
  return out;
}

const CHECK_META = { attempts: 0, latencyMs: 0, generatedAt: "1970-01-01T00:00:00.000Z" };

/**
 * True when the check finds nothing the day did not have before, apart from a warning about the
 * place put back itself (its rating, budget, or unknown hours), which came with the model's
 * choice, and a missing meal on the day `wasEmpty` names. Any other warning that a meal is
 * missing or a must-include cannot be placed is new.
 */
// Decision: the check is asked, not only the error count, which lets a day that still fails
// trade one error for another. On 3,000 random answers it turned away 50 put-backs the count
// allowed (197 of 3,000 in Bologna), each on a day that already failed, where the place put back
// would have ended the day too late in place of the stop before it. It turned away none on a day
// that timed cleanly. The error count, the meals, and the visit limit are checked first because
// they cost one timing of the day, and the check a timing of the trip.
// Decision: a warning about the place put back is not new. It came with the model's choice, and
// without this, 46 of the 651 places put back on 3,000 random answers, and 217 of 874 in Bologna,
// would stay out (each warned of unknown hours).
// Decision: on a day that was empty, a missing lunch or dinner is not new either. The check says
// only EMPTY_DAY of a day with no stops, so the first place moved to it always brings a warning for
// the meal it is not; the day trades an error for warnings. Without this, no place could move to an
// empty day: of the 12 recorded answers that tidied to one, moves alone saved none, and 8 with it.
function nothingNew(next: Findings, now: Findings, placeId: string, wasEmpty?: number): boolean {
  for (const [key, { finding, count }] of next) {
    if (count <= (now.get(key)?.count ?? 0)) continue;
    const own = finding.placeId === placeId;
    const firstMeals = finding.code === "MEAL_MISSING" && finding.day === wasEmpty;
    if (finding.severity !== "warning" || !(own || firstMeals)) return false;
  }
  return true;
}
