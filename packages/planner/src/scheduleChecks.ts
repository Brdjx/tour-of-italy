import { LATEST_MINUTE, LONG_TRANSFER_MIN, MIN_SUGGEST_RATING, PACE } from "./config";
import {
  belongsToAnchor,
  coversMeal,
  dayWindow,
  isExcluded,
  sharesLocation,
  withinBudget,
} from "./constraints";
import type { PlannerContext } from "./context";
import { formatClock, hoursOn, openStatusOn, WEEKDAY_SHORT, weekdayOf } from "./time";
import { formatDuration, latestReturn } from "./travel";
import type { Anchor, Meal, Place, Stop, TripRequest, Violation, ViolationCode } from "./types";
import { makeViolation, type ViolationTarget } from "./violations";

// The problems scheduleDay reports while timing a day. Each check reads the stop the scheduler
// just timed; the independent validator (validate.ts) recomputes its own answers from scratch.
// Both build violations with makeViolation (violations.ts), so a code has one severity.

/** Everything the stop checks need to know about the stop just timed. */
export interface StopCheck {
  place: Place;
  stop: Stop;
  fits: boolean; // the hours (or meal window) allowed this start
  date: string;
  anchor: Anchor;
  request: TripRequest;
  ctx: PlannerContext;
  transferMin: number;
  earlier: readonly Place[]; // places earlier in the same day
  target: ViolationTarget;
}

/** Problems with one timed stop, errors first. */
export function stopViolations(check: StopCheck): Violation[] {
  const { place, stop, request, target } = check;
  const found: Violation[] = [];
  const add = (code: ViolationCode, detail: string) =>
    found.push(makeViolation(code, detail, target));
  if (isExcluded(place, request)) add("EXCLUDED_PLACE", `${place.name} is on your excluded list.`);
  if (check.earlier.some((other) => other.id === place.id)) {
    add("DUPLICATE_PLACE", `${place.name} appears twice in this day.`);
  }
  if (!belongsToAnchor(place.id, check.anchor.id, check.ctx)) {
    add("OUTSIDE_ANCHOR", `${place.name} is not part of the ${check.anchor.name} base.`);
  }
  // Decision: a stop an overfull day pushes past LATEST_MINUTE is INVALID_TIME, with no hours or
  // window check, exactly as the validator reports it. Before, this side said "closed" and
  // "outside the window" with times wrapped onto the next morning's clock (see disagreement 1 in
  // test/disagreements.test.ts).
  if (stop.end > LATEST_MINUTE) {
    add("INVALID_TIME", `${place.name} would run past 06:00 the next morning, outside this day.`);
  } else {
    found.push(...timingViolations(check));
  }
  if (!withinBudget(place, request.maxPriceLevel)) {
    add("OVER_BUDGET", `${place.name} is above your budget.`);
  }
  if (place.rating !== null && place.rating < MIN_SUGGEST_RATING) {
    add("LOW_RATING", `${place.name} is rated ${place.rating}, below ${MIN_SUGGEST_RATING}.`);
  }
  const twin = check.earlier.find((other) => sharesLocation(other, place));
  if (twin) add("SAME_LOCATION", `${place.name} is at the same spot as ${twin.name}.`);
  return found;
}

/** Hours and day-window problems for a stop timed inside the day (end at most LATEST_MINUTE). */
function timingViolations(check: StopCheck): Violation[] {
  const { place, stop, date, request, target } = check;
  const found: Violation[] = [];
  if (!check.fits) {
    const closed = closedDetail(place, date, stop);
    found.push(makeViolation(closed.code, closed.detail, target));
  } else if (hoursOn(place, date) === "unknown") {
    const detail = `Opening hours for ${place.name} are not confirmed for this date.`;
    found.push(makeViolation("HOURS_UNKNOWN", detail, target));
  }
  const window = dayWindow(request.pace, check.transferMin);
  if (stop.start < window.start || stop.end > window.end) {
    const span = `${formatClock(stop.start)} to ${formatClock(stop.end)}`;
    const allowed = `${formatClock(window.start)} to ${formatClock(window.end)}`;
    const detail = `${place.name} would run ${span}, outside this day's ${allowed}.`;
    found.push(makeViolation("OUTSIDE_DAY_WINDOW", detail, target));
  }
  return found;
}

/** Why a stop does not fit the hours: a season or date rule, a weekly closure, or the time. */
function closedDetail(place: Place, date: string, stop: Stop): Pick<Violation, "code" | "detail"> {
  const status = openStatusOn(place, date);
  const day = `${WEEKDAY_SHORT[weekdayOf(date)]} ${date}`;
  if (status.state === "closed" && status.reason === "season") {
    return { code: "SEASONAL_CLOSED", detail: `${place.name} is closed for the season on ${day}.` };
  }
  if (status.state === "closed" && status.reason === "date_rule") {
    return {
      code: "SEASONAL_CLOSED",
      detail: `${place.name} only opens on some dates, not ${day}.`,
    };
  }
  if (status.state === "closed") {
    return { code: "CLOSED_AT_TIME", detail: `${place.name} is closed on ${day}.` };
  }
  const span = `${formatClock(stop.start)} to ${formatClock(stop.end)}`;
  const detail = `${place.name} is not open for the whole visit, ${span}.`;
  return { code: "CLOSED_AT_TIME", detail };
}

/** A timed day as dayViolations sees it: stops and their places, in the same order. */
export interface TimedDay {
  stops: readonly Stop[];
  places: readonly Place[]; // places[i] is the place of stops[i]
  request: TripRequest;
  transferMin: number;
  returnMin: number; // travel from the last stop back to the day's start point
  day: number | undefined; // day index for the violations
  anchor: Anchor;
}

/**
 * Problems with the day as a whole: no stops, too many visits, no time to get back to the base,
 * missing meals, a long transfer, and a base the traveler did not choose.
 */
export function dayViolations(timed: TimedDay): Violation[] {
  const { stops, request, day, anchor } = timed;
  const found: Violation[] = [];
  if (stops.length === 0) {
    found.push(makeViolation("EMPTY_DAY", "This day has no stops.", { day }));
  }
  const maxVisits = PACE[request.pace].maxVisits;
  let visits = 0;
  stops.forEach((stop, stopIndex) => {
    if (stop.role !== "visit") return;
    visits++;
    if (visits === maxVisits + 1) {
      const detail = `A ${request.pace} day allows ${maxVisits} visits, not counting meals.`;
      found.push(makeViolation("TOO_MANY_VISITS", detail, { day, stopIndex }));
    }
  });
  found.push(...returnViolations(timed));
  // Decision: an empty day reports only EMPTY_DAY; "no lunch" on a day with no stops is noise.
  if (stops.length > 0) {
    for (const meal of ["lunch", "dinner"] as const satisfies readonly Meal[]) {
      if (hasMeal(timed, meal)) continue;
      found.push(makeViolation("MEAL_MISSING", `No ${meal} stop on this day.`, { day }));
    }
  }
  if (timed.transferMin > LONG_TRANSFER_MIN) {
    const detail = `The day starts with a ${formatDuration(timed.transferMin)} transfer from the previous base.`;
    found.push(makeViolation("LONG_TRANSFER", detail, { day }));
  }
  if (request.anchors !== "auto" && !request.anchors.includes(anchor.id)) {
    const detail = `This day is based in ${anchor.name}, which is not one of the bases you chose.`;
    found.push(makeViolation("ANCHOR_NOT_CHOSEN", detail, { day }));
  }
  return found;
}

/** A stop in that meal's role, or an outing under way through the whole meal window. */
function hasMeal(timed: TimedDay, meal: Meal): boolean {
  return timed.stops.some((stop, index) => {
    const place = timed.places[index];
    return (
      stop.role === meal || (place !== undefined && coversMeal(place, stop.start, stop.end, meal))
    );
  });
}

/**
 * The last stop must leave time to get back to the base before the day window closes (a little
 * later after a dinner: latestReturn). Reported only for a last stop that itself fits the window;
 * otherwise that stop already has its error.
 */
function returnViolations(timed: TimedDay): Violation[] {
  const last = timed.stops.at(-1);
  const place = timed.places.at(-1);
  if (!last || !place || last.end > LATEST_MINUTE) return [];
  const window = dayWindow(timed.request.pace, timed.transferMin);
  if (last.start < window.start || last.end > window.end) return [];
  const deadline = latestReturn(window.end, last.role);
  if (last.end + timed.returnMin <= deadline) return [];
  const back = formatClock(last.end + timed.returnMin);
  const after = last.role === "dinner" ? ", the latest return after dinner" : "";
  const detail = `${place.name} ends at ${formatClock(last.end)}, and the trip back to ${timed.anchor.name} takes ${formatDuration(timed.returnMin)}, so the day would end at ${back}, after ${formatClock(deadline)}${after}.`;
  const target = { day: timed.day, stopIndex: timed.stops.length - 1, placeId: place.id };
  return [makeViolation("OUTSIDE_DAY_WINDOW", detail, target)];
}
