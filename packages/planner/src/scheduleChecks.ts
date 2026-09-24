import { LATEST_MINUTE, LONG_TRANSFER_MIN, MIN_SUGGEST_RATING, PACE } from "./config";
import {
  belongsToAnchor,
  dayWindow,
  isExcluded,
  sharesLocation,
  withinBudget,
} from "./constraints";
import type { PlannerContext } from "./context";
import { formatClock, hoursOn, openStatusOn, WEEKDAY_SHORT, weekdayOf } from "./time";
import { formatDuration } from "./travel";
import type { Anchor, Meal, Place, Stop, TripRequest, Violation, ViolationCode } from "./types";

// The problems scheduleDay reports while timing a day. Each check reads the stop the scheduler
// just timed; the independent validator (validate.ts) recomputes its own answers from scratch.

/** Codes that are warnings. Every other code is an error that must never reach the traveler. */
const WARNING_CODES: ReadonlySet<ViolationCode> = new Set<ViolationCode>([
  "MUST_INCLUDE_UNPLACEABLE",
  "HOURS_UNKNOWN",
  "OVER_BUDGET",
  "MEAL_MISSING",
  "LONG_TRANSFER",
  "SAME_LOCATION",
  "LOW_RATING",
  "ANCHOR_NOT_CHOSEN",
]);

/** Where a violation points: a day, a stop in it, and a place. All optional. */
export interface ViolationTarget {
  day?: number | undefined;
  stopIndex?: number | undefined;
  placeId?: string | undefined;
}

/** A violation with its severity from the code, keys in a fixed order for stable JSON. */
export function makeViolation(
  code: ViolationCode,
  detail: string,
  target: ViolationTarget = {},
): Violation {
  return {
    code,
    severity: WARNING_CODES.has(code) ? "warning" : "error",
    ...(target.day === undefined ? {} : { day: target.day }),
    ...(target.stopIndex === undefined ? {} : { stopIndex: target.stopIndex }),
    // Decision: cut ids to the schema's 64 characters. An unknown id comes from the model or a
    // shared link and must not make the violation itself fail the response schema.
    ...(target.placeId === undefined ? {} : { placeId: target.placeId.slice(0, 64) }),
    detail,
  };
}

/** True for a violation that must never reach the traveler. */
export function isError(violation: Violation): boolean {
  return violation.severity === "error";
}

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
  // "outside the window" with times wrapped onto the next morning's clock (property tests,
  // disagreement 1 in the T17 report).
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

/**
 * Problems with the day as a whole: no stops, too many visits, missing meals, a long transfer,
 * and a base the traveler did not choose.
 */
export function dayViolations(
  stops: readonly Stop[],
  request: TripRequest,
  transferMin: number,
  day: number | undefined,
  anchor?: Anchor,
): Violation[] {
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
  // Decision: an empty day reports only EMPTY_DAY; "no lunch" on a day with no stops is noise.
  if (stops.length > 0) {
    for (const meal of ["lunch", "dinner"] as const satisfies readonly Meal[]) {
      if (stops.some((stop) => stop.role === meal)) continue;
      found.push(makeViolation("MEAL_MISSING", `No ${meal} stop on this day.`, { day }));
    }
  }
  if (transferMin > LONG_TRANSFER_MIN) {
    const detail = `The day starts with a ${formatDuration(transferMin)} transfer from the previous base.`;
    found.push(makeViolation("LONG_TRANSFER", detail, { day }));
  }
  // Decision: reported here as well as by the validator, so rescheduleDay (which refreshes a
  // day's warnings from this list after an edit) keeps the note instead of dropping it.
  if (anchor && request.anchors !== "auto" && !request.anchors.includes(anchor.id)) {
    const detail = `This day is based in ${anchor.name}, which is not one of the bases you chose.`;
    found.push(makeViolation("ANCHOR_NOT_CHOSEN", detail, { day }));
  }
  return found;
}
