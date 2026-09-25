import { type Itinerary, planRequestKey, type TripRequest } from "@italy/planner";

// The AI plans this tab has had from the API, by the options they answer, so going back to
// options already planned here shows that plan at once with no request. Keyed by the planner's
// planRequestKey, the key the API's own plan cache uses, so "the same options" means the same
// thing on both sides. It lives in the page's memory (usePlanTrip holds one), so it ends with the
// tab or a reload; the last plan kept on the device covers a reload.

/** Plans kept per tab. */
export const PLAN_MEMO_ENTRIES = 20;

// Decision: only AI plans (source ai or ai_repaired), as on the server. A rules-only plan from
// the API is a fallback (the model timed out, was busy or is off) that asking again may improve,
// and a plan built on this device is not the API's plan at all.
function isAiPlan(itinerary: Itinerary): boolean {
  return itinerary.source === "ai" || itinerary.source === "ai_repaired";
}

export class PlanMemo {
  readonly #entries = new Map<string, Itinerary>();
  readonly #max: number;

  constructor(maxEntries = PLAN_MEMO_ENTRIES) {
    this.#max = maxEntries;
  }

  /** A copy of the plan kept for these options, carrying `request` as sent now, or undefined. */
  // Decision: the plan takes the request as sent now, as the API does on a hit ({ ...cached,
  // request }). The key treats the two as the same trip, so the plan meets every rule for it,
  // and the page shows the options in the order the traveler just chose them. A rule why line
  // that names two interests keeps the order of the request it was made for ("food and art"
  // after asking "art, food"): re-deriving it needs each stop's day as the planner timed it
  // (ruleReason), and the words say the same either way.
  get(request: TripRequest): Itinerary | undefined {
    const key = planRequestKey(request);
    const itinerary = this.#entries.get(key);
    if (itinerary === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, itinerary);
    return structuredClone({ ...itinerary, request });
  }

  /**
   * Keeps a copy of an AI plan exactly as the API returned it, for the options it was asked
   * for. Anything else is ignored. The oldest plan goes once PLAN_MEMO_ENTRIES are kept.
   */
  // Decision: a copy in, a copy out. Edits build new itineraries in the reducer, and the copies
  // make sure none of them can ever change the plan kept here.
  set(request: TripRequest, itinerary: Itinerary): void {
    if (!isAiPlan(itinerary)) return;
    const key = planRequestKey(request);
    this.#entries.delete(key);
    this.#entries.set(key, structuredClone(itinerary));
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
