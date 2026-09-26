import {
  type DaySelection,
  type FallbackReason,
  type Itinerary,
  type PlanSource,
  TRIP_DAYS,
  type Violation,
} from "@italy/planner";
import { type PlanCallOptions, type PlanDayBody, postPlanDay } from "./api";
import { isApiError } from "./apiError";
import type { PlanDayResponse } from "./apiSchemas";
import { type FallbackCause, fallbackCause } from "./planRequest";

// A day planned again, the parts every run shares (lib/dayRoute.ts): the trip as ids, the call to
// POST /api/plan/day, how each day was made and what the page says about it. Model proposes,
// code decides: whatever arrives is checked against the trip it was asked for, timed again in
// the browser and checked by the validator.

/**
 * How the call went: the API's day, or why the page plans it here instead. `failedOn` is set on a
 * day of a run that was not sent because an earlier day's call failed: the day whose call did.
 */
export type DayReply =
  | { kind: "answer"; response: PlanDayResponse }
  | { kind: "failed"; cause: FallbackCause; failedOn?: number };

/**
 * How a day planned again was made, shown under the day's heading (dayClaim). `edited` once the
 * traveler has swapped, removed or moved a stop on that day since.
 */
export type DayMade =
  | { kind: "api"; source: PlanSource; fallbackReason?: FallbackReason; edited?: true }
  | { kind: "device"; cause: FallbackCause | null; failedOn?: number; edited?: true };

/** The trip as the API and the planner read it: each day's base and place ids in order. */
export function tripSelection(itinerary: Pick<Itinerary, "days">): DaySelection[] {
  return itinerary.days.map((day) => ({
    anchorId: day.anchorId,
    placeIds: day.stops.map((stop) => stop.placeId),
  }));
}

/** One string for the trip's bases and places, to tell whether it changed while a run planned. */
export function tripKey(itinerary: Pick<Itinerary, "days">): string {
  return JSON.stringify(tripSelection(itinerary).map((day) => [day.anchorId, day.placeIds]));
}

export interface DayCallDeps {
  post?: (body: PlanDayBody, options: PlanCallOptions) => Promise<PlanDayResponse>;
}

/**
 * Asks the API for the day. Resolves to its answer or, when the call fails in any way but being
 * cancelled, to why it failed; the page then plans the day here (resolveJob). Rethrows a
 * cancellation.
 */
// Decision: every failure falls back, a 400 or 422 included. For a whole trip a refused request is
// the traveler's to fix in the form; here the page built the body from the trip on screen, so a
// refusal can only be a version mismatch, and the planner in this page answers for its own data.
export async function requestDay(
  body: PlanDayBody,
  deps: DayCallDeps = {},
  options: PlanCallOptions = {},
): Promise<DayReply> {
  const post = deps.post ?? postPlanDay;
  try {
    return { kind: "answer", response: await post(body, options) };
  } catch (error) {
    if (isApiError(error) && error.kind === "aborted") throw error;
    return { kind: "failed", cause: fallbackCause(error) };
  }
}

/**
 * "Planned again with AI" and the rest: how a day planned again was made, in the source line's
 * words, with ", edited" once the traveler has changed a stop on it since.
 */
// Decision: ", edited" as the trip's source line says it (lib/sourceText.ts). Without it the day
// kept saying "Planned again with AI" over a stop the traveler had swapped in themselves.
export function dayClaim(made: DayMade): { claim: string; ai: boolean } {
  const { claim, ai } = madeClaim(made);
  return { claim: made.edited ? `${claim}, edited` : claim, ai };
}

function madeClaim(made: DayMade): { claim: string; ai: boolean } {
  if (made.kind === "device") {
    const { cause, failedOn } = made;
    if (!cause) return { claim: "Planned again on this device", ai: false };
    return { claim: `${DEVICE_DAY_CLAIM[cause]}${failedOnText(cause, failedOn)}`, ai: false };
  }
  if (made.source === "ai") return { claim: "Planned again with AI", ai: true };
  if (made.source === "ai_repaired") {
    return { claim: "Planned again with AI, fixed after a check", ai: true };
  }
  const reason = made.fallbackReason;
  return { claim: reason ? RULES_DAY_CLAIM[reason] : "Planned again without AI", ai: false };
}

// Decision: the source line's own words (lib/sourceText.ts) with "again", so a traveler who has
// read what the trip's line means reads the day's line the same way.
const RULES_DAY_CLAIM: Record<FallbackReason, string> = {
  requested: "Planned again without AI",
  no_key: "Planned again without AI: the AI planner is off",
  disabled: "Planned again without AI: the AI planner is off",
  timeout: "Planned again without AI: the AI planner timed out",
  rate_limited: "Planned again without AI: the AI planner was busy",
  refusal: "Planned again without AI: the AI planner declined",
  invalid_after_repair: "Planned again without AI: the AI's plan broke a rule",
  schema_invalid: "Planned again without AI: the AI planner failed",
  max_tokens: "Planned again without AI: the AI planner failed",
  llm_error: "Planned again without AI: the AI planner failed",
  offline: "Planned again without AI: the server was unreachable",
};

const DEVICE_DAY_CLAIM: Record<FallbackCause, string> = {
  offline: "Planned again on this device, offline",
  timeout: "Planned again on this device: the server timed out",
  busy: "Planned again on this device: the server was busy",
  server: "Planned again on this device: the server failed",
  unreadable: "Planned again on this device: the reply was unreadable",
  invalid: "Planned again on this device: the server's day broke a rule",
};

/**
 * " on day 2" after the cause of a day that was not sent, since the call that failed was that
 * day's; nothing for a day whose own call failed, or offline, which holds for every day.
 */
// Decision: found in review (2026-09-26). After one failed call the rest of a run is planned here
// without asking again (useDayRoute), and those days said "the server timed out" as if their own
// call had.
function failedOnText(cause: FallbackCause, failedOn: number | undefined): string {
  return failedOn === undefined || cause === "offline" ? "" : ` on day ${failedOn + 1}`;
}

/** A fresh record of how each day was made: none planned again yet. */
export function noDaysMade(): (DayMade | null)[] {
  return Array.from({ length: TRIP_DAYS }, () => null);
}

/**
 * The plan's warnings as the page shows them: without "not one of your bases" on a day the
 * traveler planned again from the route sheet, since they picked that day's city themselves.
 */
// Decision: hidden on the page, not solved by adding the city to the request's bases. The note
// explains why a planner left the bases in the form, and its next step (Edit the trip to change
// your bases) would undo the traveler's own choice. Adding the city to the request would also
// stop a saved trip matching the plan record (samePlanRequest compares bases), so every day would
// lose its AI why lines, and the next Plan my trip would treat the city as chosen for every day.
// A saved link does not record which day was moved, so it shows the note again when reopened.
export function shownWarnings(
  warnings: readonly Violation[],
  made: readonly (DayMade | null)[],
): Violation[] {
  return warnings.filter(
    (warning) =>
      warning.code !== "ANCHOR_NOT_CHOSEN" || warning.day === undefined || !made[warning.day],
  );
}

/**
 * The days (1-based) whose AI why lines a saved trip leaves out: days planned again by the AI
 * that still show one. A saved trip takes the AI's words only from the AI plan on record, and a
 * day planned again has none (services/api/src/trips/rebuild.ts), so it shows the rules' there.
 */
export function replannedAiDays(
  itinerary: Pick<Itinerary, "days">,
  made: readonly (DayMade | null)[],
): number[] {
  return itinerary.days.flatMap((day, index) => {
    const how = made[index];
    const ai = how?.kind === "api" && how.source !== "deterministic";
    return ai && day.stops.some((stop) => stop.reasonSource === "ai") ? [index + 1] : [];
  });
}
