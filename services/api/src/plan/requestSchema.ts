import { type KnownValues, tripRequestSchemaFor } from "@italy/planner";

// The request schema POST /api/plan validates with: the planner's TripRequest schema (strict,
// known tags, ids, and bases).

// Decision: no API-only rules on top of the shared schema. An extra start-date window here once
// refused dates the web form accepted (the form validates with the same planner schema), so the
// traveler saw an error for a date the form allowed. One schema, one answer (failure vector F10).

/** The full request schema for this dataset. */
export function planRequestSchema(known: KnownValues) {
  return tripRequestSchemaFor(known);
}
