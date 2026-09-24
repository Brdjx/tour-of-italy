import {
  type Anchor,
  compareText,
  formatClock,
  isCandidate,
  openStatusOn,
  PACE,
  type Place,
  type PlannerContext,
  scorePlace,
  type TripRequest,
  tripDates,
} from "@italy/planner";

// The shortlist the model chooses from: a few bases and, for each, the best places that could
// actually be visited on the trip dates. Shrinking about 100 places to about 50 cuts tokens and
// latency and removes choices that could only be wrong. Code enforces the shortlist afterwards:
// an id or base the model was not offered is a violation.

export const SHORTLIST = {
  maxAnchorOptions: 4, // bases offered when the traveler lets the planner choose
  visitsPerAnchor: 12, // best non-meal places per base
  mealsPerAnchor: 5, // best meal places per base
} as const;

export type DayStatus =
  | { kind: "open"; ranges: string } // "09:00-13:00,15:00-19:00"
  | { kind: "closed" }
  | { kind: "unknown" };

export interface Candidate {
  place: Place;
  score: number; // best score over the trip dates
  meal: boolean; // can be a lunch or dinner stop
  mustInclude: boolean;
  statuses: DayStatus[]; // one per trip date
}

export interface AnchorOption {
  anchor: Anchor;
  candidates: Candidate[]; // best first
}

export interface Shortlist {
  dates: string[];
  options: AnchorOption[];
  anchorIds: ReadonlySet<string>; // bases the model may use
  placeIds: ReadonlySet<string>; // places the model may use
  mustInclude: string[]; // must-include ids the model is asked to place
  unplaceable: string[]; // must-include ids that cannot be offered (closed, or base not offered)
}

function dayStatus(place: Place, date: string): DayStatus {
  const status = openStatusOn(place, date);
  if (status.state === "unknown") return { kind: "unknown" };
  if (status.state === "closed") return { kind: "closed" };
  const ranges = status.ranges.map((r) => `${formatClock(r.open)}-${formatClock(r.close)}`);
  return { kind: "open", ranges: ranges.join(",") };
}

/** Every place of a base that could be suggested and is not closed on all trip dates. */
function candidatesFor(anchor: Anchor, request: TripRequest, ctx: PlannerContext, dates: string[]) {
  const out: Candidate[] = [];
  for (const id of anchor.placeIds) {
    const place = ctx.placesById.get(id);
    if (!place || !isCandidate(place, request, anchor.id, ctx)) continue;
    const statuses = dates.map((date) => dayStatus(place, date));
    if (statuses.every((status) => status.kind === "closed")) continue;
    let score = Number.NEGATIVE_INFINITY;
    for (const date of dates) {
      score = Math.max(score, scorePlace(place, request, { date, from: anchor.centroid }));
    }
    const mustInclude = request.mustInclude.includes(id);
    out.push({ place, score, meal: place.mealCapable, mustInclude, statuses });
  }
  return out.sort((a, b) => b.score - a.score || compareText(a.place.id, b.place.id));
}

/** The top visits and meals, plus every must-include, best first. */
function trim(all: Candidate[]): Candidate[] {
  const visits = all.filter((c) => !c.meal).slice(0, SHORTLIST.visitsPerAnchor);
  const meals = all.filter((c) => c.meal).slice(0, SHORTLIST.mealsPerAnchor);
  const kept = new Set([...visits, ...meals, ...all.filter((c) => c.mustInclude)]);
  return all.filter((c) => kept.has(c));
}

/** Sum of the scores a full day could use, the same yardstick for every base. */
function strength(candidates: Candidate[], request: TripRequest): number {
  const top = candidates.slice(0, PACE[request.pace].maxVisits + 2);
  return top.reduce((sum, c) => sum + c.score, 0);
}

/**
 * Bases to offer: the traveler's own, or the strongest few with bases holding must-include places
 * first.
 */
function chooseOptions(request: TripRequest, ctx: PlannerContext, dates: string[]): AnchorOption[] {
  const all = ctx.anchors.map((anchor) => ({
    anchor,
    candidates: candidatesFor(anchor, request, ctx, dates),
  }));
  if (request.anchors !== "auto") {
    const chosen = request.anchors;
    return all
      .filter((o) => chosen.includes(o.anchor.id))
      .sort((a, b) => chosen.indexOf(a.anchor.id) - chosen.indexOf(b.anchor.id));
  }
  const ranked = all.map((option) => ({
    option,
    must: option.candidates.filter((c) => c.mustInclude).length,
    strength: strength(option.candidates, request),
  }));
  ranked.sort(
    (a, b) =>
      b.must - a.must ||
      b.strength - a.strength ||
      compareText(a.option.anchor.id, b.option.anchor.id),
  );
  return ranked.slice(0, SHORTLIST.maxAnchorOptions).map((entry) => entry.option);
}

/** Options for bases the rules-only planner uses that `chosen` does not offer yet. */
function borrowedOptions(
  chosen: readonly AnchorOption[],
  borrow: readonly string[],
  request: TripRequest,
  ctx: PlannerContext,
  dates: string[],
): AnchorOption[] {
  const offered = new Set(chosen.map((option) => option.anchor.id));
  const out: AnchorOption[] = [];
  for (const id of borrow) {
    const anchor = ctx.anchorById.get(id);
    if (!anchor || offered.has(id)) continue;
    offered.add(id);
    out.push({ anchor, candidates: candidatesFor(anchor, request, ctx, dates) });
  }
  return out;
}

/**
 * The shortlist. `borrow` lists the bases the rules-only planner would use for this request;
 * any of them not already chosen is offered too.
 */
// Decision: when the traveler's bases cannot fill the trip (everything there excluded or over
// budget), the rules-only planner borrows another base with an ANCHOR_NOT_CHOSEN warning. The
// model is offered that same base; otherwise no answer could be valid, and both calls would be
// spent before the same rules-only plan.
export function buildShortlist(
  request: TripRequest,
  ctx: PlannerContext,
  borrow: readonly string[] = [],
): Shortlist {
  const dates = tripDates(request.startDate);
  const chosen = chooseOptions(request, ctx, dates);
  const options = [...chosen, ...borrowedOptions(chosen, borrow, request, ctx, dates)]
    .map((option) => ({ anchor: option.anchor, candidates: trim(option.candidates) }))
    .filter((option) => option.candidates.length > 0);
  const placeIds = new Set(options.flatMap((o) => o.candidates.map((c) => c.place.id)));
  const mustInclude = request.mustInclude.filter((id) => placeIds.has(id));
  const unplaceable = request.mustInclude.filter((id) => !placeIds.has(id));
  return {
    dates,
    options,
    anchorIds: new Set(options.map((o) => o.anchor.id)),
    placeIds,
    mustInclude,
    unplaceable,
  };
}
