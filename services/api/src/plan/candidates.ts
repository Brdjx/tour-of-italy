import {
  type Anchor,
  compareText,
  formatClock,
  isCandidate,
  isMealFallback,
  openStatusOn,
  PACE,
  type Place,
  type PlannerContext,
  scheduleDay,
  scorePlace,
  sharesLocation,
  TRIP_DAYS,
  type TripRequest,
  tripDates,
} from "@italy/planner";

// The shortlist the model chooses from: a few bases and, for each, the best places that could
// actually be visited on the trip dates. Offering at most about 30 places a base, not every place
// in the data, cuts tokens and latency and removes choices that could only be wrong. Code
// enforces the shortlist afterwards: an id or base the model was not offered is a violation.

export const SHORTLIST = {
  maxAnchorOptions: 4, // bases offered when the traveler lets the planner choose
  minVisitsPerAnchor: 12, // fewest non-meal places a base offers, whatever the pace
  visitMargin: 2, // non-meal places a base offers beyond a whole trip there at the pace
  mealMargin: 1, // meal places a base offers beyond a lunch and a dinner for each trip day
} as const;

/**
 * How many places of each kind a base offers: enough for every trip day spent there at the pace,
 * plus a margin. Counted in places open on every trip date, one per spot (see trim).
 */
// Decision: sized for the whole trip at one base, since any base may hold every day. A fixed 12
// visits and 5 meal places left Rome for three days short (balanced needs 15 visits and 6 meals,
// packed 21 and 6), and on a Sunday only 11 visits and 2 meal places were open. The model then
// filled days 1 and 2 and repeated them on day 3; the tidy step took the repeats out and the day
// was empty (the owner's failed plan of 2026-09-25, and 4 of 12 fallbacks in 132 live plans).
// Offering 21 visits and 8 meals per base cut the repeats on Rome from 18 in 18 plans to 2 in 8.
// The data has at most 22 visits and 7 meal places a base, so a Rome-only trip offers 10 more
// rows at balanced and 12 at packed. With prompt v2 the first call's input grew from 2,684 to
// 4,025 tokens (Rome, balanced) and from 8,337 to 10,311 (the default request, four bases); in
// 45 live plans after the change the first call took 8.5 s at the median (8.7 s before) and
// 10.6 s at most.
export function shortlistSize(pace: TripRequest["pace"]): { visits: number; meals: number } {
  const visits = TRIP_DAYS * PACE[pace].maxVisits + SHORTLIST.visitMargin;
  return {
    visits: Math.max(SHORTLIST.minVisitsPerAnchor, visits),
    meals: TRIP_DAYS * 2 + SHORTLIST.mealMargin,
  };
}

export type DayStatus =
  | { kind: "open"; ranges: string } // "09:00-13:00,15:00-19:00"
  | { kind: "closed" }
  | { kind: "unknown" };

export interface Candidate {
  place: Place;
  score: number; // best score over the trip dates
  meal: boolean; // can be a lunch or dinner stop
  mustInclude: boolean;
  overBudget: boolean; // a meal place one price level over the budget, offered for meals only
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

/** The place's hours on one date, as the candidate rows show them. */
export function dayStatus(place: Place, date: string): DayStatus {
  const status = openStatusOn(place, date);
  if (status.state === "unknown") return { kind: "unknown" };
  if (status.state === "closed") return { kind: "closed" };
  const ranges = status.ranges.map((r) => `${formatClock(r.open)}-${formatClock(r.close)}`);
  return { kind: "open", ranges: ranges.join(",") };
}

/**
 * Every place of a base that could be suggested (or is a meal place one price level over the
 * budget) and is not closed on all trip dates, and, unless the traveler asked for it, that the
 * scheduler can time as a day's only stop on some trip date, after `transferMin` of travel (a
 * re-planned day that follows a change of base; 0 for a whole trip, as each base could hold day 1).
 */
// Decision: a place that fails even alone, at its own base with no transfer, fails on every day
// of every answer, so offering it could only cost a repair. After the shortlist was sized, 4 of 4
// live answers for three balanced days in Bologna put Osteria Francescana on a day: its dinner in
// Modena ends at 22:00, 65 minutes from the base, after a balanced day's last return at 23:00.
// Each needed a repair, and one fell back when the repair ran out of time. Over five start dates
// and the three paces, this leaves out four places, all at relaxed or balanced: that dinner, two
// dawn walks, and a morning cooking class, none of which the rules-only planner can seat either.
// It costs one timing of a one-stop day per place and date: the default request's shortlist takes
// 0.5 ms instead of 0.2.
// Decision: a meal place one price level over the budget is offered as the rules-only planner
// seats it (packages/planner/src/pools.ts, isMealFallback): only a meal place, marked in its row,
// after every meal place within budget (trim), and the plan carries its OVER_BUDGET warning. At
// the lowest budget Milan offered no meal place and Florence one: in 22 live plans at that budget
// on 2026-09-25 (prompt v2), every day lacked a lunch or a dinner, at 0.38 meals a day against
// 1.42 in the rules-only plans. Offered these places, 10 live plans of the same requests (v3) had
// 1.33 meals a day, and every meal place over the budget was a lunch or a dinner.
export function candidatesFor(
  anchor: Anchor,
  request: TripRequest,
  ctx: PlannerContext,
  dates: readonly string[],
  transferMin = 0,
): Candidate[] {
  const out: Candidate[] = [];
  for (const id of anchor.placeIds) {
    const place = ctx.placesById.get(id);
    if (!place) continue;
    const within = isCandidate(place, request, anchor.id, ctx);
    const overBudget = !within && isMealFallback(place, request, anchor.id, ctx);
    if (!within && !overBudget) continue;
    const statuses = dates.map((date) => dayStatus(place, date));
    if (statuses.every((status) => status.kind === "closed")) continue;
    const mustInclude = request.mustInclude.includes(id);
    const alone = (date: string) =>
      scheduleDay([id], date, anchor, request, ctx, transferMin).violations.every(
        (violation) => violation.severity !== "error",
      );
    if (!mustInclude && !dates.some(alone)) continue;
    let score = Number.NEGATIVE_INFINITY;
    for (const date of dates) {
      score = Math.max(score, scorePlace(place, request, { date, from: anchor.centroid }));
    }
    out.push({ place, score, meal: place.mealCapable, mustInclude, overBudget, statuses });
  }
  return out.sort((a, b) => b.score - a.score || compareText(a.place.id, b.place.id));
}

/**
 * The best places of one kind, best first, until `target` of them count: a place counts when it
 * is open (or its hours unknown) on every trip date and shares no spot with one that counted.
 */
// Decision: a place closed on a trip date, or a second place at one spot (the Trevi Fountain by
// day and by night), is still offered but does not count, so a base whose best places close on
// the trip's Sunday offers more of the rest. The model may use either twin but not both, and a
// place closed on day 3 cannot stand in for one on day 3.
function best(candidates: readonly Candidate[], target: number): Candidate[] {
  const out: Candidate[] = [];
  const counted: Place[] = [];
  for (const candidate of candidates) {
    if (counted.length >= target) break;
    out.push(candidate);
    const everyDay = candidate.statuses.every((status) => status.kind !== "closed");
    const twin = counted.some((other) => sharesLocation(other, candidate.place));
    if (everyDay && !twin) counted.push(candidate.place);
  }
  return out;
}

/**
 * The best visits and meals for the pace (shortlistSize), plus every must-include, best first.
 * Meal places over the budget come after every meal place within it.
 */
function trim(all: Candidate[], request: TripRequest): Candidate[] {
  const size = shortlistSize(request.pace);
  const visits = best(
    all.filter((c) => !c.meal),
    size.visits,
  );
  const meals = best(
    [...all.filter((c) => c.meal && !c.overBudget), ...all.filter((c) => c.overBudget)],
    size.meals,
  );
  const kept = new Set([...visits, ...meals, ...all.filter((c) => c.mustInclude)]);
  return all.filter((c) => kept.has(c));
}

/**
 * Sum of the scores a full day could use, the same yardstick for every base. Places within the
 * budget only, so offering meals over it never changes which bases are offered.
 */
function strength(candidates: Candidate[], request: TripRequest): number {
  const within = candidates.filter((c) => !c.overBudget);
  const top = within.slice(0, PACE[request.pace].maxVisits + 2);
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
    .map((option) => ({ anchor: option.anchor, candidates: trim(option.candidates, request) }))
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
