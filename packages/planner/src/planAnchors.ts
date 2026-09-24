import { compareText, dayOrigin } from "./anchors";
import { MAX_ANCHORS_PER_TRIP, PACE } from "./config";
import { isCandidate } from "./constraints";
import { type PlannerContext, placesOfAnchor } from "./context";
import { ANCHOR_SHORTLIST } from "./planPolicy";
import { scorePlace } from "./score";
import { hoursOn } from "./time";
import type { Anchor, TripRequest } from "./types";

// Which bases a trip can use, as ordered lists of one base id per day ("arrangements"). The
// planner builds a full trip for each arrangement in a tier and keeps the best; it only moves to
// the next tier when no arrangement in the current one can fill every day.

/** One base id per trip day, in day order: ["rome", "rome", "florence"]. */
export type Arrangement = string[];
/** Arrangements the planner compares with each other; the best full trip among them wins. */
export type Tier = Arrangement[];
/** Tiers that keep the same number of days at the traveler's chosen bases, tried in order. */
export type TierGroup = Tier[];

/** Must-include ids the planner will try to place: known places, not also excluded. */
export function wantedMustIncludes(request: TripRequest, ctx: PlannerContext): string[] {
  const wanted: string[] = [];
  for (const id of request.mustInclude) {
    if (ctx.placesById.has(id) && !request.exclude.includes(id) && !wanted.includes(id)) {
      wanted.push(id);
    }
  }
  return wanted;
}

/** The traveler's chosen bases that exist, in their order, at most MAX_ANCHORS_PER_TRIP. */
export function chosenAnchorIds(request: TripRequest, ctx: PlannerContext): string[] {
  if (request.anchors === "auto") return [];
  const chosen: string[] = [];
  for (const id of request.anchors) {
    if (ctx.anchorById.has(id) && !chosen.includes(id)) chosen.push(id);
  }
  // Decision: unknown base ids are ignored and extra ones cut. The API rejects both before
  // planning; this keeps the fallback planner total instead of throwing on a bad request.
  return chosen.slice(0, MAX_ANCHORS_PER_TRIP);
}

/**
 * Bases best first: most must-include places, then the summed scores of the top candidates a
 * day could hold (visits plus two meals), then id. A candidate closed on every trip date does
 * not count; each candidate counts with its best score over the trip dates.
 */
export function rankAnchors(request: TripRequest, ctx: PlannerContext, dates: string[]): string[] {
  const wanted = wantedMustIncludes(request, ctx);
  const topCount = PACE[request.pace].maxVisits + 2;
  const ranked = ctx.anchors.map((anchor) => ({
    id: anchor.id,
    must: wanted.filter((id) => ctx.anchorIdByPlaceId.get(id) === anchor.id).length,
    strength: anchorStrength(anchor, request, ctx, dates, topCount),
  }));
  ranked.sort((a, b) => b.must - a.must || b.strength - a.strength || compareText(a.id, b.id));
  return ranked.map((entry) => entry.id);
}

function anchorStrength(
  anchor: Anchor,
  request: TripRequest,
  ctx: PlannerContext,
  dates: string[],
  topCount: number,
): number {
  const scores: number[] = [];
  for (const place of placesOfAnchor(ctx, anchor.id)) {
    if (!isCandidate(place, request, anchor.id, ctx)) continue;
    let bestScore: number | null = null;
    for (const date of dates) {
      const hours = hoursOn(place, date);
      if (hours !== "unknown" && hours.length === 0) continue; // closed that day
      const score = scorePlace(place, request, { date, from: dayOrigin(anchor, request) });
      if (bestScore === null || score > bestScore) bestScore = score;
    }
    if (bestScore !== null) scores.push(bestScore);
  }
  scores.sort((a, b) => b - a);
  let sum = 0;
  for (const score of scores.slice(0, topCount)) sum += score;
  return Math.round(sum * 1e6) / 1e6;
}

/**
 * Every arrangement of the given bases over `days` days: each base alone first, then each pair
 * with all days at one base before the other, in both orders and every split (A A B, A B B,
 * B B A, B A A for three days). One transfer at most, so no trip goes back and forth.
 */
// Decision: single-base trips come first, so on an exact score tie the planner prefers fewer
// transfers.
export function arrangementsOf(anchorIds: readonly string[], days: number): Tier {
  const result: Tier = anchorIds.map((id) => Array<string>(days).fill(id));
  if (MAX_ANCHORS_PER_TRIP < 2) return result;
  for (let i = 0; i < anchorIds.length; i++) {
    for (let j = i + 1; j < anchorIds.length; j++) {
      const a = anchorIds[i] as string;
      const b = anchorIds[j] as string;
      result.push(...splits(a, b, days), ...splits(b, a, days));
    }
  }
  return result;
}

/** first^k second^(days-k) for k = days-1 down to 1: most days at the first base first. */
function splits(first: string, second: string, days: number): Tier {
  const result: Tier = [];
  for (let k = days - 1; k >= 1; k--) {
    result.push([...Array<string>(k).fill(first), ...Array<string>(days - k).fill(second)]);
  }
  return result;
}

/**
 * Tiers of arrangements grouped by how many days they keep at the traveler's chosen bases, most
 * first: every day (the chosen order, then any other order), then one day fewer, and so on.
 * Empty when the traveler chose no bases. chooseTrip tries each group with fewer visits a day
 * before it gives up a chosen day.
 */
export function chosenTierGroups(
  request: TripRequest,
  ctx: PlannerContext,
  dates: string[],
): TierGroup[] {
  const chosen = chosenAnchorIds(request, ctx);
  if (chosen.length === 0) return [];
  const days = dates.length;
  const [first, second] = chosen as [string, string | undefined];
  // Decision: with fewer days than chosen bases (a 1-day trip, two bases), every chosen base
  // alone is in the first tier, so the one holding the must-includes wins on score instead of
  // the first-listed base winning by position.
  const inOrder =
    second === undefined
      ? [Array<string>(days).fill(first)]
      : days < 2
        ? chosen.map((id) => Array<string>(days).fill(id))
        : splits(first, second, days);
  const anyOrder = without(arrangementsOf(chosen, days), inOrder);
  const groups: TierGroup[] = [anyOrder.length > 0 ? [inOrder, anyOrder] : [inOrder]];
  const everything = arrangementsOf(rankAnchors(request, ctx, dates), days);
  for (let kept = days - 1; kept >= 1; kept--) {
    const tier = everything.filter(
      (arrangement) => arrangement.filter((id) => chosen.includes(id)).length === kept,
    );
    if (tier.length > 0) groups.push([tier]);
  }
  return groups;
}

/**
 * Automatic tiers: the ANCHOR_SHORTLIST best-ranked bases plus every base holding a must-include,
 * then the arrangements left over.
 */
// Decision: every base with a must-include is on the shortlist, however many there are. With
// must-includes in four bases, a fourth base left off the list made the planner stay in one base
// while the validator saw room for that base's place (a false MUST_INCLUDE_MISSING).
export function automaticTiers(request: TripRequest, ctx: PlannerContext, dates: string[]): Tier[] {
  const ranked = rankAnchors(request, ctx, dates);
  const holding = new Set(
    wantedMustIncludes(request, ctx).map((id) => ctx.anchorIdByPlaceId.get(id)),
  );
  const listed = ranked.filter((id, rank) => rank < ANCHOR_SHORTLIST || holding.has(id));
  const shortlist = arrangementsOf(listed, dates.length);
  const rest = without(arrangementsOf(ranked, dates.length), shortlist);
  return rest.length > 0 ? [shortlist, rest] : [shortlist];
}

/** The arrangements of `tier` that are not in `seen`, in order. */
function without(tier: Tier, seen: Tier): Tier {
  const keys = new Set(seen.map((arrangement) => arrangement.join(" ")));
  return tier.filter((arrangement) => !keys.has(arrangement.join(" ")));
}
