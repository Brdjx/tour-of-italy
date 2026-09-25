import {
  type Anchor,
  addDays,
  type DaySlot,
  type FirstChoice,
  openStatusOn,
  orderDay,
  PACE,
  type Place,
  type PlannerContext,
  scheduleDay,
  sharesLocation,
  type TripRequest,
  transferMinutes,
} from "@italy/planner";
import type { LlmSelection } from "../llm/client";
import type { Shortlist } from "./candidates";

// The tidy step: what code does to the model's answer before the check. The model picks each
// day's base and places, but code assigns every time, so the model cannot see when a place is
// closed or when a day runs out. Tidying keeps the model's choices and does only this:
//   1. drops a place closed all day on that day's date (a must-include only when the answer
//      also has it on a day it is open);
//   2. drops a place already in the trip, and an ordinary place at the same spot (or the same
//      experience) as one already in the trip or as a must-include;
//   3. puts a day whose order cannot be timed in an order the rules-only planner's day walk
//      finds for the same places (packages/planner/src/orderDay.ts);
//   4. drops a day's last ordinary visits until the pace's visit limit holds.
// It never changes a base, never adds a place, and keeps every must-include in the answer on one
// of its days. A day holding anything it cannot judge (an id not offered, a place of another
// base, an unknown base) is not reordered or trimmed: the check reports it and the repair turn
// fixes it.

export type TidyRule = "closed" | "duplicate" | "same_spot" | "over_visit_limit" | "reordered";

export interface TidyChange {
  rule: TidyRule;
  day: number; // 0-based day index
  placeId?: string; // the place taken out; absent when the day was reordered
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
  const tidy = unique.map((ids, index) => {
    const slot = slots[index];
    const offered = (id: string) =>
      shortlist.placeIds.has(id) && ctx.anchorIdByPlaceId.get(id) === slot?.anchor.id;
    // Decision: a day with an unknown base, or a place not offered for its base, keeps the
    // model's order and length. The check sends such a day back to the model whatever its
    // order, and the repaired answer is tidied again.
    if (!slot || !ids.every(offered)) return ids;
    return tidyDay(ids, { index, slot, request, ctx, changes });
  });
  const days = selection.days.map((day, index) => ({ ...day, placeIds: tidy[index] ?? [] }));
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

/**
 * Each place once in the trip, and never two at one spot. The first one in trip order stays,
 * except that a must-include keeps its spot against an ordinary place anywhere in the trip.
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
  const inAnswer = new Set(days.flat());
  const mustPlaces = ctx.places.filter((place) => must.has(place.id) && inAnswer.has(place.id));
  const seen = new Set<string>();
  const kept: Place[] = [];
  return days.map((ids, day) =>
    ids.filter((placeId) => {
      if (seen.has(placeId)) {
        changes.push({ rule: "duplicate", day, placeId });
        return false;
      }
      seen.add(placeId);
      const place = ctx.placesById.get(placeId);
      if (!place) return true;
      const rivals = must.has(placeId) ? [] : [...kept, ...mustPlaces];
      if (rivals.some((other) => sharesLocation(other, place))) {
        changes.push({ rule: "same_spot", day, placeId });
        return false;
      }
      kept.push(place);
      return true;
    }),
  );
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

/** The scheduler's errors for the day in this order, except the visit limit (the trim's job). */
function timingErrors(ids: readonly string[], job: DayJob): number {
  const { slot, request, ctx } = job;
  const { violations } = scheduleDay(ids, slot.date, slot.anchor, request, ctx, slot.transferMin);
  return violations.filter((v) => v.severity === "error" && v.code !== "TOO_MANY_VISITS").length;
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
  const { slot, request, ctx } = job;
  const { stops } = scheduleDay(ids, slot.date, slot.anchor, request, ctx, slot.transferMin);
  const visits = stops.filter((stop) => stop.role === "visit");
  if (visits.length <= PACE[request.pace].maxVisits) return null;
  const ordinary = visits.filter((stop) => !request.mustInclude.includes(stop.placeId));
  return ordinary.at(-1)?.placeId ?? null;
}
