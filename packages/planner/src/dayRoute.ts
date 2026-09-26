import { MEALS, PACE } from "./config";
import type { PlannerContext } from "./context";
import { errorKey, tripErrors } from "./dayChecks";
import { planDay } from "./planDay";
import { formatDuration, travelLeg } from "./travel";
import type { DaySelection } from "./trip";
import type { TripRequest } from "./types";
import { clockText, dayText, dayTitle } from "./validate/text";

// A route the traveler sets by hand: a city for every day of a trip that already exists, in any
// order, going back included (Rome, Florence, Rome). planRoute says what the route means before
// anything is planned: each day's city, the travel into it and when it starts, which days are
// planned again and why, the facts to warn about, and the rare refusals, each with a way out. The
// page runs it on every tap of the route editor, then plans the days it names one request at a
// time, in day order (POST /api/plan/day with the route), and applies them as one edit.
// Decision: travel is the traveler's choice (the owner, 2026-09-26: "allow the user to opt in
// despite extra travel"). No city is refused for the time it costs; the cost is stated as facts
// ("2 h 10 min by high-speed train from Rome, so the day starts at 11:40."). A route is refused
// only when it would lose a place the traveler asked for, or when nothing at all fits a day after
// its travel. The whole-trip planners keep their own rules (MAX_ANCHORS_PER_TRIP, one change of
// base, planAnchors.ts).

/** Why a day of a route is planned again. */
export type ReplanWhy =
  | "city" // its city changes
  | "travel" // its travel in changes and its stops no longer fit (the validator says so)
  | "must_include"; // it takes a place the traveler asked for from a day that no longer can

/** Which rule refuses a day's city. */
export type DayRefusal =
  | "holds_must_include" // the day holds a must-include that no day of the route can take
  | "nothing_fits" // the rules-only day there is empty
  | "new_error"; // the trip would gain an error from the validator

/** Why a route cannot be planned, and the way out. */
export interface RouteRefusal {
  code: DayRefusal;
  reason: string; // one short sentence for the traveler
  fix: string; // what to change, one short sentence
}

/** The travel between two days' cities. */
export interface RouteLeg {
  fromAnchorId: string;
  fromName: string;
  toAnchorId: string;
  toName: string;
  minutes: number; // the day's transfer, as the scheduler and the validator count it
  label: string; // "2 h 10 min by high-speed train"
}

/** A day's travel and what it leaves of the day. */
export interface DayTravel {
  travelIn: RouteLeg | null; // from the day before's city; null on day 1 and in the same city
  travelOut: RouteLeg | null; // on to the next day's city; null on the last day and in the same city
  startMin: number; // when the day's places can start: the pace's start plus travelIn
  freeMin: number; // from startMin to the opening of the dinner window
  warnings: string[]; // the facts, when the day starts with travel; empty otherwise
}

/** One day of a route. */
export interface RouteDay extends DayTravel {
  day: number; // 0-based
  anchorId: string; // the day's city in the route
  name: string;
  changes: boolean; // a different city from the trip's now
  replan: ReplanWhy | null; // planned again, and why; null when the day keeps its stops
  note: string | null; // what happens to the day: "Day 3 will be planned again: ..."
  refusal: RouteRefusal | null; // set on the day a refused route fails
}

/** What a route means for a trip. */
export interface RoutePlan {
  route: string[]; // a base id a day
  changed: boolean; // some day's city differs from the trip's now
  allowed: boolean; // no day is refused
  days: RouteDay[];
  replan: number[]; // the days to plan again, in day order; the page plans them in this order
  travelMin: number; // all the travel between the route's cities
  message: string; // "Day 2 now in Florence." or "Route changed: Rome, Florence, Venice."
  refusal: (RouteRefusal & { day: number }) | null; // the refusal, when not allowed
  rulesDays: DaySelection[] | null; // the trip with the days planned again by the rules; null when refused
}

/** The travel into day `index` of a route, or null on day 1 and in the same city. */
function legInto(route: readonly string[], index: number, ctx: PlannerContext): RouteLeg | null {
  const from = ctx.anchorById.get(route[index - 1] ?? "");
  const to = ctx.anchorById.get(route[index] ?? "");
  if (!from || !to || from.id === to.id) return null;
  const leg = travelLeg(from.centroid, to.centroid);
  return {
    fromAnchorId: from.id,
    fromName: from.name,
    toAnchorId: to.id,
    toName: to.name,
    minutes: leg.minutes,
    label: leg.label,
  };
}

/**
 * Day `dayIndex`'s travel in a trip whose days are in `arrangement` (a base id a day): the legs in
 * and out, when its places can start, the time before dinner, and the facts for the traveler:
 * "2 h 10 min by high-speed train from Rome, so the day starts at 11:40." and "Leaves about 7 h
 * before dinner.". The page shows the same lines for a route before it is planned and on the day
 * once it is.
 */
// Decision: the time left is counted to the opening of the dinner window (19:00), rounded down to
// the half hour. That is the part of the day the travel takes from sightseeing; the evening is the
// same after any transfer.
export function dayTravel(
  request: TripRequest,
  arrangement: readonly string[],
  dayIndex: number,
  ctx: PlannerContext,
): DayTravel {
  const travelIn = legInto(arrangement, dayIndex, ctx);
  const travelOut = legInto(arrangement, dayIndex + 1, ctx);
  const startMin = PACE[request.pace].dayStart + (travelIn?.minutes ?? 0);
  const freeMin = Math.max(0, MEALS.dinner.earliestStart - startMin);
  const warnings =
    travelIn === null
      ? []
      : [
          `${travelIn.label} from ${travelIn.fromName}, so the day starts at ${clockText(startMin)}.`,
          `Leaves about ${formatDuration(Math.floor(freeMin / 30) * 30)} before dinner.`,
        ];
  return { travelIn, travelOut, startMin, freeMin, warnings };
}

/** The route's cities, as "Rome, Florence, Venice". */
function routeNames(route: readonly string[], ctx: PlannerContext): string {
  return route.map((id) => ctx.anchorById.get(id)?.name ?? id).join(", ");
}

/**
 * What setting day by day cities `route` means for the trip `days`: every day's city, travel and
 * start, which days are planned again and why, the facts to show, and a refusal with its way out
 * when the route cannot be planned. Deterministic, and fast enough to run on every tap (a few
 * milliseconds). Throws RangeError when the route is not a known base for every day.
 *
 * A day is planned again when its city changes, when its travel in changes and its stops no
 * longer fit (the validator finds a new error on it), or when it has to take a must-include
 * from a day that can no longer hold it. Every other day keeps its stops. The days are checked
 * by planning them with the rules, in day order, each one knowing the days planned before it
 * (planDay): the same days the page plans on the device when the API cannot answer. The route is
 * refused when a day there is empty (nothing fits it after its travel), when a must-include the
 * trip has would be lost (no day of the route in its city can take it), or when the trip would
 * gain an error from the validator.
 */
// Decision: the other days keep their stops unless the validator says they no longer fit. Moving
// day 1 to Florence changes day 2's start by 2 h 10 min, and a day planned for 09:30 rarely fits
// 11:40; a day that still fits is the traveler's and stays. A must-include moves only to a day of
// its own city, the first that can take it, so it is never lost to a route the traveler set.
export function planRoute(
  request: TripRequest,
  days: readonly DaySelection[],
  route: readonly string[],
  ctx: PlannerContext,
): RoutePlan {
  if (route.length !== days.length) {
    throw new RangeError(`A route needs a city for each of the ${days.length} days`);
  }
  for (const id of route) {
    if (!ctx.anchorById.has(id)) throw new RangeError(`"${id}" is not a base`);
  }
  const current = days.map((day) => day.anchorId);
  const changes = route.map((id, index) => id !== current[index]);
  const why = new Map<number, ReplanWhy>();
  const holding = new Map<number, string>(); // the must-include a day is planned again to hold
  changes.forEach((changed, index) => {
    if (changed) why.set(index, "city");
  });
  let refusal: (RouteRefusal & { day: number }) | null = null;
  let rulesDays: DaySelection[] | null = days.map((day) => ({ ...day }));
  if (why.size > 0) {
    const had = new Set(tripErrors(request, days, ctx).map(errorKey));
    const placed = placedMustIncludes(request, days);
    // Each pass either plans at least one more day or ends, so it runs at most days + 1 times.
    for (;;) {
      const planned = simulate(request, days, route, why, ctx);
      if (typeof planned === "number") {
        refusal = { day: planned, ...nothingFits(planned, route, changes, current, ctx) };
        break;
      }
      rulesDays = planned;
      const fresh = tripErrors(request, planned, ctx).filter(
        (error) => (error.day !== undefined && why.has(error.day)) || !had.has(errorKey(error)),
      );
      // Kept days the validator now faults: their travel in changed and their stops no longer
      // fit, or a must-include it says fits there. All are planned again on the next pass.
      let more = false;
      for (const error of fresh) {
        if (error.day === undefined || why.has(error.day)) continue;
        const must = error.code === "MUST_INCLUDE_MISSING" && error.placeId !== undefined;
        why.set(error.day, must ? "must_include" : "travel");
        if (must) holding.set(error.day, error.placeId as string);
        more = true;
      }
      if (more) continue;
      // A must-include no day holds any more goes to the first day of its city not planned yet,
      // one day a pass, since a day planned on the last pass may already have taken it.
      const lost = placed.find(({ id }) => !planned.some((day) => day.placeIds.includes(id)));
      if (lost !== undefined) {
        const base = ctx.anchorIdByPlaceId.get(lost.id);
        const next = route.findIndex((anchorId, index) => anchorId === base && !why.has(index));
        if (next !== -1) {
          why.set(next, "must_include");
          holding.set(next, lost.id);
          continue;
        }
        const { id, holder } = lost;
        refusal = { day: holder, ...lostMustInclude(id, holder, route, changes, current, ctx) };
      } else if (fresh[0] !== undefined) {
        const error = fresh[0];
        const day = error.day ?? changes.indexOf(true);
        const fix = `Choose another city for ${dayText(culprit(changes, day))}.`;
        refusal = { day, code: "new_error", reason: error.detail, fix };
      }
      break;
    }
    if (refusal !== null) rulesDays = null;
  }
  const plannedDays = route.map((anchorId, index): RouteDay => {
    const travel = dayTravel(request, route, index, ctx);
    const wasIn = legInto(current, index, ctx)?.minutes ?? 0;
    const reason = why.get(index) ?? null;
    const name = ctx.anchorById.get(anchorId)?.name ?? anchorId;
    const note = dayNote(index, name, reason, travel, wasIn, holding.get(index), ctx);
    return {
      day: index,
      anchorId,
      name,
      changes: changes[index] === true,
      replan: reason,
      ...travel,
      note,
      refusal:
        refusal?.day === index
          ? { code: refusal.code, reason: refusal.reason, fix: refusal.fix }
          : null,
    };
  });
  return {
    route: [...route],
    changed: changes.includes(true),
    allowed: refusal === null,
    days: plannedDays,
    replan: [...why.keys()].sort((a, b) => a - b),
    travelMin: plannedDays.reduce((sum, day) => sum + (day.travelIn?.minutes ?? 0), 0),
    message: routeMessage(route, changes, ctx),
    refusal,
    rulesDays,
  };
}

/**
 * The trip to send with a route's first day request: every day the route plans again empty at
 * its new city, the others as they are. As each day's answer arrives the page puts it in and sends
 * the next day with this trip, so every request carries the route and the days planned before it.
 */
export function routeStartDays(days: readonly DaySelection[], plan: RoutePlan): DaySelection[] {
  return days.map((day, index) =>
    plan.replan.includes(index)
      ? { anchorId: plan.route[index] ?? day.anchorId, placeIds: [] }
      : { anchorId: day.anchorId, placeIds: [...day.placeIds] },
  );
}

/**
 * The trip with the route's days planned again by the rules, in day order, or the index of the
 * first one that comes out empty.
 */
function simulate(
  request: TripRequest,
  days: readonly DaySelection[],
  route: readonly string[],
  why: ReadonlyMap<number, ReplanWhy>,
  ctx: PlannerContext,
): DaySelection[] | number {
  const working = days.map((day, index) =>
    why.has(index) ? { anchorId: route[index] as string, placeIds: [] } : day,
  );
  for (const index of [...why.keys()].sort((a, b) => a - b)) {
    const day = planDay(request, working, index, route[index] as string, ctx);
    if (day.placeIds.length === 0) return index;
    working[index] = day;
  }
  return working;
}

/** The traveler's must-includes the trip has now, each with the day that holds it. */
function placedMustIncludes(request: TripRequest, days: readonly DaySelection[]) {
  return [...new Set(request.mustInclude)].flatMap((id) => {
    const holder = days.findIndex((day) => day.placeIds.includes(id));
    return holder === -1 ? [] : [{ id, holder }];
  });
}

/**
 * The day whose change to undo for a problem on `day`: the day itself when its city changes, else
 * the nearest day before it that changes, else the first day that changes.
 */
function culprit(changes: readonly boolean[], day: number): number {
  for (let index = day; index >= 0; index--) {
    if (changes[index]) return index;
  }
  return changes.indexOf(true);
}

/** The refusal for a day with nothing to plan. */
function nothingFits(
  index: number,
  route: readonly string[],
  changes: readonly boolean[],
  current: readonly string[],
  ctx: PlannerContext,
): RouteRefusal {
  const city = ctx.anchorById.get(route[index] ?? "")?.name ?? "";
  const travel = legInto(route, index, ctx);
  const when =
    travel === null ? "with your settings" : `after ${formatDuration(travel.minutes)} of travel`;
  const culpritDay = culprit(changes, index);
  const was = ctx.anchorById.get(current[culpritDay] ?? "")?.name ?? "";
  return {
    code: "nothing_fits",
    reason: `Nothing in ${city} fits ${dayText(index)} ${when}.`,
    fix: `Keep ${dayText(culpritDay)} in ${was}, or choose another city for it.`,
  };
}

/** The refusal for a must-include no day of the route can take. */
function lostMustInclude(
  id: string,
  holder: number,
  route: readonly string[],
  changes: readonly boolean[],
  current: readonly string[],
  ctx: PlannerContext,
): RouteRefusal {
  const name = ctx.placesById.get(id)?.name ?? id;
  const base = ctx.anchorIdByPlaceId.get(id) ?? "";
  const city = ctx.anchorById.get(base)?.name ?? base;
  const moves = route[holder] !== base;
  const others = route.filter(
    (anchorId, index) => anchorId === base && (index !== holder || !moves),
  );
  const where =
    others.length === 0
      ? `no other day of this route is in ${city}`
      : `no day of this route in ${city} can take it`;
  const culpritDay = culprit(changes, holder);
  const was = ctx.anchorById.get(current[culpritDay] ?? "")?.name ?? "";
  return {
    code: "holds_must_include",
    reason: `${dayTitle(holder)} has ${name}, which you asked for, and ${where}.`,
    fix: `Keep ${dayText(culpritDay)} in ${was}, or remove ${name} from ${dayText(holder)} first.`,
  };
}

/** What happens to a day of the route, in one sentence, or null when nothing does. */
function dayNote(
  index: number,
  city: string,
  why: ReplanWhy | null,
  travel: DayTravel,
  wasInMin: number,
  holds: string | undefined,
  ctx: PlannerContext,
): string | null {
  const title = dayTitle(index);
  const inMin = travel.travelIn?.minutes ?? 0;
  if (why === "city") return `${title} will be planned in ${city}.`;
  if (why === "travel") {
    const start =
      inMin > 0
        ? `after ${formatDuration(inMin)} of travel`
        : `at ${clockText(travel.startMin)}, with no travel`;
    return `${title} will be planned again: it now starts ${start}.`;
  }
  if (why === "must_include") {
    const name = ctx.placesById.get(holds ?? "")?.name ?? "a place";
    return `${title} will be planned again to hold ${name}, which you asked for.`;
  }
  if (inMin === wasInMin) return null;
  return `${title} keeps its places and now starts at ${clockText(travel.startMin)}.`;
}

/** "Day 2 now in Florence." for one day that changes city, else "Route changed: ...". */
function routeMessage(
  route: readonly string[],
  changes: readonly boolean[],
  ctx: PlannerContext,
): string {
  const moved = changes.flatMap((changed, index) => (changed ? [index] : []));
  const [only] = moved;
  if (only === undefined) return "";
  if (moved.length > 1) return `Route changed: ${routeNames(route, ctx)}.`;
  return `${dayTitle(only)} now in ${ctx.anchorById.get(route[only] ?? "")?.name ?? ""}.`;
}
