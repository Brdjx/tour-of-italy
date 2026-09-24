import { isCandidate, isExcluded, isMealPlace, sharesLocation, withinBudget } from "./constraints";
import { type PlannerContext, placesOfAnchor } from "./context";
import { wantedMustIncludes } from "./planAnchors";
import type { Place, TripRequest } from "./types";

// The places each base offers a trip, computed once per plan and shared by every arrangement
// the planner tries, in id order so results never depend on the order of the data.

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
   * (the must-include wins its spot) or, for an ordinary visit, with a meal place that is also a
   * candidate (the meal place wins its spot).
   */
  // Decision: the Mercato Centrale market (a morning visit) and its food hall upstairs (a lunch or
  // dinner) are one spot. Florence has only four lunch places, and a market visit on one day used
  // to block the food hall's lunch for every other day.
  strict(anchorId: string): Place[] {
    let pool = this.strictPools.get(anchorId);
    if (!pool) {
      const candidates = placesOfAnchor(this.ctx, anchorId).filter(
        (place) =>
          (isCandidate(place, this.request, anchorId, this.ctx) ||
            this.isMealFallback(place, anchorId)) &&
          !this.twinOfMust(place),
      );
      pool = candidates.filter((place) => !this.twinOfMeal(place, candidates));
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

  /**
   * True for a meal place exactly one price level over the budget that would otherwise be a
   * candidate. The walk seats one only when no meal place within budget can still take that
   * meal (dayBuilder.ts), and the plan shows an OVER_BUDGET warning for it.
   */
  // Decision: a budget traveler still eats. At the lowest budget Milan has no meal place and Rome
  // one lunch counter, so 70% of budget days had no meal at all and 90% no dinner. One level
  // over, marked, is the same allowance the AI shortlist makes, and only ever for a meal.
  isMealFallback(place: Place, anchorId: string): boolean {
    const budget = this.request.maxPriceLevel;
    if (budget === null || budget >= 4 || !isMealPlace(place)) return false;
    if (withinBudget(place, budget)) return false;
    const oneOver = { ...this.request, maxPriceLevel: (budget + 1) as 2 | 3 | 4 };
    return isCandidate(place, oneOver, anchorId, this.ctx);
  }

  /**
   * True for an ordinary visit place that shares a spot with a meal place among `candidates`,
   * one level over the budget included (isMealFallback).
   */
  // Decision: the fallback counts too. At budget 1 the Mercato Centrale market (a visit) was kept
  // and its food hall (one level over, open 10:00 to 24:00) dropped, so the market visit on day 1
  // blocked the one place that could have fed day 3.
  private twinOfMeal(place: Place, candidates: readonly Place[]): boolean {
    if (isMealPlace(place) || this.wanted.includes(place.id)) return false;
    return candidates.some((other) => isMealPlace(other) && sharesLocation(other, place));
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
