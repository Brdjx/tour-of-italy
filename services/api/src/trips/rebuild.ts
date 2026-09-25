import {
  attachReasons,
  type DayPlan,
  type Itinerary,
  ItinerarySchema,
  type PlannerContext,
  planWarnings,
  scheduleTrip,
  summaryForPlaces,
  type TripRequest,
  tripPlaceIds,
  type Violation,
  validateItinerary,
} from "@italy/planner";
import type { PlannedBy } from "../contract";
import { checkAiReason } from "../plan/reasons";
import { sanitizeSummary } from "../plan/summary";
import { type AiSource, type DayIds, withoutNotes } from "./records";

// A trip being saved, rebuilt by the server from its ids alone: timed by the planner, given rule
// why lines, and then given back the AI's why lines and summary where the AI content on record
// (a plan record or an earlier saved trip) has them. Nothing the client sends ends up as text on
// the trip except ids it chose from the data. The result is what GET /api/trips/:id serves.

/** What the client sends to save a trip, after the route checked it. */
export interface TripInput {
  request: TripRequest;
  days: DayIds[];
}

export type RebuildResult =
  | { ok: true; itinerary: Itinerary; origin: { plannedBy: PlannedBy; edited: boolean } }
  | { ok: false; errors: Violation[] };

/**
 * True when `request` asks for the trip the AI content was written for: the same dates, pace,
 * interests, budget, bases and places to skip, and the same must-includes or fewer. Notes are
 * never stored, so they are not compared.
 */
// Decision: fewer must-includes still match, because removing a must-include stop on the page
// takes it off the request (rescheduleDay). Any other change is another trip, and the AI's why
// lines were not written for it: "your first morning" means nothing on other dates.
export function samePlanRequest(source: TripRequest, request: TripRequest): boolean {
  const sameSet = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value) => b.includes(value));
  const bases = (value: TripRequest) => (value.anchors === "auto" ? ["auto"] : value.anchors);
  return (
    source.startDate === request.startDate &&
    source.pace === request.pace &&
    source.maxPriceLevel === request.maxPriceLevel &&
    sameSet(source.interests, request.interests) &&
    sameSet(bases(source), bases(request)) &&
    sameSet(source.exclude, request.exclude) &&
    request.mustInclude.every((id) => source.mustInclude.includes(id))
  );
}

/** True when any day's base, places, or their order differ. */
export function idsDiffer(a: readonly DayIds[], b: readonly DayIds[]): boolean {
  const text = (days: readonly DayIds[]) => JSON.stringify(days.map((d) => [d.anchorId, d.ids]));
  return text(a) !== text(b);
}

/**
 * The day's stops with the AI's why lines back where the same place keeps the same role and the
 * line still holds as the stop is now timed. Each stored line passes the API's text checks again
 * (checkAiReason), then attachReasons runs the planner's claim check (reasonClaims.ts), exactly
 * as it does when the traveler edits a day on the page.
 */
function withAiReasons(
  day: DayPlan,
  index: number,
  source: AiSource,
  request: TripRequest,
  ctx: PlannerContext,
  tripDays: { date: string; anchorId: string }[],
): DayPlan["stops"] {
  const stored = new Map<string, string>();
  for (const entry of source.reasons) {
    if (entry.day === index) stored.set(`${entry.placeId}|${entry.role}`, entry.reason);
  }
  const previous = day.stops.map((stop) => {
    const raw = stored.get(`${stop.placeId}|${stop.role}`);
    const check = raw === undefined ? null : checkAiReason(raw, stop.placeId, ctx);
    return check?.ok ? { ...stop, reason: check.text, reasonSource: "ai" as const } : stop;
  });
  return attachReasons(day.stops, request, ctx, previous, { days: tripDays, index });
}

/**
 * Times the trip from its ids, puts back the AI content `source` allows, and checks the result
 * with the validator and the response schema. Refused (ok false) when anything is an error.
 * `generatedAt` is used when there is no AI content (the moment of saving).
 */
export function rebuildTrip(
  input: TripInput,
  source: AiSource | null,
  ctx: PlannerContext,
  generatedAt: string,
): RebuildResult {
  const request = withoutNotes(input.request);
  const ai = source !== null && samePlanRequest(source.request, request) ? source : null;
  const picks = input.days.map((day) => ({ anchorId: day.anchorId, placeIds: day.ids }));
  const scheduled = scheduleTrip(request, picks, ctx);
  const tripDays = scheduled.days.map((day) => ({ date: day.date, anchorId: day.anchorId }));
  const days = scheduled.days.map((day, index) =>
    ai ? { ...day, stops: withAiReasons(day, index, ai, request, ctx, tripDays) } : day,
  );
  // The summary for this trip's places: a sentence naming a place the trip no longer has is
  // dropped by summaryForPlaces, the planner's function the page runs on the same summary after
  // an edit, so the sender and whoever opens the link see the same summary. The API's own checks
  // (sanitizeSummary) then run again, in case one was tightened since the plan was made.
  // Decision: no summary at all when a day's base differs from the AI plan's. The page never
  // changes a base without planning again, so only a crafted request does, and "two days in
  // Florence" names no place the check could catch.
  const planIds = tripPlaceIds({ days });
  const sameBases = ai?.days.every((day, index) => day.anchorId === input.days[index]?.anchorId);
  const forPlaces = sameBases ? summaryForPlaces(ai?.summary, planIds, ctx) : undefined;
  const summary = forPlaces === undefined ? undefined : sanitizeSummary(forPlaces, planIds, ctx);
  const itinerary: Itinerary = {
    request,
    days,
    source: ai ? ai.source : "deterministic",
    warnings: [],
    ...(summary === undefined ? {} : { summary }),
    meta: {
      ...(ai?.model === undefined ? {} : { model: ai.model }),
      ...(ai?.promptVersion === undefined ? {} : { promptVersion: ai.promptVersion }),
      attempts: 0,
      latencyMs: 0,
      generatedAt: ai ? ai.generatedAt : generatedAt,
    },
  };
  const errors = [...scheduled.violations, ...validateItinerary(itinerary, ctx)].filter(
    (violation) => violation.severity === "error",
  );
  // The warnings the page shows for the same trip after an edit (rescheduleDay).
  itinerary.warnings = planWarnings(itinerary, ctx);
  if (errors.length > 0 || !ItinerarySchema.safeParse(itinerary).success) {
    return { ok: false, errors };
  }
  const origin = ai
    ? { plannedBy: ai.source, edited: ai.edited || idsDiffer(ai.days, input.days) }
    : { plannedBy: "rules" as const, edited: false };
  return { ok: true, itinerary, origin };
}
