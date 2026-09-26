import { MAX_ANCHORS_PER_TRIP } from "./config";
import type { PlannerContext } from "./context";
import { dayMustIncludes, planDay, type ReplanOptions, withDay } from "./planDay";
import { EPOCH_ISO } from "./planPolicy";
import { requireIndex } from "./stopEdits";
import { formatDuration } from "./travel";
import { type DaySelection, scheduleTrip } from "./trip";
import { transferInto } from "./tripWalk";
import type { Itinerary, TripRequest, Violation } from "./types";
import { validateItinerary } from "./validate";
import { dayTitle, listText } from "./validate/text";
import { isError } from "./violations";

// Which cities one day of an existing trip can move to, each with a reason when it cannot. The
// page lists them when the traveler changes a day's city, and POST /api/plan/day refuses any
// other with the same reason. A city is allowed when the trip keeps at most MAX_ANCHORS_PER_TRIP
// bases, the day holds no must-include of its current base, and the rules-only day there
// (planDay.ts) is not empty and leaves the trip with no new error from the validator: not on this
// day, and not on the next one, which starts after a different transfer.
// Decision: a day may move to a city the trip leaves again the next day (Rome, Florence, Rome)
// whenever the validator allows it. Its rule is at most two bases; the whole-trip planner's single
// move (planAnchors.ts) is how it ranks its own arrangements, not a rule a traveler's choice must
// follow. Such a move is usually refused all the same, because the next day then starts two hours
// or more later and its plan no longer fits; the reason says to move that next day first when that
// is allowed. Over 60 one-base trips (every base, pace and budget, dates across 2026 and 2027),
// day 3 could move to another city in all 60, day 1 in 33 and day 2 in 36, and once day 3 had
// moved, day 2 could follow it to the same city in 59.

/** One city a day can take, or the reason it cannot. */
export interface DayBaseOption {
  anchorId: string;
  name: string; // the base's city name
  current: boolean; // the day's base now: choosing it plans a new version of the day
  allowed: boolean;
  reason?: string; // why not, one short sentence for the traveler; set only when not allowed
  transferInMin: number; // travel into this day from the day before's base, 0 when none
  transferOutMin: number; // travel from this base to the next day's base, 0 when none
}

/** The verdict for one base, with the rules-only day planned there when it is allowed. */
export interface DayBaseCheck {
  option: DayBaseOption;
  day: DaySelection | null; // planDay's day at this base; null when the base is not allowed
}

/** The key of an error, to tell a new one from one the trip already had. */
const errorKey = (v: Violation) => `${v.code}|${v.day ?? ""}|${v.placeId ?? ""}`;

/** The validator's errors for the trip timed from its ids. */
function tripErrors(request: TripRequest, days: readonly DaySelection[], ctx: PlannerContext) {
  const itinerary: Itinerary = {
    request,
    days: scheduleTrip(request, days, ctx).days,
    source: "deterministic",
    warnings: [],
    meta: { attempts: 0, latencyMs: 0, generatedAt: EPOCH_ISO },
  };
  return validateItinerary(itinerary, ctx).filter(isError);
}

/**
 * The errors of the trip with day `dayIndex` replaced by `day` that it did not have before: any
 * error on that day, and any other error whose code, day and place the trip before did not have.
 * `before` is tripErrors of the trip as it was.
 */
// Decision: an error the trip already had elsewhere is not the re-plan's to fix, and it cannot
// fix it without changing another day. So a trip the traveler has already broken (an edit the page
// flagged) can still have a day re-planned, and the re-plan can never make it worse.
export function newTripErrors(
  request: TripRequest,
  days: readonly DaySelection[],
  dayIndex: number,
  day: DaySelection,
  ctx: PlannerContext,
  before: readonly Violation[] = tripErrors(request, days, ctx),
): Violation[] {
  const had = new Set(before.map(errorKey));
  const after = tripErrors(request, withDay(days, dayIndex, day), ctx);
  return after.filter((error) => error.day === dayIndex || !had.has(errorKey(error)));
}

/**
 * The verdict on moving day `dayIndex` to base `anchorId` (or planning it again at its own base),
 * with planDay's day there when it is allowed. Throws RangeError on a day index out of range or
 * an unknown base.
 */
export function checkDayBase(
  request: TripRequest,
  days: readonly DaySelection[],
  dayIndex: number,
  anchorId: string,
  ctx: PlannerContext,
  options: ReplanOptions = {},
): DayBaseCheck {
  return checkWith(request, days, dayIndex, anchorId, ctx, options, tripErrors(request, days, ctx));
}

/**
 * Every base as an option for day `dayIndex`: the day's own base first, then the others in the
 * context's order (most places first). Throws RangeError on a day index out of range.
 */
export function dayBaseOptions(
  request: TripRequest,
  days: readonly DaySelection[],
  dayIndex: number,
  ctx: PlannerContext,
  options: ReplanOptions = {},
): DayBaseOption[] {
  requireIndex(dayIndex, days.length, "Day");
  const before = tripErrors(request, days, ctx);
  const current = days[dayIndex]?.anchorId;
  const ids = ctx.anchors.map((anchor) => anchor.id);
  const ordered = [...ids.filter((id) => id === current), ...ids.filter((id) => id !== current)];
  return ordered.map((id) => checkWith(request, days, dayIndex, id, ctx, options, before).option);
}

function checkWith(
  request: TripRequest,
  days: readonly DaySelection[],
  dayIndex: number,
  anchorId: string,
  ctx: PlannerContext,
  options: ReplanOptions,
  before: readonly Violation[],
): DayBaseCheck {
  requireIndex(dayIndex, days.length, "Day");
  const anchor = ctx.anchorById.get(anchorId);
  if (!anchor) throw new RangeError(`"${anchorId}" is not a base`);
  const arrangement = days.map((day, index) => (index === dayIndex ? anchorId : day.anchorId));
  const current = days[dayIndex]?.anchorId === anchorId;
  const option: DayBaseOption = {
    anchorId,
    name: anchor.name,
    current,
    allowed: true,
    transferInMin: transferInto(arrangement, dayIndex, ctx),
    transferOutMin: dayIndex + 1 < days.length ? transferInto(arrangement, dayIndex + 1, ctx) : 0,
  };
  const refuse = (reason: string): DayBaseCheck => ({
    option: { ...option, allowed: false, reason },
    day: null,
  });
  const bases = new Set(arrangement);
  if (bases.size > MAX_ANCHORS_PER_TRIP) {
    const others = [...new Set(arrangement.filter((_, index) => index !== dayIndex))];
    const names = others.map((id) => ctx.anchorById.get(id)?.name ?? id);
    return refuse(
      `A trip can use at most ${MAX_ANCHORS_PER_TRIP} cities, and the other days use ${listText(names)}.`,
    );
  }
  if (!current) {
    const held = heldMustInclude(request, days, dayIndex, ctx);
    if (held !== null) return refuse(`${dayTitle(dayIndex)} has ${held}, which you asked for.`);
  }
  const day = planDay(request, days, dayIndex, anchorId, ctx, options);
  if (day.placeIds.length === 0) {
    return refuse(
      `Nothing in ${anchor.name} fits ${dayTitle(dayIndex).toLowerCase()} with your settings.`,
    );
  }
  const errors = newTripErrors(request, days, dayIndex, day, ctx, before);
  const first = errors[0];
  if (first === undefined) return { option, day };
  if (first.day !== dayIndex + 1) return refuse(first.detail);
  const next = dayTitle(dayIndex + 1);
  if (option.transferOutMin === 0) {
    return refuse(`${next}'s plan would not fit its new start time.`);
  }
  const late = `${next} would start after ${formatDuration(option.transferOutMin)} of travel from ${anchor.name}, and its plan would not fit.`;
  const nextFirst = checkWith(request, days, dayIndex + 1, anchorId, ctx, {}, before);
  return refuse(
    nextFirst.day === null ? late : `${late} Move ${next.toLowerCase()} to ${anchor.name} first.`,
  );
}

/**
 * The name of a must-include the day holds that would leave the trip with the day's base, or
 * null. A must-include the traveler also excluded, or an unknown id, does not count.
 */
// Decision: a day holding a place the traveler asked for keeps its city. Moving it would drop the
// place, and the page drops a must-include only when the traveler removes that stop themselves
// (rescheduleDay). The reason names the place, so they know what to remove first.
function heldMustInclude(
  request: TripRequest,
  days: readonly DaySelection[],
  dayIndex: number,
  ctx: PlannerContext,
): string | null {
  const day = days[dayIndex];
  const anchorId = day?.anchorId ?? "";
  const held = dayMustIncludes(request, days, dayIndex, anchorId, ctx).find((id) =>
    day?.placeIds.includes(id),
  );
  return held === undefined ? null : (ctx.placesById.get(held)?.name ?? held);
}
