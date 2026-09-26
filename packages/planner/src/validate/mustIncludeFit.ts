import { dayOrigin, transferMinutes } from "../anchors";
import { MAX_ANCHORS_PER_TRIP, PACE, TRAVEL } from "../config";
import {
  type DayWindow,
  dayWindow,
  earliestMealStart,
  earliestOpenStart,
  isMealPlace,
  servesMeal,
} from "../constraints";
import type { PlannerContext } from "../context";
import { openStatusOn } from "../time";
import { type LatLng, latestReturn, travelMinutes } from "../travel";
import type { Anchor, DateRule, Itinerary, Meal, Pace, Place, Stop } from "../types";
import { countVisits, type DayFacts, hasValidTimes } from "./days";

// The geometry behind the must-include rule (mustInclude.ts): which days a missing place could go
// on, and whether it fits one of them between the must-include stops already there.

/** A day the place could go on: a real day at its base, or a day that could move there. */
export interface Candidate {
  day: DayFacts;
  anchor: Anchor; // the place's base
  window: DayWindow; // the day window, after the transfer this day would need
  origin: LatLng; // where that day starts and ends at the place's base (dayOrigin)
  fixed: { stop: Stop; place: Place }[]; // must-include stops already on the day, by start
}

/** How a place fares on one candidate day, from worst to best. */
export type Fit = "closed" | "outside_hours" | "no_room" | "fits";
export const FIT_RANK: Record<Fit, number> = { closed: 0, outside_hours: 1, no_room: 2, fits: 3 };

/** Candidate days (rule 3 of placeability), or the reason there are none. */
export function candidates(
  anchor: Anchor,
  itinerary: Itinerary,
  days: readonly DayFacts[],
  ctx: PlannerContext,
): Candidate[] | string {
  const request = itinerary.request;
  const origin = dayOrigin(anchor, request);
  const atBase = days.filter((day) => day.anchor?.id === anchor.id);
  if (atBase.length > 0) {
    return atBase.map((day) => ({
      day,
      anchor,
      window: day.window,
      origin,
      fixed: fixedStops(day, request.mustInclude, ctx),
    }));
  }
  if (request.anchors !== "auto" && !request.anchors.includes(anchor.id)) {
    return `its base, ${anchor.name}, is not one of the bases you chose`;
  }
  // Decision: MAX_ANCHORS_PER_TRIP, the planners' limit, not the validator's one a day. The
  // question is whether a planner could have placed the place, and neither whole-trip planner
  // adds a third base. A route the traveler sets by hand is judged the same way and stays right
  // with two changes of base: a base the route has is judged on its own days, with their real
  // windows (so Rome, Florence, Rome weighs days 1 and 3 for a Rome place), and a route that
  // would lose a must-include is refused before it is planned (dayRoute.ts).
  const bases = new Set(days.map((day) => day.plan.anchorId));
  if (bases.size >= MAX_ANCHORS_PER_TRIP) {
    return `its base, ${anchor.name}, is not in this trip, which already has ${bases.size} bases`;
  }
  // Decision: a day can move to the new base only if it holds no must-include stop and it is the
  // first or the last day, so the trip still changes base once (the planner never goes back and
  // forth: Rome, Bologna, Rome is mostly trains). The move also changes the next day's transfer;
  // that is ignored here. It matters only when the next day holds must-include stops the longer
  // transfer would push out, which the planner property tests would surface.
  const movable: Candidate[] = [];
  for (const day of days) {
    if (day.index !== 0 && day.index !== days.length - 1) continue;
    if (day.plan.stops.some((stop) => request.mustInclude.includes(stop.placeId))) continue;
    const from = day.index === 0 ? null : days[day.index - 1]?.anchor;
    if (from === undefined) continue; // the day before has an unknown base: transfer unknown
    const window = dayWindow(day.pace, from === null ? 0 : transferMinutes(from, anchor));
    movable.push({ day, anchor, window, origin, fixed: [] });
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

/**
 * True when the place fits an empty day at its own base on this date: open, and a whole visit
 * fits the day window with the trip there and back, with no transfer that morning.
 */
export function fitsEmptyDayAt(place: Place, date: string, pace: Pace, origin: LatLng): boolean {
  if (openStatusOn(place, date).state === "closed") return false;
  const window = dayWindow(pace, 0);
  return fitsGap(place, date, aloneGap(place, window, origin), gapRoles(place, [], 0, false));
}

/** Rule 4 of placeability on one candidate day. */
export function fitOnDay(place: Place, candidate: Candidate): { fit: Fit; rule?: DateRule } {
  const date = candidate.day.date;
  if (date === null) return { fit: "closed" };
  const status = openStatusOn(place, date);
  if (status.state === "closed") {
    return status.rule ? { fit: "closed", rule: status.rule } : { fit: "closed" };
  }
  const alone = gapRoles(place, [], 0, false);
  if (!fitsGap(place, date, aloneGap(place, candidate.window, candidate.origin), alone)) {
    return { fit: "outside_hours" };
  }
  // Decision: only must-include stops are fixed. Any other stop could be dropped to make room,
  // so a plan that fills the day with other places and leaves out a must-include still fails.
  const full =
    countVisits(candidate.fixed.map((f) => f.stop)) >= PACE[candidate.day.pace].maxVisits;
  const fits = gaps(place, candidate).some((gap, index) =>
    fitsGap(place, date, gap, gapRoles(place, candidate.fixed, index, full)),
  );
  return { fit: fits ? "fits" : "no_room" };
}

/** What a place may be in one gap: the meals it may take, and whether it may be a visit. */
interface GapRoles {
  meals: Meal[];
  visit: boolean;
}

/**
 * The roles the place may take in the gap before fixed stop `index` (or after the last). A
 * place that is not a meal place is a visit, while the day has a visit slot left. A meal place
 * takes a meal it serves that no fixed stop takes; only when every such meal is taken may it be
 * a visit, and then only after the last fixed stop that takes one.
 */
// Decision: a meal place counts as a meal, or as a visit once its meals are gone. Roles are
// inferred from arrival times (inferRole), and the planner never visits a meal place before the
// meal it could have been, so "it would fit as a visit at 10:00" or "as a second lunch" is not
// a plan it can produce; claiming either would turn an honest warning into a false
// MUST_INCLUDE_MISSING error.
function gapRoles(
  place: Place,
  fixed: readonly { stop: Stop }[],
  index: number,
  full: boolean,
): GapRoles {
  if (!isMealPlace(place)) return { meals: [], visit: !full };
  const served = (["lunch", "dinner"] as const).filter((meal) => servesMeal(place, meal));
  const taken = fixed.map((f) => f.stop.role);
  const open = served.filter((meal) => !taken.includes(meal));
  if (open.length > 0) return { meals: open, visit: false };
  let lastMeal = -1;
  fixed.forEach((f, at) => {
    if (f.stop.role !== "visit" && served.includes(f.stop.role)) lastMeal = at;
  });
  return { meals: [], visit: !full && index > lastMeal };
}

interface Gap {
  notBefore: number; // earliest start, after travel and buffer from the stop before
  latestEnd: number; // latest end, leaving travel and buffer to the stop after (or the base)
  dinnerLatestEnd: number; // the same for a dinner, which may end the day (latestReturn)
}

/** The gap after the last fixed stop: the place must end in the window and get back in time. */
function lastGap(notBefore: number, place: Place, window: DayWindow, origin: LatLng): Gap {
  const back = travelMinutes(place, origin);
  const dinnerBack = latestReturn(window.end, "dinner") - back;
  return {
    notBefore,
    latestEnd: window.end - back,
    dinnerLatestEnd: Math.min(window.end, dinnerBack),
  };
}

/** The whole day for the place alone: from its first leg to the trip back before the end. */
function aloneGap(place: Place, window: DayWindow, origin: LatLng): Gap {
  return lastGap(window.start + travelMinutes(origin, place), place, window, origin);
}

/** The free gaps around the fixed stops, from the day start to the trip back at the end. */
function gaps(place: Place, candidate: Candidate): Gap[] {
  const result: Gap[] = [];
  let notBefore = candidate.window.start + travelMinutes(candidate.origin, place);
  for (const { stop, place: other } of candidate.fixed) {
    const travel = travelMinutes(place, other);
    const latestEnd = stop.start - travel - TRAVEL.bufferMin;
    result.push({ notBefore, latestEnd, dinnerLatestEnd: latestEnd });
    notBefore = stop.end + travel + TRAVEL.bufferMin;
  }
  result.push(lastGap(notBefore, place, candidate.window, candidate.origin));
  return result;
}

/** True when the place fits the gap in one of the roles it may take there (gapRoles). */
function fitsGap(place: Place, date: string, gap: Gap, roles: GapRoles): boolean {
  const duration = place.durationMin;
  if (roles.visit) {
    const start = earliestOpenStart(place, date, gap.notBefore, duration);
    if (start !== null && start + duration <= gap.latestEnd) return true;
  }
  return roles.meals.some((meal) => {
    const start = earliestMealStart(place, date, gap.notBefore, meal, duration);
    const latestEnd = meal === "dinner" ? gap.dinnerLatestEnd : gap.latestEnd;
    return start !== null && start + duration <= latestEnd;
  });
}
