import { isCandidate, isExcluded, isMealPlace, sharesLocation, withinBudget } from "./constraints";
import { type PlannerContext, placesOfAnchor, twinIds } from "./context";
import type { DayInput } from "./dayBuilder";
import { wantedMustIncludes } from "./planAnchors";
import type { Place, TripRequest } from "./types";

// The places each base offers a trip, computed once per plan and shared by every arrangement
// the planner tries, in id order so results never depend on the order of the data; and whether a
// place is already taken by the trip (isBlocked).

/** Candidate pools per base for one request. */
export class PoolCache {
  private readonly strictPools = new Map<string, Place[]>();
  private readonly extras = new Map<string, Place[]>();

  private readonly wanted: string[];

  constructor(
    private readonly request: TripRequest,
    private readonly ctx: PlannerContext,
  ) {
    this.wanted = wantedMustIncludes(request, ctx);
  }

  /**
   * In the base, not excluded, suggestable, and within budget (or a must-include, or a meal
   * place one price level over: see isMealFallback), and not sharing a spot with a must-include
   * (the must-include wins its spot).
   */
  strict(anchorId: string): Place[] {
    let pool = this.strictPools.get(anchorId);
    if (!pool) {
      pool = placesOfAnchor(this.ctx, anchorId).filter(
        (place) =>
          (isCandidate(place, this.request, anchorId, this.ctx) ||
            isMealFallback(place, this.request, anchorId, this.ctx)) &&
          !this.twinOfMust(place),
      );
      this.strictPools.set(anchorId, pool);
    }
    return pool;
  }

  /** Open-access places of the base outside the strict pool that are not excluded, id order. */
  openAccessExtras(anchorId: string): Place[] {
    let extras = this.extras.get(anchorId);
    if (!extras) {
      const strict = new Set(this.strict(anchorId));
      extras = placesOfAnchor(this.ctx, anchorId).filter(
        (place) =>
          !strict.has(place) &&
          place.hoursConfidence === "open_access" &&
          !isExcluded(place, this.request) &&
          !this.twinOfMust(place),
      );
      this.extras.set(anchorId, extras);
    }
    return extras;
  }

  /** True for a place that is not a must-include but shares a spot with one. */
  private twinOfMust(place: Place): boolean {
    if (this.wanted.includes(place.id)) return false;
    return this.wanted.some((id) => {
      const must = this.ctx.placesById.get(id);
      return must !== undefined && sharesLocation(must, place);
    });
  }
}

/**
 * True for a meal place exactly one price level over the budget that would otherwise be a
 * candidate. The walk seats one only when no meal place within budget can still take that meal
 * (dayBuilder.ts), the AI shortlist offers it after every meal place within budget
 * (services/api/src/plan/candidates.ts), and the plan shows an OVER_BUDGET warning for it.
 */
// Decision: a budget traveler still eats. At the lowest budget Milan has no meal place and Rome
// one lunch counter, so 70% of budget days had no meal at all and 90% no dinner. One level over,
// marked, is the same allowance the AI shortlist makes, and only ever for a meal.
export function isMealFallback(
  place: Place,
  request: Pick<TripRequest, "exclude" | "mustInclude" | "maxPriceLevel">,
  anchorId: string,
  ctx: PlannerContext,
): boolean {
  const budget = request.maxPriceLevel;
  if (budget === null || budget >= 4 || !isMealPlace(place)) return false;
  if (withinBudget(place, budget)) return false;
  const oneOver = { ...request, maxPriceLevel: (budget + 1) as 2 | 3 | 4 };
  return isCandidate(place, oneOver, anchorId, ctx);
}

/**
 * True when the place is already in the trip (on another day, or `today`), or shares a location
 * with a place that is. Links are symmetric even when only one side lists the other.
 */
// Decision: never two places at one spot in a trip, even when the traveler asked for both
// (Trevi Fountain by day and by night): the first one placed wins and the validator explains the
// other ("at the same spot as ..."). The pools drop ordinary twins of a must-include up front so
// the must-include keeps its spot.
export function isBlocked(place: Place, input: DayInput, today: readonly Place[]): boolean {
  if (input.used.has(place.id)) return true;
  const twins = twinIds(input.ctx, place.id);
  for (const other of today) {
    if (other.id === place.id || twins.includes(other.id)) return true;
  }
  return twins.some((id) => input.used.has(id));
}
