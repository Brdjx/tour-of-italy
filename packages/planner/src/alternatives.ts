import { dayOrigin } from "./anchors";
import { MAX_TRAVEL_MINUTES } from "./config";
import { isCandidate, sharesLocation } from "./constraints";
import { type PlannerContext, placesOfAnchor } from "./context";
import { mayVisit } from "./dayLimits";
import { compareViolations, planWarnings } from "./plan";
import { scheduleDay } from "./schedule";
import { compareScored, scorePlace } from "./score";
import { idsOf, replaceStop, requireIndex } from "./stopEdits";
import { isValidIsoDate } from "./time";
import { attachReasons, scheduleTrip } from "./trip";
import type { DayPlan, Itinerary, Place, Stop, TripRequest, Violation } from "./types";
import { validateItinerary } from "./validate";
import { isError, isWarning, makeViolation } from "./violations";

export { moveStop, removeStop, replaceStop } from "./stopEdits";

// Edits in the browser: remove, move, and swap a stop, then retime the day. The reducer builds a
// new order with removeStop, moveStop, or replaceStop and passes it to rescheduleDay. Swap only
// offers alternatives whose rebuilt day passes scheduleDay and the validator, so the common path
// never produces an error. After every edit the warnings are the validator's (planWarnings).

/** A place that can replace a stop, with the day as it would be after the swap. */
export interface Alternative {
  place: Place;
  score: number; // how well it fits where the replaced stop was, higher first
  day: DayPlan; // the rebuilt day with the swap applied
  stop: Stop; // the new stop as timed in that day
}

/**
 * The itinerary with day `dayIndex` replaced by a re-planned day (POST /api/plan/day, or planDay
 * in the browser): its base and stops, the whole trip timed again, since the next day's transfer
 * changes with the day's base. AI reasons on the new day, and on the other days, are kept where
 * the stop keeps its place and role and the reason still holds (attachReasons); every other stop
 * gets a rule reason. The warnings become the validator's. Throws RangeError on a bad day index.
 */
export function withReplannedDay(
  itinerary: Itinerary,
  dayIndex: number,
  day: Pick<DayPlan, "anchorId" | "stops">,
  ctx: PlannerContext,
): Itinerary {
  return withReplannedDays(itinerary, [{ day: dayIndex, dayPlan: day }], ctx);
}

/** One day planned again, as withReplannedDays takes it. */
export interface ReplannedDay {
  day: number; // 0-based
  dayPlan: Pick<DayPlan, "anchorId" | "stops">;
}

/**
 * The itinerary with several days replaced by re-planned days at once, as withReplannedDay does
 * for one: a route's days (dayRoute.ts), applied as one edit so one Undo takes them all back. A
 * day listed twice takes its last entry. Throws RangeError on a bad day index.
 */
// Decision: the summary goes when any day's base changes. "Three days in Rome" names no place the
// sentence check (summaryForPlaces) could catch, and a saved trip drops it in the same case
// (services/api/src/trips/rebuild.ts). New versions of days at the same bases keep it; the page
// still drops any sentence naming a place the trip no longer has.
export function withReplannedDays(
  itinerary: Itinerary,
  replanned: readonly ReplannedDay[],
  ctx: PlannerContext,
): Itinerary {
  for (const { day } of replanned) requireIndex(day, itinerary.days.length, "Day");
  const latest = new Map(replanned.map((entry) => [entry.day, entry.dayPlan]));
  const previous = itinerary.days.map((old, index) => {
    const day = latest.get(index);
    return day ? { ...old, anchorId: day.anchorId, stops: day.stops } : old;
  });
  const selection = previous.map((old) => ({ anchorId: old.anchorId, placeIds: idsOf(old) }));
  const { days } = scheduleTrip(itinerary.request, selection, ctx, previous);
  const { summary, ...rest } = itinerary;
  const sameBases = previous.every(
    (day, index) => itinerary.days[index]?.anchorId === day.anchorId,
  );
  const next: Itinerary = {
    ...rest,
    ...(sameBases && summary !== undefined ? { summary } : {}),
    days,
    warnings: [],
  };
  next.warnings = planWarnings(next, ctx);
  return next;
}

/** A day retimed after an edit. */
export interface RescheduledDay {
  itinerary: Itinerary; // a copy with the day rebuilt and the whole trip's warnings refreshed
  violations: Violation[]; // everything scheduleDay found on the rebuilt day, errors included
}

/**
 * Retimes day `dayIndex` with `orderedIds` using the day's own date, base, and transfer. Roles
 * are inferred again from the new order. AI reasons are kept for stops that keep their place and
 * role; every other stop gets a rule reason. A must-include the edit takes out of the trip is
 * taken off request.mustInclude too. The itinerary's warnings become the validator's warnings
 * for the edited trip; other days are untouched. A day whose date or transfer is not valid is
 * left as it was, with the validator's errors for it. Throws RangeError on a bad day index.
 */
// Decision: removing a place you asked for is an explicit choice, so it leaves the must-include
// list. Before, the browser showed the edited plan as clean while the server's validator called
// it MUST_INCLUDE_MISSING, and a shared link of it failed. Swaps still never replace a must-
// include (alternativesFor), because a suggestion should not undo a request.
export function rescheduleDay(
  itinerary: Itinerary,
  dayIndex: number,
  orderedIds: readonly string[],
  ctx: PlannerContext,
): RescheduledDay {
  const rebuilt = rebuildDay(itinerary, dayIndex, orderedIds, ctx, true);
  return { itinerary: rebuilt.itinerary, violations: rebuilt.violations };
}

/** rescheduleDay's work, plus the validator's verdict on the edited trip for alternativesFor. */
function rebuildDay(
  itinerary: Itinerary,
  dayIndex: number,
  orderedIds: readonly string[],
  ctx: PlannerContext,
  dropRemovedMustIncludes: boolean,
): Rebuilt {
  requireIndex(dayIndex, itinerary.days.length, "Day");
  const day = itinerary.days[dayIndex] as DayPlan;
  const anchor = ctx.anchorById.get(day.anchorId);
  if (!anchor || !canTime(day)) return unchangedDay(itinerary, dayIndex, ctx, anchor !== undefined);
  const { request } = itinerary;
  const timing = { dayIndex };
  const scheduled = scheduleDay(
    orderedIds,
    day.date,
    anchor,
    request,
    ctx,
    day.transferMin,
    timing,
  );
  const trip = { days: itinerary.days, index: dayIndex };
  const stops = attachReasons(scheduled.stops, request, ctx, day.stops, trip);
  const rebuiltDay = { ...day, stops, returnTravelMin: scheduled.returnTravelMin };
  const days = itinerary.days.map((old, index) => (index === dayIndex ? rebuiltDay : old));
  const kept = dropRemovedMustIncludes
    ? withoutRemovedMustIncludes(request, itinerary.days, days)
    : request;
  const edited = { ...itinerary, request: kept, days };
  const validation = validateItinerary(edited, ctx);
  // Decision: the validator's warnings are the source of truth after an edit, as they are for a
  // new plan (planWarnings in plan.ts). Refreshing only the edited day from scheduleDay gave the
  // same codes in different words and lost trip-level warnings such as a SAME_LOCATION pair
  // across days (see disagreement 3 in test/disagreements.test.ts).
  const warnings = validation.filter(isWarning).sort(compareViolations);
  return { itinerary: { ...edited, warnings }, violations: scheduled.violations, validation };
}

/** A rebuilt day, plus the validator's full verdict on the edited trip so callers reuse it. */
type Rebuilt = RescheduledDay & { validation: Violation[] };

/**
 * A day that cannot be timed (an unknown base, a date or transfer that is not valid) left as it
 * was, with UNKNOWN_ANCHOR or the validator's errors for that day.
 */
function unchangedDay(
  itinerary: Itinerary,
  dayIndex: number,
  ctx: PlannerContext,
  knownBase: boolean,
): Rebuilt {
  const days = [...itinerary.days];
  const validation = validateItinerary({ ...itinerary, days }, ctx);
  const warnings = validation.filter(isWarning).sort(compareViolations);
  const unknown = "This day's base is not in the data.";
  const violations = knownBase
    ? validation.filter((v) => isError(v) && v.day === dayIndex)
    : [makeViolation("UNKNOWN_ANCHOR", unknown, { day: dayIndex })];
  return { itinerary: { ...itinerary, days, warnings }, violations, validation };
}

/** True when the day's date and transfer are valid enough to time stops (the schema's rules). */
function canTime(day: DayPlan): boolean {
  const transfer = day.transferMin;
  return (
    isValidIsoDate(day.date) &&
    Number.isInteger(transfer) &&
    transfer >= 0 &&
    transfer <= MAX_TRAVEL_MINUTES
  );
}

/** The request without the must-includes that were in `before` and are not in `after`. */
function withoutRemovedMustIncludes(
  request: TripRequest,
  before: readonly DayPlan[],
  after: readonly DayPlan[],
): TripRequest {
  const had = new Set(before.flatMap(idsOf));
  const has = new Set(after.flatMap(idsOf));
  const removed = request.mustInclude.filter((id) => had.has(id) && !has.has(id));
  if (removed.length === 0) return request;
  return { ...request, mustInclude: request.mustInclude.filter((id) => !removed.includes(id)) };
}

/**
 * Places that can replace stop `stopIndex` of day `dayIndex`, best first, at most `limit`.
 * A candidate is in the day's base, not used elsewhere in the trip, not sharing a location with
 * a used place, not excluded, suggestable, and within budget. It is kept only when the rebuilt
 * day has no error from scheduleDay, every stop keeps its role (a lunch is swapped for a lunch),
 * and the validator finds no error on the edited day and no new error elsewhere. Returns [] for
 * an index or base that does not exist, or a day whose date or transfer is not valid. Like
 * validateItinerary, it expects a value of the Itinerary type (parse with ItinerarySchema first).
 */
export function alternativesFor(
  itinerary: Itinerary,
  dayIndex: number,
  stopIndex: number,
  ctx: PlannerContext,
  limit = 5,
): Alternative[] {
  const day = itinerary.days[dayIndex];
  const current = day?.stops[stopIndex];
  const anchor = day ? ctx.anchorById.get(day.anchorId) : undefined;
  if (!day || !current || !anchor || !canTime(day) || !Number.isFinite(limit) || limit < 1) {
    return [];
  }
  const { request } = itinerary;
  const used = usedPlaces(itinerary, ctx, dayIndex, stopIndex);
  const baseline = new Set(validateItinerary(itinerary, ctx).filter(isError).map(errorKey));
  const previous = stopIndex === 0 ? undefined : placeOf(ctx, day.stops[stopIndex - 1]);
  const situation = {
    date: day.date,
    from: previous ?? dayOrigin(anchor, request),
    previousType: previous?.type ?? null,
  };
  const found: Alternative[] = [];
  for (const place of placesOfAnchor(ctx, anchor.id)) {
    if (place.id === current.placeId || !isCandidate(place, request, anchor.id, ctx)) continue;
    if (used.some((other) => other.id === place.id || sharesLocation(other, place))) continue;
    // A meal place replaces a visit only when the traveler asked for it, as in the planner.
    if (current.role === "visit" && !mayVisit(place, request.mustInclude)) continue;
    const ids = replaceStop(day, stopIndex, place.id);
    const rebuilt = rebuildDay(itinerary, dayIndex, ids, ctx, false);
    const newDay = rebuilt.itinerary.days[dayIndex] as DayPlan;
    if (rebuilt.violations.some(isError) || !sameRoles(newDay.stops, day.stops)) continue;
    const errors = rebuilt.validation.filter(isError);
    if (errors.some((error) => error.day === dayIndex || !baseline.has(errorKey(error)))) continue;
    const score = scorePlace(place, request, situation);
    found.push({ place, score, day: newDay, stop: newDay.stops[stopIndex] as Stop });
  }
  return found.sort(compareScored).slice(0, Math.floor(limit));
}

/** Every place in the trip except the stop being replaced. */
function usedPlaces(
  itinerary: Itinerary,
  ctx: PlannerContext,
  dayIndex: number,
  stopIndex: number,
): Place[] {
  const used: Place[] = [];
  itinerary.days.forEach((day, d) => {
    day.stops.forEach((stop, s) => {
      if (d === dayIndex && s === stopIndex) return;
      const place = placeOf(ctx, stop);
      if (place) used.push(place);
    });
  });
  return used;
}

function placeOf(ctx: PlannerContext, stop: Stop | undefined): Place | undefined {
  return stop ? ctx.placesById.get(stop.placeId) : undefined;
}

function sameRoles(a: readonly Stop[], b: readonly Stop[]): boolean {
  return a.length === b.length && a.every((stop, index) => stop.role === b[index]?.role);
}

function errorKey(violation: Violation): string {
  return `${violation.code}|${violation.day ?? ""}|${violation.placeId ?? ""}`;
}
