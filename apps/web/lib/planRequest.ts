import {
  type Itinerary,
  type PlannerContext,
  planDeterministic,
  type TripRequest,
  validationErrors,
} from "@italy/planner";
import { type PlanCallOptions, postPlan } from "./api";
import { isApiError, isRequestProblem } from "./apiError";

// Asking for a plan, with the in-browser fallback. The planner package runs in the browser, so
// when the API cannot answer (offline, timeout, 5xx, rate limit, an unreadable reply) and the
// places are loaded, the plan is built here with the same rules and labelled with the real
// cause. A request the API rejected as invalid is not retried locally: the traveler needs to
// fix the form, not get a plan for input the server refused.

/** Why a plan was built in the browser. The source badge words each one differently. */
export type FallbackCause =
  | "offline" // the request never reached the server (no connection, DNS, connection reset)
  | "timeout" // no answer before the client's deadline
  | "busy" // 429: the planner is rate limiting
  | "server" // any other failing HTTP status
  | "unreadable" // the reply was not JSON or not an itinerary
  | "invalid"; // the reply was an itinerary that breaks a rule on this device's check

export type PlanOutcome =
  | { kind: "api"; itinerary: Itinerary }
  | { kind: "offline"; itinerary: Itinerary; cause: FallbackCause; error: unknown };

export interface PlanDeps {
  ctx: PlannerContext | null; // loaded places, or null when they never arrived
  post?: (request: TripRequest, options: PlanCallOptions) => Promise<Itinerary>;
  now?: () => number;
}

/** True when a failed API call should fall back to planning in the browser. */
export function shouldPlanLocally(error: unknown): boolean {
  if (!isApiError(error)) return true;
  if (error.kind === "aborted") return false;
  return !isRequestProblem(error);
}

/** The cause behind a failed plan call, for the badge. */
export function fallbackCause(error: unknown): FallbackCause {
  if (!isApiError(error)) return "server";
  if (error.kind === "network") return "offline";
  if (error.kind === "timeout") return "timeout";
  if (error.kind === "parse" || error.kind === "schema") return "unreadable";
  return error.status === 429 ? "busy" : "server";
}

/**
 * A plan from the API, or from the browser when the API fails in a way local planning can
 * cover. Rethrows the API error when it cannot (bad request, aborted, no places loaded) and
 * the planner's error when even the local plan is impossible.
 */
export async function requestPlan(
  request: TripRequest,
  deps: PlanDeps,
  options: PlanCallOptions = {},
): Promise<PlanOutcome> {
  const post = deps.post ?? postPlan;
  let itinerary: Itinerary;
  try {
    itinerary = await post(request, options);
  } catch (error) {
    if (!deps.ctx || !shouldPlanLocally(error)) throw error;
    return local(request, deps, fallbackCause(error), error);
  }
  // Decision: the page checks the API's plan with the same validator before showing it (F1).
  // The server validates too, so this only fires on a server bug or a version mismatch between
  // the cached page and the API; either way the traveler gets a plan that passes, labelled as
  // built on this device, instead of a "checked" badge over flagged stops.
  if (deps.ctx && breaksRules(itinerary, deps.ctx)) {
    return local(request, deps, "invalid", null);
  }
  return { kind: "api", itinerary };
}

function breaksRules(itinerary: Itinerary, ctx: PlannerContext): boolean {
  try {
    return validationErrors(itinerary, ctx).length > 0;
  } catch {
    return true; // the validator could not read it, so it cannot be shown as checked
  }
}

function local(
  request: TripRequest,
  deps: PlanDeps,
  cause: FallbackCause,
  error: unknown,
): PlanOutcome {
  const ctx = deps.ctx as PlannerContext;
  return { kind: "offline", itinerary: planLocally(request, ctx, deps.now), cause, error };
}

/** The rules-only plan built in the browser, marked with the "offline" fallback reason. */
export function planLocally(
  request: TripRequest,
  ctx: PlannerContext,
  now: () => number = Date.now,
): Itinerary {
  // Decision: the itinerary's own fallbackReason stays "offline" for every browser-built plan
  // (the planner's enum has one value for it); the page keeps the real cause next to it.
  return planDeterministic(request, ctx, { fallbackReason: "offline", now });
}
