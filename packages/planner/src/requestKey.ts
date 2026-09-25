import { canonicalJson } from "./dataVersion";
import type { TripRequest } from "./types";

// One text per set of trip options, so a plan made for them can be found again: the API keys
// its plan cache on it (services/api/src/lib/cache.ts), and the page keys its in-tab plan cache
// on it (apps/web/lib/planMemo.ts). Two requests with the same key ask for the same trip.

// Decision: interests, must-includes and exclusions are sets to the traveler (chips and pickers
// with no order), so they are sorted: a plan made for one order meets every rule for any other.
// Bases keep their order: the first base the traveler picks is the first arrangement the planner
// tries (planAnchors.ts), a preference the plan should follow. Notes are kept exactly as sent,
// since the AI reads them word for word.

const sorted = (values: readonly string[]) => [...values].sort();

/** The request with its set-like lists sorted and nothing else changed. */
export function canonicalPlanRequest(request: TripRequest): TripRequest {
  return {
    startDate: request.startDate,
    pace: request.pace,
    interests: sorted(request.interests),
    maxPriceLevel: request.maxPriceLevel,
    anchors: request.anchors === "auto" ? "auto" : [...request.anchors],
    mustInclude: sorted(request.mustInclude),
    exclude: sorted(request.exclude),
    ...(request.notes === undefined ? {} : { notes: request.notes }),
  };
}

/** The request's key: canonical JSON of canonicalPlanRequest. */
export function planRequestKey(request: TripRequest): string {
  return canonicalJson(canonicalPlanRequest(request));
}
