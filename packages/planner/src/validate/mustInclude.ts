import { dayOrigin } from "../anchors";
import { isExcluded, sharesLocation } from "../constraints";
import { anchorOfPlace, type PlannerContext } from "../context";
import { openStatusOn } from "../time";
import type { DateRule, Itinerary, Pace, Place, Violation } from "../types";
import { makeViolation } from "../violations";
import type { DayFacts } from "./days";
import {
  type Candidate,
  candidates,
  FIT_RANK,
  type Fit,
  fitOnDay,
  fitsEmptyDayAt,
} from "./mustIncludeFit";
import { dateText, dayText, listText, noteText } from "./text";

// Must-include checks. A requested place missing from the plan is an error only when it is
// placeable; otherwise it is a warning that says why. The rule is deliberately conservative: a
// false error would make even the rules-only fallback plan fail, while a missed place with an
// honest reason only disappoints. The full rule is in the comment on placeability().

/** The verdict for one missing must-include place. */
export type Placeability = { placeable: true; day: number } | { placeable: false; reason: string };

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
      out.push(makeViolation("MUST_INCLUDE_MISSING", detail, { day: verdict.day, placeId: id }));
    } else {
      const detail = `${name} could not be included: ${verdict.reason}.`;
      out.push(makeViolation("MUST_INCLUDE_UNPLACEABLE", detail, { placeId: id }));
    }
  }
  return out;
}

/**
 * The placeability rule. A missing must-include place P is placeable when ALL of these hold:
 * 1. P is a known place and the traveler did not also exclude it.
 * 2. P does not share a spot with another must-include place that is already in the plan.
 * 3. P is open on some trip date, and on some trip date it fits an empty day at its own base.
 * 4. There is a candidate day. If some day is based at P's base, the candidates are those days.
 *    Otherwise P's base must be allowed (anchors "auto", or listed in request.anchors), the plan
 *    must use fewer than MAX_ANCHORS_PER_TRIP bases, and the candidates are the first and the last
 *    day when they hold no must-include stop, each imagined moved to P's base with the transfer
 *    from the day before.
 * 5. On some candidate day, P fits: its date is open (season, date, and weekday rules applied;
 *    unknown hours count as open) and a whole visit fits one open range inside the day window,
 *    starting no earlier than the window start plus travel from the day's start point and ending
 *    in time to travel back there; AND it fits between the must-include stops already on that
 *    day (travel plus buffer both sides; other stops are ignored because a plan may drop them);
 *    AND P can take a role there: a visit while the day has a visit slot left; a meal place as a
 *    lunch or dinner it serves that no fixed stop takes, inside that meal's window, or, once
 *    every meal it serves is taken, as a visit after the last of them (gapRoles).
 * When P is not placeable, the reason is the first rule that fails, and for rule 5 the best
 * outcome over the candidate days.
 */
// Decision: rule 3 comes before the bases (rule 4). A place closed on every trip date used to be
// explained as "its base is not in this trip", which invites a change that cannot help.
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
  const neverFits = tripDateReason(place, days, request.pace, dayOrigin(anchor, request));
  if (neverFits) return { placeable: false, reason: neverFits };
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
  return { placeable: false, reason: failureReason(best, picked, request.pace) };
}

/**
 * Rule 3: the reason when the place is closed on every trip date, or fits no trip date even on
 * an empty day at its own base; null when some date could work. Days without a real date are
 * skipped (they have their own WRONG_DATE error).
 */
function tripDateReason(
  place: Place,
  days: readonly DayFacts[],
  pace: Pace,
  origin: { lat: number; lng: number },
): string | null {
  const dates = days.flatMap((day) => (day.date === null ? [] : [day.date]));
  if (dates.length === 0) return null;
  const statuses = dates.map((date) => openStatusOn(place, date));
  if (statuses.every((status) => status.state === "closed")) {
    const first = statuses[0];
    const rule = first?.state === "closed" ? first.rule : undefined;
    return `it is closed on every day of this trip${noteText(rule?.source)}`;
  }
  if (!dates.some((date) => fitsEmptyDayAt(place, date, pace, origin))) {
    return `its opening hours do not fit a ${pace} day on any day of this trip`;
  }
  return null;
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

/** The traveler-facing reason for the best failed outcome on the candidate days. */
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
