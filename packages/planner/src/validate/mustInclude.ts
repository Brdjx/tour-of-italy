import { transferMinutes } from "../anchors";
import { MAX_ANCHORS_PER_TRIP, PACE, TRAVEL } from "../config";
import {
  type DayWindow,
  dayWindow,
  earliestMealStart,
  earliestOpenStart,
  isExcluded,
  sharesLocation,
} from "../constraints";
import { anchorOfPlace, type PlannerContext } from "../context";
import { openStatusOn } from "../time";
import { travelMinutes } from "../travel";
import type { Anchor, DateRule, Itinerary, Pace, Place, Stop, Violation } from "../types";
import { countVisits, type DayFacts, hasValidTimes } from "./days";
import { dateText, dayText, listText, noteText } from "./text";
import { violation } from "./violations";

// Must-include checks. A requested place missing from the plan is an error only when it is
// placeable; otherwise it is a warning that says why. The rule is deliberately conservative: a
// false error would make even the rules-only fallback plan fail, while a missed place with an
// honest reason only disappoints. The full rule is in the comment on placeability().

/** The verdict for one missing must-include place. */
export type Placeability = { placeable: true; day: number } | { placeable: false; reason: string };

/** A day the place could go on: a real day at its base, or a day that could move there. */
interface Candidate {
  day: DayFacts;
  anchor: Anchor; // the place's base
  window: DayWindow; // the day window, after the transfer this day would need
  fixed: { stop: Stop; place: Place }[]; // must-include stops already on the day, by start
}

/** How a place fares on one candidate day, from worst to best. */
type Fit = "closed" | "outside_hours" | "no_room" | "fits";
const FIT_RANK: Record<Fit, number> = { closed: 0, outside_hours: 1, no_room: 2, fits: 3 };

/** MUST_INCLUDE_MISSING or MUST_INCLUDE_UNPLACEABLE for every requested place not in the plan. */
export function checkMustIncludes(
  itinerary: Itinerary,
  days: readonly DayFacts[],
  ctx: PlannerContext,
): Violation[] {
  const scheduled = new Set(itinerary.days.flatMap((day) => day.stops.map((s) => s.placeId)));
  const out: Violation[] = [];
  for (const id of new Set(itinerary.request.mustInclude)) {
    if (scheduled.has(id)) continue;
    const place = ctx.placesById.get(id);
    const name = place?.name ?? "A place you asked for";
    const verdict = placeability(id, itinerary, days, ctx);
    if (verdict.placeable) {
      const detail = `You asked for ${name}, and it fits on ${dayText(verdict.day)}, but it is not in the plan.`;
      out.push(violation("MUST_INCLUDE_MISSING", detail, { day: verdict.day, placeId: id }));
    } else {
      const detail = `${name} could not be included: ${verdict.reason}.`;
      out.push(violation("MUST_INCLUDE_UNPLACEABLE", detail, { placeId: id }));
    }
  }
  return out;
}

/**
 * The placeability rule. A missing must-include place P is placeable when ALL of these hold:
 * 1. P is a known place and the traveler did not also exclude it.
 * 2. P does not share a spot with another must-include place that is already in the plan.
 * 3. There is a candidate day. If some day is based at P's base, the candidates are those days.
 *    Otherwise P's base must be allowed (anchors "auto", or listed in request.anchors), the plan
 *    must use fewer than MAX_ANCHORS_PER_TRIP bases, and the candidates are the days holding no
 *    must-include stop, each imagined moved to P's base with the transfer from the day before.
 * 4. On some candidate day, P fits: its date is open (season, date, and weekday rules applied;
 *    unknown hours count as open) and a whole visit fits one open range inside the day window,
 *    starting no earlier than the window start plus travel from the base centroid; AND it fits
 *    between the must-include stops already on that day (travel plus buffer both sides; other
 *    stops are ignored because a plan may drop them); AND, when those stops already fill the
 *    pace's visit cap, P can go in as a lunch or dinner it serves, inside that meal's window.
 * When P is not placeable, the reason is the best outcome over the candidate days.
 */
export function placeability(
  id: string,
  itinerary: Itinerary,
  days: readonly DayFacts[],
  ctx: PlannerContext,
): Placeability {
  const request = itinerary.request;
  const place = ctx.placesById.get(id);
  const anchor = anchorOfPlace(ctx, id);
  if (!place || !anchor) return { placeable: false, reason: "it is not in our data" };
  if (isExcluded(place, request)) {
    return { placeable: false, reason: "you also asked to leave it out" };
  }
  const twin = scheduledMustIncludes(itinerary, ctx).find((other) => sharesLocation(place, other));
  if (twin) {
    return {
      placeable: false,
      reason: `it is at the same spot as ${twin.name}, already in your plan`,
    };
  }
  const picked = candidates(anchor, itinerary, days, ctx);
  if (typeof picked === "string") return { placeable: false, reason: picked };
  let best: { fit: Fit; day: number; rule?: DateRule } = { fit: "closed", day: -1 };
  for (const candidate of picked) {
    const result = fitOnDay(place, candidate);
    if (result.fit === "fits") return { placeable: true, day: candidate.day.index };
    if (best.day === -1 || FIT_RANK[result.fit] > FIT_RANK[best.fit]) {
      best = { ...result, day: candidate.day.index };
    }
  }
  return { placeable: false, reason: failureReason(best, picked, itinerary.request.pace) };
}

/** Candidate days (rule 3), or the reason there are none. */
function candidates(
  anchor: Anchor,
  itinerary: Itinerary,
  days: readonly DayFacts[],
  ctx: PlannerContext,
): Candidate[] | string {
  const request = itinerary.request;
  const atBase = days.filter((day) => day.anchor?.id === anchor.id);
  if (atBase.length > 0) {
    return atBase.map((day) => ({
      day,
      anchor,
      window: day.window,
      fixed: fixedStops(day, request.mustInclude, ctx),
    }));
  }
  if (request.anchors !== "auto" && !request.anchors.includes(anchor.id)) {
    return `its base, ${anchor.name}, is not one of the bases you chose`;
  }
  const bases = new Set(days.map((day) => day.plan.anchorId));
  if (bases.size >= MAX_ANCHORS_PER_TRIP) {
    return `its base, ${anchor.name}, is not in this trip, which already has ${bases.size} bases`;
  }
  // Decision: a day can move to the new base only if it holds no must-include stop. The move
  // also changes the next day's transfer; that is ignored here. It matters only when the next
  // day holds must-include stops the longer transfer would push out, which the planner property
  // tests would surface.
  const movable: Candidate[] = [];
  for (const day of days) {
    if (day.plan.stops.some((stop) => request.mustInclude.includes(stop.placeId))) continue;
    const from = day.index === 0 ? null : days[day.index - 1]?.anchor;
    if (from === undefined) continue; // the day before has an unknown base: transfer unknown
    const window = dayWindow(day.pace, from === null ? 0 : transferMinutes(from, anchor));
    movable.push({ day, anchor, window, fixed: [] });
  }
  if (movable.length > 0) return movable;
  return `no day of this trip is free to move to ${anchor.name}`;
}

/** Must-include stops on a day with valid times and known places, in start order. */
function fixedStops(day: DayFacts, mustInclude: readonly string[], ctx: PlannerContext) {
  const fixed: { stop: Stop; place: Place }[] = [];
  for (const stop of day.plan.stops) {
    const place = ctx.placesById.get(stop.placeId);
    if (place && mustInclude.includes(stop.placeId) && hasValidTimes(stop)) {
      fixed.push({ stop, place });
    }
  }
  return fixed.sort((a, b) => a.stop.start - b.stop.start);
}

/** Known must-include places that are in the plan. */
function scheduledMustIncludes(itinerary: Itinerary, ctx: PlannerContext): Place[] {
  const found: Place[] = [];
  for (const day of itinerary.days) {
    for (const stop of day.stops) {
      const place = ctx.placesById.get(stop.placeId);
      if (place && itinerary.request.mustInclude.includes(place.id)) found.push(place);
    }
  }
  return found;
}

/** Rule 4 on one candidate day. */
function fitOnDay(place: Place, candidate: Candidate): { fit: Fit; rule?: DateRule } {
  const date = candidate.day.date;
  if (date === null) return { fit: "closed" };
  const status = openStatusOn(place, date);
  if (status.state === "closed") {
    return status.rule ? { fit: "closed", rule: status.rule } : { fit: "closed" };
  }
  const firstLeg = travelMinutes(candidate.anchor.centroid, place);
  const alone = { notBefore: candidate.window.start + firstLeg, latestEnd: candidate.window.end };
  if (!fitsGap(place, date, alone, false)) return { fit: "outside_hours" };
  // Decision: only must-include stops are fixed. Any other stop could be dropped to make room,
  // so a plan that fills the day with other places and leaves out a must-include still fails.
  const full =
    countVisits(candidate.fixed.map((f) => f.stop)) >= PACE[candidate.day.pace].maxVisits;
  const fits = gaps(place, candidate, firstLeg).some((gap) => fitsGap(place, date, gap, full));
  return { fit: fits ? "fits" : "no_room" };
}

interface Gap {
  notBefore: number; // earliest start, after travel and buffer from the stop before
  latestEnd: number; // latest end, leaving travel and buffer to the stop after
}

/** The free gaps around the fixed stops, from the day start to the day end. */
function gaps(place: Place, candidate: Candidate, firstLeg: number): Gap[] {
  const result: Gap[] = [];
  let notBefore = candidate.window.start + firstLeg;
  for (const { stop, place: other } of candidate.fixed) {
    const travel = travelMinutes(place, other);
    result.push({ notBefore, latestEnd: stop.start - travel - TRAVEL.bufferMin });
    notBefore = stop.end + travel + TRAVEL.bufferMin;
  }
  result.push({ notBefore, latestEnd: candidate.window.end });
  return result;
}

/**
 * True when a visit fits the gap. When the day's must-include visits already fill the pace's cap,
 * the place fits only as a lunch or dinner it serves, starting inside that meal's window.
 */
function fitsGap(place: Place, date: string, gap: Gap, asMealOnly: boolean): boolean {
  const duration = place.durationMin;
  if (!asMealOnly) {
    const start = earliestOpenStart(place, date, gap.notBefore, duration);
    return start !== null && start + duration <= gap.latestEnd;
  }
  return place.meals.some((meal) => {
    const start = earliestMealStart(place, date, gap.notBefore, meal, duration);
    return start !== null && start + duration <= gap.latestEnd;
  });
}

/** The traveler-facing reason for the best failed outcome. */
function failureReason(
  best: { fit: Fit; rule?: DateRule },
  picked: readonly Candidate[],
  pace: Pace,
): string {
  const dates = listText(
    picked.map((c) => (c.day.date ? dateText(c.day.date) : dayText(c.day.index))),
  );
  if (best.fit === "no_room") {
    return `the time on ${dates} is already taken by other places you asked for`;
  }
  if (best.fit === "outside_hours") return `its opening hours on ${dates} do not fit a ${pace} day`;
  return `it is closed on ${dates}${noteText(best.rule?.source)}`;
}
