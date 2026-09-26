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
import { dayText, dayTitle, listText } from "./validate/text";
import { isError } from "./violations";

// Which cities one day of an existing trip can move to, each with a reason when it cannot. The
// page lists them when the traveler changes a day's city, and POST /api/plan/day refuses any
// other with the same reason. A city is allowed when the trip keeps at most MAX_ANCHORS_PER_TRIP
// bases and changes base at most once, the day holds no must-include of its current base, and the
// rules-only day there (planDay.ts) is not empty and leaves the trip with no new error from the
// validator: not on this day, and not on the next one, which starts after a different transfer.
// Decision: a trip changes base at most once, as the whole-trip planner's arrangements do
// (planAnchors.ts: "no trip goes back and forth"), so Rome, Florence, Rome is refused even when
// the validator would pass it. Its must-include check assumes a single base change
// (validate/mustIncludeFit.ts), and a day away costs two long transfers: Milan, Florence, Milan
// is 2 h 15 min each way for one day. The reason says which neighbouring day to move first when
// that move is allowed, so the traveler can still get there a day at a time (Rome, Rome,
// Florence, then Rome, Florence, Florence). Over 60 one-base trips (every base, pace and budget,
// dates across 2026 and 2027), day 3 could move to another city in all 60, day 1 in 33 and day 2
// in none, and once day 3 had moved, day 2 could follow it to the same city in 59.

/** Which rule keeps a day from a base. */
export type DayRefusal =
  | "too_many_bases" // the trip would use more than MAX_ANCHORS_PER_TRIP bases
  | "back_and_forth" // the trip would leave a base and come back to it
  | "holds_must_include" // the day holds a must-include of its current base
  | "nothing_fits" // the rules-only day there is empty
  | "new_error"; // the trip would gain an error from the validator, the next day's included

/** One city a day can take, or the reason it cannot. */
export interface DayBaseOption {
  anchorId: string;
  name: string; // the base's city name
  current: boolean; // the day's base now: choosing it plans a new version of the day
  allowed: boolean;
  reason?: string; // why not, one short sentence for the traveler; set only when not allowed
  refusal?: DayRefusal; // the rule behind `reason`; set only when not allowed
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

/**
 * The verdict for one base. `hint` adds which day to move first to a refusal that another move
 * would lift; the checks behind a hint run without one, so they never ask each other back.
 */
function checkWith(
  request: TripRequest,
  days: readonly DaySelection[],
  dayIndex: number,
  anchorId: string,
  ctx: PlannerContext,
  options: ReplanOptions,
  before: readonly Violation[],
  hint = true,
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
  const refuse = (refusal: DayRefusal, reason: string): DayBaseCheck => ({
    option: { ...option, allowed: false, reason, refusal },
    day: null,
  });
  // The first of these days that can move to this base, as "Move day 3 to Florence first.".
  const moveFirst = (candidates: readonly number[]): string => {
    if (!hint) return "";
    const first = candidates.find((index) => {
      const other = days[index];
      if (other === undefined || other.anchorId === anchorId) return false;
      return checkWith(request, days, index, anchorId, ctx, {}, before, false).day !== null;
    });
    return first === undefined ? "" : ` Move ${dayText(first)} to ${anchor.name} first.`;
  };
  const bases = new Set(arrangement);
  if (bases.size > MAX_ANCHORS_PER_TRIP) {
    const others = [...new Set(arrangement.filter((_, index) => index !== dayIndex))];
    const names = others.map((id) => ctx.anchorById.get(id)?.name ?? id);
    return refuse(
      "too_many_bases",
      `A trip can use at most ${MAX_ANCHORS_PER_TRIP} cities, and the other days use ${listText(names)}.`,
    );
  }
  if (!current) {
    const held = heldMustInclude(request, days, dayIndex, ctx);
    if (held !== null) {
      return refuse(
        "holds_must_include",
        `${dayTitle(dayIndex)} has ${held}, which you asked for.`,
      );
    }
    if (baseChanges(arrangement) > 1) {
      // At most two bases, so the trip starts in one, goes to the other and comes back.
      const start = arrangement[0] as string;
      const [from, via] = [start, arrangement.find((id) => id !== start) as string].map(
        (id) => ctx.anchorById.get(id)?.name ?? id,
      );
      return refuse(
        "back_and_forth",
        `A trip changes city once at most, so it cannot go from ${from} to ${via} and back.${moveFirst([dayIndex + 1, dayIndex - 1])}`,
      );
    }
  }
  const day = planDay(request, days, dayIndex, anchorId, ctx, options);
  if (day.placeIds.length === 0) {
    return refuse(
      "nothing_fits",
      `Nothing in ${anchor.name} fits ${dayText(dayIndex)} with your settings.`,
    );
  }
  const errors = newTripErrors(request, days, dayIndex, day, ctx, before);
  const first = errors[0];
  if (first === undefined) return { option, day };
  if (first.day !== dayIndex + 1) return refuse("new_error", first.detail);
  const next = dayTitle(dayIndex + 1);
  if (option.transferOutMin === 0) {
    return refuse("new_error", `${next}'s plan would not fit its new start time.`);
  }
  const late = `${next} would start after ${formatDuration(option.transferOutMin)} of travel from ${anchor.name}, and its plan would not fit.`;
  return refuse("new_error", `${late}${moveFirst([dayIndex + 1])}`);
}

/** How many times the trip changes base from one day to the next. */
function baseChanges(arrangement: readonly string[]): number {
  return arrangement.filter((id, index) => index > 0 && id !== arrangement[index - 1]).length;
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
