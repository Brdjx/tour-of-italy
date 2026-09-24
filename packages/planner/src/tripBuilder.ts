import { isOuting } from "./constraints";
import type { PlannerContext } from "./context";
import { closedForHoliday, daylightEnd } from "./dayRules";
import { repairMustIncludes } from "./mustRepair";
import {
  type Arrangement,
  automaticTiers,
  chosenTierGroups,
  type Tier,
  wantedMustIncludes,
} from "./planAnchors";
import { MISTIMED_MUST_COST, OUTING_LATEST_START, TRANSFER_COST } from "./planPolicy";
import { PoolCache } from "./pools";
import { scheduleDay } from "./schedule";
import { buildTrip, transferInto } from "./tripWalk";
import type { TripRequest } from "./types";

// Chooses the trip: builds a whole trip (tripWalk.ts) for each candidate arrangement of bases,
// tier by tier (planAnchors.ts), and keeps the best one after the cost of its transfer.

/** A trip the greedy walk produced: one base and a list of ids per day. */
export interface TripDraft {
  anchorIds: string[]; // one base id per day
  days: string[][]; // place ids per day, in visiting order
  score: number; // summed selection scores; higher is better
}

/** One tier of arrangements, and whether a day left empty may take one public space. */
interface Attempt {
  tier: Tier;
  rescue: boolean;
}

/**
 * The best trip over the tiers of arrangements (planAnchors.ts), or null when no arrangement of
 * any base can fill every day. Each trip gets the must-include repair pass (mustRepair.ts); trips
 * are compared by how many must-includes they hold, then by score minus the cost of the transfer
 * and of each must-include timed against a day rule (mistimedMustIncludes).
 */
// Decision: must-includes first, counted after the repair. A second base costs about 15 points
// and its must-include is worth 100, but when the walk alone could not place one (Testaccio's
// lunch on a Rome day), the trip staying in Rome looked better, and the validator rightly asked
// why Navigli in Milan was left out.
export function chooseTrip(
  request: TripRequest,
  ctx: PlannerContext,
  dates: string[],
): TripDraft | null {
  const pools = new PoolCache(request, ctx);
  const wanted = wantedMustIncludes(request, ctx);
  for (const { tier, rescue } of attempts(request, ctx, dates)) {
    let best: { draft: TripDraft; kept: number; value: number } | null = null;
    for (const arrangement of tier) {
      const built = buildTrip(arrangement, request, ctx, dates, rescue, pools);
      if (!built) continue;
      const draft = repairMustIncludes(built, request, ctx, dates);
      const kept = wanted.filter((id) => draft.days.some((ids) => ids.includes(id))).length;
      const value =
        draft.score -
        transferCost(arrangement, ctx) -
        MISTIMED_MUST_COST * mistimedMustIncludes(draft, request, ctx, dates);
      // Strictly greater: on a tie the earlier arrangement (fewer bases) wins.
      const order = best === null ? 1 : kept - best.kept || value - best.value;
      if (order > 0) best = { draft, kept, value };
    }
    if (best) return best.draft;
  }
  return null;
}

/**
 * The attempts in order: each group of chosen-base tiers, then the automatic tiers, each first
 * as walked and then with an empty day allowed one public space (tripWalk.ts, rescueEmptyDay).
 */
// Decision: a traveler's base choice outranks the budget: a thin base (winter closures, a low
// budget, exclusions) may fill a day that is still empty with one over-budget public space
// before the planner gives up a base the traveler chose.
function attempts(request: TripRequest, ctx: PlannerContext, dates: string[]): Attempt[] {
  const result: Attempt[] = [];
  const groups = [...chosenTierGroups(request, ctx, dates), automaticTiers(request, ctx, dates)];
  for (const group of groups) {
    for (const rescue of [false, true]) {
      for (const tier of group) result.push({ tier, rescue });
    }
  }
  return result;
}

/**
 * What an arrangement's changes of base cost in score points (TRANSFER_COST): a fixed cost per
 * move plus a cost per hour on the train.
 */
export function transferCost(arrangement: Arrangement, ctx: PlannerContext): number {
  let cost = 0;
  for (let index = 1; index < arrangement.length; index++) {
    if (arrangement[index] === arrangement[index - 1]) continue;
    const minutes = transferInto(arrangement, index, ctx);
    cost += TRANSFER_COST.perMove + (TRANSFER_COST.perHour * minutes) / 60;
  }
  return cost;
}

/**
 * How many times the draft's must-includes break a time rule of the day: an outing starting
 * after OUTING_LATEST_START, a park or outdoor trip ending after sunset, a museum on a holiday
 * most close for (each counts once, so a day trip at 14:10 in December counts twice). The walk
 * may place a must-include there when nothing better fits; this makes a trip that times it
 * better win.
 */
// Decision: a cost, not a filter, so a must-include that only fits in the afternoon is still
// kept. Two arrangements that keep the same must-includes differ here: Venice, Venice, Bologna
// put the Parma tour ("weekday mornings only") at 14:10 on a December day; Bologna first put it
// at 11:45 with dinner after.
export function mistimedMustIncludes(
  draft: TripDraft,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
): number {
  if (request.mustInclude.length === 0) return 0;
  let count = 0;
  draft.days.forEach((ids, index) => {
    const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
    const date = dates[index];
    if (!anchor || date === undefined || !ids.some((id) => request.mustInclude.includes(id))) {
      return;
    }
    const transferMin = transferInto(draft.anchorIds, index, ctx);
    const { stops } = scheduleDay(ids, date, anchor, request, ctx, transferMin);
    for (const stop of stops) {
      const place = ctx.placesById.get(stop.placeId);
      if (!place || !request.mustInclude.includes(place.id)) continue;
      if (stop.role === "visit" && isOuting(place) && stop.start > OUTING_LATEST_START) count++;
      if (stop.end > daylightEnd(place, date)) count++;
      if (closedForHoliday(place, date)) count++;
    }
  });
  return count;
}
