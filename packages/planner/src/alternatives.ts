import { isCandidate, sharesLocation } from "./constraints";
import { type PlannerContext, placesOfAnchor } from "./context";
import { mayVisit } from "./dayLimits";
import { compareViolations } from "./plan";
import { scheduleDay } from "./schedule";
import { isError, makeViolation } from "./scheduleChecks";
import { compareScored, scorePlace } from "./score";
import { attachReasons } from "./trip";
import type { DayPlan, Itinerary, Place, Stop, Violation } from "./types";
import { validateItinerary } from "./validate";

// Edits in the browser: remove, move, and swap a stop, then retime the day. The reducer builds a
// new order with removeStop, moveStop, or replaceStop and passes it to rescheduleDay. Swap only
// offers alternatives whose rebuilt day passes scheduleDay and the validator, so the common path
// never produces an error.

/** A place that can replace a stop, with the day as it would be after the swap. */
export interface Alternative {
  place: Place;
  score: number; // how well it fits where the replaced stop was, higher first
  day: DayPlan; // the rebuilt day with the swap applied
  stop: Stop; // the new stop as timed in that day
}

/** A day retimed after an edit. */
export interface RescheduledDay {
  itinerary: Itinerary; // a copy with the day rebuilt and that day's warnings refreshed
  violations: Violation[]; // everything scheduleDay found on the rebuilt day, errors included
}

function requireIndex(index: number, length: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new RangeError(`${what} ${index} is out of range 0 to ${length - 1}`);
  }
}

function idsOf(day: DayPlan): string[] {
  return day.stops.map((stop) => stop.placeId);
}

/** The day's ids without the stop at `stopIndex`. Throws RangeError on a bad index. */
export function removeStop(day: DayPlan, stopIndex: number): string[] {
  requireIndex(stopIndex, day.stops.length, "Stop");
  return idsOf(day).filter((_, index) => index !== stopIndex);
}

/** The day's ids with the stop at `from` moved to `to`. Throws RangeError on a bad index. */
export function moveStop(day: DayPlan, from: number, to: number): string[] {
  requireIndex(from, day.stops.length, "Stop");
  requireIndex(to, day.stops.length, "Stop");
  const ids = idsOf(day);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved as string);
  return ids;
}

/** The day's ids with the stop at `stopIndex` replaced by `placeId`. Throws on a bad index. */
export function replaceStop(day: DayPlan, stopIndex: number, placeId: string): string[] {
  requireIndex(stopIndex, day.stops.length, "Stop");
  const ids = idsOf(day);
  ids[stopIndex] = placeId;
  return ids;
}

/**
 * Retimes day `dayIndex` with `orderedIds` using the day's own date, base, and transfer. Roles
 * are inferred again from the new order. AI reasons are kept for stops that keep their place and
 * role; every other stop gets a rule reason. The itinerary's warnings become the validator's
 * warnings for the edited trip; other days are untouched. Throws RangeError on a bad day index.
 */
export function rescheduleDay(
  itinerary: Itinerary,
  dayIndex: number,
  orderedIds: readonly string[],
  ctx: PlannerContext,
): RescheduledDay {
  const rebuilt = rebuildDay(itinerary, dayIndex, orderedIds, ctx);
  return { itinerary: rebuilt.itinerary, violations: rebuilt.violations };
}

/** rescheduleDay plus the validator's full verdict on the edited trip, so callers reuse it. */
function rebuildDay(
  itinerary: Itinerary,
  dayIndex: number,
  orderedIds: readonly string[],
  ctx: PlannerContext,
): RescheduledDay & { validation: Violation[] } {
  requireIndex(dayIndex, itinerary.days.length, "Day");
  const day = itinerary.days[dayIndex] as DayPlan;
  const anchor = ctx.anchorById.get(day.anchorId);
  if (!anchor) {
    const detail = "This day's base is not in the data.";
    const violations = [makeViolation("UNKNOWN_ANCHOR", detail, { day: dayIndex })];
    const copy = { ...itinerary, days: [...itinerary.days] };
    return { itinerary: copy, violations, validation: validateItinerary(copy, ctx) };
  }
  const { request } = itinerary;
  const scheduled = scheduleDay(orderedIds, day.date, anchor, request, ctx, day.transferMin, {
    dayIndex,
  });
  const stops = attachReasons(scheduled.stops, request, ctx, day.stops);
  const days = itinerary.days.map((old, index) => (index === dayIndex ? { ...old, stops } : old));
  const edited = { ...itinerary, days };
  const validation = validateItinerary(edited, ctx);
  // Decision: the validator's warnings are the source of truth after an edit, as they are for a
  // new plan (chooseWarnings in plan.ts). Refreshing only the edited day from scheduleDay gave
  // the same codes in different words, and lost trip-level warnings such as a SAME_LOCATION
  // pair across days (property tests, disagreement 3 in the T17 report).
  const warnings = validation.filter((violation) => !isError(violation)).sort(compareViolations);
  return { itinerary: { ...edited, warnings }, violations: scheduled.violations, validation };
}

/**
 * Places that can replace stop `stopIndex` of day `dayIndex`, best first, at most `limit`.
 * A candidate is in the day's base, not used elsewhere in the trip, not sharing a location with
 * a used place, not excluded, suggestable, and within budget. It is kept only when the rebuilt
 * day has no error from scheduleDay, every stop keeps its role (a lunch is swapped for a lunch),
 * and the validator finds no new error. Returns [] for an index or base that does not exist.
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
  if (!day || !current || !anchor || !Number.isFinite(limit) || limit < 1) return [];
  const { request } = itinerary;
  const used = usedPlaces(itinerary, ctx, dayIndex, stopIndex);
  const baseline = new Set(validateItinerary(itinerary, ctx).filter(isError).map(errorKey));
  const previous = stopIndex === 0 ? undefined : placeOf(ctx, day.stops[stopIndex - 1]);
  const situation = {
    date: day.date,
    from: previous ?? anchor.centroid,
    previousType: previous?.type ?? null,
  };
  const found: Alternative[] = [];
  for (const place of placesOfAnchor(ctx, anchor.id)) {
    if (place.id === current.placeId || !isCandidate(place, request, anchor.id, ctx)) continue;
    if (used.some((other) => other.id === place.id || sharesLocation(other, place))) continue;
    // A restaurant replaces a visit only when the traveler asked for it, as in the planner.
    if (current.role === "visit" && !mayVisit(place, request.mustInclude)) continue;
    const rebuilt = rebuildDay(itinerary, dayIndex, replaceStop(day, stopIndex, place.id), ctx);
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
