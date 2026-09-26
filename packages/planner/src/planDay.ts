import type { PlannerContext } from "./context";
import { twinIds } from "./context";
import { startWalk, stepWalk } from "./dayBuilder";
import { fillMissingMeals } from "./mealFill";
import { repairMustIncludes } from "./mustRepair";
import { wantedMustIncludes } from "./planAnchors";
import { PoolCache } from "./pools";
import { requireIndex } from "./stopEdits";
import { tripDates } from "./time";
import type { DaySelection } from "./trip";
import { rescueEmptyDay, transferInto } from "./tripWalk";
import type { TripRequest } from "./types";

// Re-planning one day of a trip that already exists, from the rules alone: the traveler moves a
// day to another city (or asks for a new version of it) and every other day stays exactly as it
// is. It is the rules-only answer of POST /api/plan/day, the fallback when the AI's day fails, and
// the check behind the cities a day may move to (dayBases.ts). It is the planner's own day walk
// (dayBuilder.ts) over the base's pool (pools.ts), with the other days' places counted as used,
// then the must-include repair (mustRepair.ts) and the meal fill (mealFill.ts) on this day only.

/** Options for a one-day re-plan. */
export interface ReplanOptions {
  avoid?: readonly string[]; // places to leave out of this day's new version (never a must-include)
}

/** The trip's days with day `dayIndex` replaced by `day`. */
export function withDay(
  days: readonly DaySelection[],
  dayIndex: number,
  day: DaySelection,
): DaySelection[] {
  return days.map((other, index) => (index === dayIndex ? day : other));
}

/** Every place on the trip's days except day `dayIndex`. */
export function usedOnOtherDays(days: readonly DaySelection[], dayIndex: number): Set<string> {
  return new Set(days.flatMap((day, index) => (index === dayIndex ? [] : day.placeIds)));
}

/**
 * The must-includes day `dayIndex` should hold at `anchorId`: the traveler's must-includes of
 * that base that are neither on another day nor at the same spot as a place on another day.
 */
// Decision: a must-include already placed on another day stays there. Re-planning one day never
// changes another, so a place the traveler asked for moves only if they move it; this day takes
// the ones of its base the trip does not have yet, such as a Florence museum once a day moves to
// Florence.
export function dayMustIncludes(
  request: TripRequest,
  days: readonly DaySelection[],
  dayIndex: number,
  anchorId: string,
  ctx: PlannerContext,
): string[] {
  const used = usedOnOtherDays(days, dayIndex);
  return wantedMustIncludes(request, ctx).filter(
    (id) =>
      ctx.anchorIdByPlaceId.get(id) === anchorId &&
      !used.has(id) &&
      !twinIds(ctx, id).some((twin) => used.has(twin)),
  );
}

/**
 * Day `dayIndex` of the trip planned again at base `anchorId` by the rules, the other days as
 * they are. The day uses only places of that base that are allowed on its date, never a place on
 * another day or at the same spot as one, never an excluded or avoided place, and holds the
 * must-includes dayMustIncludes names where they fit, with the pace, the meals, and the transfer
 * from the day before as the whole-trip planner has them. Deterministic. The day can be empty
 * when nothing at the base fits (checkDayBase reports that). Throws RangeError on a day index
 * out of range or an unknown base.
 */
// Decision: the other days' places are "used" for the walk, exactly as the whole-trip walk treats
// the places its other days have taken, so the day cannot repeat them or their spots. Avoided
// places are left out like exclusions, for this day only, and a must-include is never avoided.
export function planDay(
  request: TripRequest,
  days: readonly DaySelection[],
  dayIndex: number,
  anchorId: string,
  ctx: PlannerContext,
  options: ReplanOptions = {},
): DaySelection {
  requireIndex(dayIndex, days.length, "Day");
  const anchor = ctx.anchorById.get(anchorId);
  if (!anchor) throw new RangeError(`"${anchorId}" is not a base`);
  const must = dayMustIncludes(request, days, dayIndex, anchorId, ctx);
  const dayRequest = withAvoided(request, options.avoid ?? []);
  const dates = tripDates(request.startDate, days.length);
  const arrangement = days.map((day, index) => (index === dayIndex ? anchorId : day.anchorId));
  const trip = days.map((day, index) => (index === dayIndex ? [] : [...day.placeIds]));
  const pools = new PoolCache(dayRequest, ctx);
  const walk = startWalk({
    date: dates[dayIndex] as string,
    anchor,
    transferMin: transferInto(arrangement, dayIndex, ctx),
    request: dayRequest,
    ctx,
    pool: pools.strict(anchorId),
    used: usedOnOtherDays(days, dayIndex),
    obligations: new Set(must),
  });
  // Each step adds one unused pool place or stops, so the loop runs at most pool.length times.
  while (stepWalk(walk));
  if (walk.ids.length === 0) rescueEmptyDay(walk, pools);
  trip[dayIndex] = [...walk.ids];
  const draft = { anchorIds: arrangement, days: trip, score: walk.score };
  const repaired = repairMustIncludes(draft, dayRequest, ctx, dates, dayIndex);
  const fed = fillMissingMeals(repaired, dayRequest, ctx, dates, pools, dayIndex);
  return { anchorId, placeIds: fed.days[dayIndex] ?? [] };
}

/** The request with the avoided places excluded too, except the traveler's must-includes. */
function withAvoided(request: TripRequest, avoid: readonly string[]): TripRequest {
  const extra = avoid.filter((id) => !request.mustInclude.includes(id));
  if (extra.length === 0) return request;
  return { ...request, exclude: [...new Set([...request.exclude, ...extra])] };
}
