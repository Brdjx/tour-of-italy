import { transferMinutes } from "../anchors";
import { LATEST_MINUTE, LONG_TRANSFER_MIN, PACE } from "../config";
import { type DayWindow, dayWindow } from "../constraints";
import type { PlannerContext } from "../context";
import { addDays, isValidIsoDate } from "../time";
import { formatDuration, travelLeg } from "../travel";
import type {
  Anchor,
  DayPlan,
  Itinerary,
  Meal,
  Pace,
  Stop,
  TripRequest,
  Violation,
} from "../types";
import { dateText, dayText, dayTitle, listText } from "./text";
import { violation } from "./violations";

// Day-level facts and checks. The validator never trusts a day's own claims: the transfer is
// recomputed from the two bases, and the day window is built from that recomputed transfer.

/** Latest minute a stop time may take (06:00 the next morning), shared with the scheduler. */
export { LATEST_MINUTE };

/** Longest transfer or leg a plan may claim, matching the API schema. */
export const MAX_TRAVEL_MINUTES = 1440;

/** What the validator knows about one day, computed once and shared by every check. */
export interface DayFacts {
  index: number; // 0-based position in the trip
  plan: DayPlan; // the day as given
  pace: Pace; // the trip's pace
  date: string | null; // the day's date when it is a real calendar date
  anchor: Anchor | undefined; // the day's base, undefined when it is not a known base
  previousAnchor: Anchor | undefined; // the base of the day before, undefined on day 1
  transferMin: number; // the transfer the day really needs (see realTransfer)
  transferKnown: boolean; // true when transferMin was recomputed rather than taken on trust
  window: DayWindow; // when stops may happen, after the transfer
}

/** True for a whole number of minutes from 0 to max. */
export function isMinuteCount(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * True when the stop's times are whole minutes in 0..LATEST_MINUTE and it ends after it starts.
 * Only such stops get hours, window, and overlap checks; the others get INVALID_TIME.
 */
export function hasValidTimes(stop: Pick<Stop, "start" | "end">): boolean {
  return (
    isMinuteCount(stop.start, LATEST_MINUTE) &&
    isMinuteCount(stop.end, LATEST_MINUTE) &&
    stop.end > stop.start
  );
}

/** Facts for every day, in order. Never throws. */
export function buildDayFacts(itinerary: Itinerary, ctx: PlannerContext): DayFacts[] {
  const pace = itinerary.request.pace;
  const facts: DayFacts[] = [];
  let previousAnchor: Anchor | undefined;
  itinerary.days.forEach((plan, index) => {
    const anchor = ctx.anchorById.get(plan.anchorId);
    const transfer = realTransfer(index, plan, previousAnchor, anchor);
    facts.push({
      index,
      plan,
      pace,
      date: isValidIsoDate(plan.date) ? plan.date : null,
      anchor,
      previousAnchor: index === 0 ? undefined : previousAnchor,
      transferMin: transfer.minutes,
      transferKnown: transfer.known,
      window: dayWindow(pace, transfer.minutes),
    });
    previousAnchor = anchor;
  });
  return facts;
}

/**
 * The transfer a day needs: 0 on day 1, else the travel between the two bases' centroids.
 * When either base is unknown it cannot be recomputed; the day's claim is used if it is a valid
 * number (the plan already has an UNKNOWN_ANCHOR error), else 0.
 */
function realTransfer(
  index: number,
  plan: DayPlan,
  previous: Anchor | undefined,
  current: Anchor | undefined,
): { minutes: number; known: boolean } {
  if (index === 0) return { minutes: 0, known: true };
  if (previous && current) return { minutes: transferMinutes(previous, current), known: true };
  const claimed = isMinuteCount(plan.transferMin, MAX_TRAVEL_MINUTES) ? plan.transferMin : 0;
  return { minutes: claimed, known: false };
}

/** Checks on the day itself, before its stops: date, base, transfer, emptiness, chosen base. */
export function checkDayHeader(
  day: DayFacts,
  request: TripRequest,
  ctx: PlannerContext,
): Violation[] {
  const out: Violation[] = [];
  const target = { day: day.index };
  const dateProblem = wrongDate(day, request);
  if (dateProblem) out.push(violation("WRONG_DATE", dateProblem, target));
  if (!day.anchor) {
    out.push(
      violation(
        "UNKNOWN_ANCHOR",
        `${dayTitle(day.index)} uses a base that is not in our data.`,
        target,
      ),
    );
  }
  const transferProblem = wrongTransfer(day);
  if (transferProblem) out.push(violation("WRONG_TRAVEL", transferProblem, target));
  if (
    day.transferKnown &&
    day.transferMin > LONG_TRANSFER_MIN &&
    day.previousAnchor &&
    day.anchor
  ) {
    const leg = travelLeg(day.previousAnchor.centroid, day.anchor.centroid);
    const detail = `${dayTitle(day.index)} starts with ${leg.label} from ${day.previousAnchor.name} to ${day.anchor.name}, so there is less time to visit.`;
    out.push(violation("LONG_TRANSFER", detail, target));
  }
  if (day.plan.stops.length === 0) {
    out.push(violation("EMPTY_DAY", `${dayTitle(day.index)} has no stops.`, target));
  }
  const notChosen = notChosenText(day, request, ctx);
  if (notChosen) out.push(violation("ANCHOR_NOT_CHOSEN", notChosen, target));
  return out;
}

/**
 * Why the day's known base is not one the traveler chose, or null. A warning, not an error: the
 * rules-only planner leaves a chosen base only when it cannot hold a stop on every day even with
 * fewer visits a day, and that fallback plan must still reach the traveler, with this note.
 */
// Decision: found by the T17 property tests. The planner treated chosen bases as a preference
// while this validator's must-include reasons treated them as binding, and a day at a base the
// traveler never chose passed with no explanation. The text states the fact only: the validator
// cannot know why a plan (the planner's or the model's) left the chosen bases.
function notChosenText(day: DayFacts, request: TripRequest, ctx: PlannerContext): string | null {
  if (request.anchors === "auto" || !day.anchor) return null;
  if (request.anchors.includes(day.anchor.id)) return null;
  const names = request.anchors.map((id) => ctx.anchorById.get(id)?.name ?? "an unknown base");
  return `${dayTitle(day.index)} is based in ${day.anchor.name}, which is not one of the bases you chose (${listText(names)}).`;
}

/** Why the day's date is wrong, or null. Day i must be the start date plus i days. */
function wrongDate(day: DayFacts, request: TripRequest): string | null {
  const title = dayTitle(day.index);
  if (day.date === null) return `${title} does not have a real calendar date.`;
  if (!isValidIsoDate(request.startDate)) {
    return `The trip start date is not a real calendar date, so ${dayText(day.index)} cannot be placed.`;
  }
  const expected = addDays(request.startDate, day.index);
  if (day.date === expected) return null;
  return `${title} is dated ${dateText(day.date)}, but a trip starting ${dateText(request.startDate)} has ${dateText(expected)} as ${dayText(day.index)}.`;
}

/** Why the day's claimed transfer is wrong, or null. */
function wrongTransfer(day: DayFacts): string | null {
  const title = dayTitle(day.index);
  const claimed = day.plan.transferMin;
  if (!isMinuteCount(claimed, MAX_TRAVEL_MINUTES)) {
    return `${title} has a transfer time that is not a valid number of minutes.`;
  }
  if (!day.transferKnown || claimed === day.transferMin) return null;
  const says = formatDuration(claimed);
  if (day.index === 0)
    return `${title} starts the trip, so it has no transfer, but it lists ${says}.`;
  const from = day.previousAnchor;
  const to = day.anchor;
  if (!from || !to || from.id === to.id) {
    return `${title} stays in the same base as the day before, so it has no transfer, but it lists ${says}.`;
  }
  const leg = travelLeg(from.centroid, to.centroid);
  return `${title} lists ${says} to move from ${from.name} to ${to.name}, but the move takes ${leg.label}.`;
}

/**
 * Stops that count toward the pace's visit cap: every "visit", plus any lunch or dinner after
 * the first of its kind that day.
 */
// Decision: only one lunch and one dinner a day are free of the cap. Otherwise labelling extra
// stops as meals would let a plan slip past maxVisits.
export function countVisits(stops: readonly Pick<Stop, "role">[]): number {
  let visits = 0;
  const meals = new Set<string>();
  for (const stop of stops) {
    if (stop.role === "visit" || meals.has(stop.role)) visits++;
    else meals.add(stop.role);
  }
  return visits;
}

/** Checks on the day as a whole, after its stops: the visit cap and the two meals. */
export function checkDayTotals(day: DayFacts): Violation[] {
  const stops = day.plan.stops;
  if (stops.length === 0) return []; // EMPTY_DAY already says it all
  const out: Violation[] = [];
  const target = { day: day.index };
  const title = dayTitle(day.index);
  const visits = countVisits(stops);
  const max = PACE[day.pace].maxVisits;
  if (visits > max) {
    const detail = `${title} has ${visits} visits, but a ${day.pace} day has at most ${max}.`;
    out.push(violation("TOO_MANY_VISITS", detail, target));
  }
  const meals: Meal[] = ["lunch", "dinner"];
  for (const meal of meals) {
    if (stops.some((stop) => stop.role === meal)) continue;
    out.push(violation("MEAL_MISSING", `${title} has no ${meal} stop.`, target));
  }
  return out;
}
