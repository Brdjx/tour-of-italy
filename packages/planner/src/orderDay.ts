import type { PlannerContext } from "./context";
import { buildDay } from "./dayBuilder";
import type { Anchor, Place, TripRequest } from "./types";

// Puts a fixed set of places for one day in the order the rules-only planner walks a day
// (dayBuilder.ts and dayPicks.ts): a must-include that can start now, the meal that is due, the
// best visit that can start now and keeps the next meal reachable, otherwise whatever can start
// soonest. So meals land in their windows and each visit lands while its place is open. The AI
// path uses it to order the places the model chose (services/api/src/plan/tidy.ts): code, not
// the model, assigns the times, so only code can see when each place is open.

/** The day being ordered: its date, its base, and the transfer that starts it. */
export interface DaySlot {
  date: string;
  anchor: Anchor;
  transferMin: number; // travel from the previous base, 0 on day 1 or when the base is the same
}

/** The places the walk fitted, in visiting order, and the ones it could not fit. */
export interface DayOrder {
  ordered: string[];
  unfitted: string[]; // in their given order; ids that are not places land here too
}

/**
 * Which places the walk takes first whenever one can start now: only the traveler's
 * must-includes, as in the planner (its other picks order the rest), or every place.
 */
export type FirstChoice = "must_includes" | "every_place";

/**
 * Orders `placeIds` for one day with the rules-only planner's day walk. Each id is used once.
 * Pure and deterministic: ties break by place id.
 */
// Decision: the places are the model's choice, so the walk's own preferences (outings by noon,
// parks by sunset, museums shut on holidays, meal places only as meals) do not limit when they
// can go: every place counts as asked for in the latest starts. Only the hard rules, the visit
// cap, the day rules, and the meal rule (a meal place is not a visit while a meal it serves can
// still happen) leave a place out.
// Decision: the day is the only one these places have. So a meal place that serves one meal
// takes it before one that serves both (mealChances), and a morning sight gets its last chance
// (visitChances). Tidying with the must_includes walk alone, 90 of 400 random answers passed
// with mealChances against 86 without, and 180 of 195 planner-made answers with each day
// reversed passed with visitChances against 176 without.
export function orderDay(
  placeIds: readonly string[],
  slot: DaySlot,
  request: TripRequest,
  ctx: PlannerContext,
  firstChoice: FirstChoice = "must_includes",
): DayOrder {
  const ids = [...new Set(placeIds)];
  const pool: Place[] = [];
  for (const id of ids) {
    const place = ctx.placesById.get(id);
    if (place) pool.push(place);
  }
  const asked: TripRequest = {
    ...request,
    mustInclude: [...new Set([...request.mustInclude, ...ids])],
  };
  const first =
    firstChoice === "every_place" ? ids : ids.filter((id) => request.mustInclude.includes(id));
  const built = buildDay({
    ...slot,
    request: asked,
    ctx,
    pool,
    used: new Set(),
    obligations: new Set(first),
    mealChances: (place) => place.meals.length,
    visitChances: () => 0,
  });
  const fitted = new Set(built.ids);
  return { ordered: built.ids, unfitted: ids.filter((id) => !fitted.has(id)) };
}
