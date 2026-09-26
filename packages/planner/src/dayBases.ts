import type { PlannerContext } from "./context";
import { newTripErrors, tripErrors } from "./dayChecks";
import { type DayRefusal, dayTravel, planRoute, type RoutePlan } from "./dayRoute";
import { dayMustIncludes, planDay, type ReplanOptions } from "./planDay";
import { requireIndex } from "./stopEdits";
import { formatDuration } from "./travel";
import type { DaySelection } from "./trip";
import type { TripRequest, Violation } from "./types";
import { dayText, dayTitle } from "./validate/text";

// Which cities one day of an existing trip can take, each with its facts and, when it cannot, a
// reason and a way out. The page lists them when the traveler changes a day's city. Another city
// is judged as a route (dayRoute.ts): the trip with that one day moved, which may plan the next
// day again when it no longer fits its new start, or a day of the same city to hold a place the
// traveler asked for. The day's own city is a new version of the day (checkDayBase).
// checkDayBase is also the check for planning one day (POST /api/plan/day): with no route it
// changes no other day, so it refuses a city that would break another; for a day of a route the
// page sends the trip with the route's cities already in, and it checks that day alone.
// Decision: no city is refused for travel (decision 16). The first build refused a third city and
// any back and forth (Rome, Florence, Rome), and a day whose move made the next day not fit; the
// owner asked for a city a day even when it costs travel, so those are warnings now, with the
// travel as facts, and the next day is planned again instead.

/** One city a day can take, or the reason it cannot. */
export interface DayBaseOption {
  anchorId: string;
  name: string; // the base's city name
  current: boolean; // the day's base now: choosing it plans a new version of the day
  allowed: boolean;
  reason?: string; // why not, one short sentence for the traveler; set only when not allowed
  fix?: string; // the way out, one short sentence; set only when not allowed
  refusal?: DayRefusal; // the rule behind `reason`; set only when not allowed
  transferInMin: number; // travel into this day from the day before's base, 0 when none
  transferOutMin: number; // travel from this base to the next day's base, 0 when none
  warnings: string[]; // the facts: this day's travel, then what happens to the other days
  replans: number[]; // the other days (0-based) this choice plans again, in order
}

/** The verdict for one base, with the rules-only day planned there when it is allowed. */
export interface DayBaseCheck {
  option: DayBaseOption;
  day: DaySelection | null; // planDay's day at this base; null when the base is not allowed
}

/**
 * The verdict on planning day `dayIndex` at base `anchorId` with every other day as it is (another
 * city, or its own for a new version), with planDay's day there when it is allowed. Refused when
 * the day holds a must-include of its current base and moves, when nothing fits there, or when
 * the trip would gain an error from the validator (the next day's, after its new start,
 * included). For a day of a route, pass the trip with the route's cities in and the days still
 * to plan empty (routeStartDays): the day is then at its own city, and the later empty days are
 * not held against it. Throws RangeError on a day index out of range or an unknown base.
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
 * Every base as an option for day `dayIndex`: the day's own city first, as a new version of the
 * day (checkDayBase, with `options.avoid`), then the others in the context's order (most places
 * first), each as the route with only this day moved (routeOptions). Throws RangeError on a day
 * index out of range.
 */
export function dayBaseOptions(
  request: TripRequest,
  days: readonly DaySelection[],
  dayIndex: number,
  ctx: PlannerContext,
  options: ReplanOptions = {},
): DayBaseOption[] {
  requireIndex(dayIndex, days.length, "Day");
  const current = days[dayIndex]?.anchorId as string;
  const own = checkDayBase(request, days, dayIndex, current, ctx, options).option;
  const route = days.map((day) => day.anchorId);
  const others = routeOptions(request, days, route, dayIndex, ctx).filter((o) => !o.current);
  return [own, ...others];
}

/**
 * Every base as an option for day `dayIndex` of a route the traveler is setting (`route`, a base
 * a day, starting from the trip's own): the trip's city for the day first, then the others in the
 * context's order, each judged as `route` with this day's city changed (planRoute). The page's
 * route editor lists these for each day. Throws RangeError on a day index out of range or a route
 * that is not a known base for every day.
 */
export function routeOptions(
  request: TripRequest,
  days: readonly DaySelection[],
  route: readonly string[],
  dayIndex: number,
  ctx: PlannerContext,
): DayBaseOption[] {
  requireIndex(dayIndex, days.length, "Day");
  const current = days[dayIndex]?.anchorId;
  const ids = ctx.anchors.map((anchor) => anchor.id);
  const ordered = [...ids.filter((id) => id === current), ...ids.filter((id) => id !== current)];
  return ordered.map((anchorId) => {
    const target = route.map((id, index) => (index === dayIndex ? anchorId : id));
    return routeOption(planRoute(request, days, target, ctx), dayIndex, anchorId === current);
  });
}

/** One route's verdict as an option for one of its days. */
function routeOption(plan: RoutePlan, dayIndex: number, current: boolean): DayBaseOption {
  const day = plan.days[dayIndex] as RoutePlan["days"][number];
  const others = plan.days.flatMap((other) =>
    other.day !== dayIndex && other.note !== null ? [other.note] : [],
  );
  const option: DayBaseOption = {
    anchorId: day.anchorId,
    name: day.name,
    current,
    allowed: plan.allowed,
    transferInMin: day.travelIn?.minutes ?? 0,
    transferOutMin: day.travelOut?.minutes ?? 0,
    warnings: [...day.warnings, ...others],
    replans: plan.replan.filter((index) => index !== dayIndex),
  };
  const refusal = plan.refusal;
  if (refusal === null) return option;
  return { ...option, reason: refusal.reason, fix: refusal.fix, refusal: refusal.code };
}

/** The verdict for one base with every other day as it is. */
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
  const travel = dayTravel(request, arrangement, dayIndex, ctx);
  const option: DayBaseOption = {
    anchorId,
    name: anchor.name,
    current,
    allowed: true,
    transferInMin: travel.travelIn?.minutes ?? 0,
    transferOutMin: travel.travelOut?.minutes ?? 0,
    warnings: travel.warnings,
    replans: [],
  };
  const refuse = (refusal: DayRefusal, reason: string, fix: string): DayBaseCheck => ({
    option: { ...option, allowed: false, reason, fix, refusal },
    day: null,
  });
  const elsewhere = `Choose another city for ${dayText(dayIndex)}.`;
  if (!current) {
    const held = heldMustInclude(request, days, dayIndex, ctx);
    if (held !== null) {
      const reason = `${dayTitle(dayIndex)} has ${held}, which you asked for.`;
      return refuse("holds_must_include", reason, `Remove ${held} from it first.`);
    }
  }
  const day = planDay(request, days, dayIndex, anchorId, ctx, options);
  if (day.placeIds.length === 0) {
    const inMin = option.transferInMin;
    const when = inMin === 0 ? "with your settings" : `after ${formatDuration(inMin)} of travel`;
    return refuse(
      "nothing_fits",
      `Nothing in ${anchor.name} fits ${dayText(dayIndex)} ${when}.`,
      elsewhere,
    );
  }
  const errors = newTripErrors(request, days, dayIndex, day, ctx, before);
  const first = errors[0];
  if (first === undefined) return { option, day };
  if (first.day !== dayIndex + 1) return refuse("new_error", first.detail, elsewhere);
  const next = dayTitle(dayIndex + 1);
  const again = `Plan ${dayText(dayIndex + 1)} again too.`;
  if (option.transferOutMin === 0) {
    return refuse("new_error", `${next}'s plan would not fit its new start time.`, again);
  }
  const late = `${next} would start after ${formatDuration(option.transferOutMin)} of travel from ${anchor.name}, and its plan would not fit.`;
  return refuse("new_error", late, again);
}

/**
 * The name of a must-include the day holds that would leave the trip with the day's base, or
 * null. A must-include the traveler also excluded, or an unknown id, does not count.
 */
// Decision: with every other day as it is, a day holding a place the traveler asked for keeps its
// city. Moving it would drop the place, and the page drops a must-include only when the traveler
// removes that stop themselves (rescheduleDay). A route may move the place to another day of its
// city (dayRoute.ts); this check plans one day only.
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
