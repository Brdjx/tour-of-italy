import { compareText, transferMinutes } from "./anchors";
import { PACE } from "./config";
import { isCandidate, isExcluded, sharesLocation } from "./constraints";
import { type PlannerContext, placesOfAnchor } from "./context";
import { type BuiltDay, buildDay } from "./dayBuilder";
import { fitsEmptyDay } from "./dayLimits";
import { automaticTiers, chosenTierGroups, wantedMustIncludes } from "./planAnchors";
import type { Place, TripRequest } from "./types";

// Builds whole trips for candidate arrangements of bases and keeps the best one. Days are built
// in order with a shared "used" set, so no place appears twice and must-include places are
// placed on the first day that can hold them.

/** A trip the greedy walk produced: one base and a list of ids per day. */
export interface TripDraft {
  anchorIds: string[]; // one base id per day
  days: string[][]; // place ids per day, in visiting order
  score: number; // summed selection scores; higher is better
}

/** Day results by a key that chains every input of the day (see buildTrip). */
type DayMemo = Map<string, BuiltDay | null>;

/** One tier of arrangements, tried with a cap on ordinary visits per day. */
interface Attempt {
  tier: string[][];
  visitCap: number;
}

/**
 * The best trip over the tiers of arrangements (planAnchors.ts), or null when no arrangement of
 * any base can fill every day.
 */
export function chooseTrip(
  request: TripRequest,
  ctx: PlannerContext,
  dates: string[],
): TripDraft | null {
  const memo: DayMemo = new Map();
  const pools = new PoolCache(request, ctx);
  for (const { tier, visitCap } of attempts(request, ctx, dates)) {
    let best: TripDraft | null = null;
    for (const arrangement of tier) {
      const draft = buildTrip(arrangement, request, ctx, dates, memo, pools, visitCap);
      // Strictly greater: on a tie the earlier arrangement (fewer bases) wins.
      if (draft && (best === null || draft.score > best.score)) best = draft;
    }
    if (best) return best;
  }
  return null;
}

/**
 * The tiers in the order to try them. Each group of chosen-base tiers (planAnchors.ts) is tried
 * at the pace's cap, then with one ordinary visit fewer a day, down to one, before the next
 * group gives up a chosen day; the automatic tiers come last, at the pace's cap.
 */
// Decision: a traveler's base choice outranks the number of stops. The greedy walk fills early
// days first, so a thin base (winter closures, a low budget, exclusions) could run dry on day 3
// and the plan used to move that day to a base nobody chose, with no warning. Capping ordinary
// visits spreads the base over every day; the cap drops one visit at a time, so days stay as
// full as the base allows (property tests, disagreement 2 in the T17 report).
function attempts(request: TripRequest, ctx: PlannerContext, dates: string[]): Attempt[] {
  const paceCap = PACE[request.pace].maxVisits;
  const result: Attempt[] = [];
  for (const group of chosenTierGroups(request, ctx, dates)) {
    for (let visitCap = paceCap; visitCap >= 1; visitCap--) {
      for (const tier of group) result.push({ tier, visitCap });
    }
  }
  for (const tier of automaticTiers(request, ctx, dates)) result.push({ tier, visitCap: paceCap });
  return result;
}

/** One trip for one arrangement, or null when some day cannot hold a single stop. */
export function buildTrip(
  arrangement: readonly string[],
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  memo: DayMemo = new Map(),
  pools: PoolCache = new PoolCache(request, ctx),
  visitCap: number = PACE[request.pace].maxVisits,
): TripDraft | null {
  const used = new Set<string>();
  const pending = new Set(wantedMustIncludes(request, ctx));
  const days: string[][] = [];
  let score = 0;
  // The cap changes every day's result, so it starts the memo key.
  let key = `cap${visitCap}`;
  for (let index = 0; index < arrangement.length; index++) {
    const laterDays = laterChances(arrangement, index, request, ctx, dates, pending);
    // A day depends on every day before it (their keys), its own base, and how many later
    // chances each must-include has; the key chains all three so equal keys mean equal inputs.
    const chances = [...laterDays].map(([id, count]) => `${id}:${count}`).join(",");
    key = `${key}/${arrangement[index]}#${chances}`;
    let built = memo.get(key);
    if (built === undefined) {
      const day = { arrangement, index, used, pending, laterDays, visitCap };
      built = buildTripDay(day, request, ctx, dates, pools);
      memo.set(key, built);
    }
    if (built === null) return null;
    days.push(built.ids);
    score += built.score;
    for (const id of built.ids) {
      used.add(id);
      pending.delete(id);
    }
  }
  return { anchorIds: [...arrangement], days, score: Math.round(score * 1e6) / 1e6 };
}

/** The transfer into day `index` of an arrangement: 0 on day 1 and when the base stays. */
function transferInto(arrangement: readonly string[], index: number, ctx: PlannerContext): number {
  const anchor = ctx.anchorById.get(arrangement[index] ?? "");
  const previous = index === 0 ? undefined : ctx.anchorById.get(arrangement[index - 1] ?? "");
  return anchor && previous ? transferMinutes(previous, anchor) : 0;
}

/** For each pending must-include of day `index`'s base: later days that could hold it alone. */
function laterChances(
  arrangement: readonly string[],
  index: number,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  pending: ReadonlySet<string>,
): Map<string, number> {
  const anchorId = arrangement[index] ?? "";
  const chances = new Map<string, number>();
  for (const id of [...pending].sort(compareText)) {
    const place = ctx.placesById.get(id);
    if (!place || ctx.anchorIdByPlaceId.get(id) !== anchorId) continue;
    let count = 0;
    for (let later = index + 1; later < arrangement.length; later++) {
      const anchor = ctx.anchorById.get(arrangement[later] ?? "");
      const date = dates[later];
      if (anchor?.id !== anchorId || date === undefined) continue;
      const transferMin = transferInto(arrangement, later, ctx);
      if (fitsEmptyDay(place, date, request.pace, transferMin, anchor.centroid)) count++;
    }
    chances.set(id, count);
  }
  return chances;
}

/** Where a day sits in its trip, and what the days before it left. */
interface DayContext {
  arrangement: readonly string[];
  index: number;
  used: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  laterDays: ReadonlyMap<string, number>;
  visitCap: number; // cap on ordinary visits for every day of this trip
}

/** One day of a trip: strict candidates first, one open-access place when that leaves it empty. */
function buildTripDay(
  day: DayContext,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  pools: PoolCache,
): BuiltDay | null {
  const anchor = ctx.anchorById.get(day.arrangement[day.index] ?? "");
  const date = dates[day.index];
  if (!anchor || date === undefined) return null;
  const transferMin = transferInto(day.arrangement, day.index, ctx);
  const obligations = new Set(day.laterDays.keys());
  const { used, laterDays, visitCap } = day;
  const base = { date, anchor, transferMin, request, ctx, used, obligations, laterDays, visitCap };
  const strict = pools.strict(anchor.id);
  const normal = buildDay({ ...base, pool: strict });
  if (normal.ids.length > 0) return normal;
  // Decision: a day that would be empty may use ONE open-access public space of the base (open
  // 07:00 to 23:00), ignoring budget and rating but never exclusions; the best such day wins.
  // One, so a starved day cannot take every public space and leave the next day empty. If even
  // that is empty, this arrangement is dropped and the planner tries other bases.
  let rescued: BuiltDay | null = null;
  for (const extra of pools.openAccessExtras(anchor.id)) {
    const pool = [...strict, extra].sort((a, b) => compareText(a.id, b.id));
    const day = buildDay({ ...base, pool });
    if (day.ids.length > 0 && (rescued === null || day.score > rescued.score)) rescued = day;
  }
  return rescued;
}

/** Candidate pools per base, computed once per plan, in id order. */
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
   * In the base, not excluded, suggestable, and within budget (or a must-include), and not
   * sharing a spot with a must-include (the must-include wins its spot).
   */
  strict(anchorId: string): Place[] {
    let pool = this.strictPools.get(anchorId);
    if (!pool) {
      pool = placesOfAnchor(this.ctx, anchorId).filter(
        (place) => isCandidate(place, this.request, anchorId, this.ctx) && !this.twinOfMust(place),
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
