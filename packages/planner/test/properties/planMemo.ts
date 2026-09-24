import { planDeterministic } from "../../src/plan";
import type { Itinerary, TripRequest } from "../../src/types";
import { ctx } from "./arbitraries";

// One plan per distinct request per test file. fast-check draws the same request on run i of
// every property with the same seed (the request is always generated first), so the properties
// of one file share their plans instead of planning each request again. Callers must not
// mutate a returned plan; every property that edits one copies it first.

const plans = new Map<string, Itinerary>();

/** The plan for a request, computed once per distinct request in this file. */
export function planFor(request: TripRequest): Itinerary {
  const key = JSON.stringify(request);
  let itinerary = plans.get(key);
  if (!itinerary) {
    itinerary = Object.freeze(planDeterministic(request, ctx));
    plans.set(key, itinerary);
  }
  return itinerary;
}
