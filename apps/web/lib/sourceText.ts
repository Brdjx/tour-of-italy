import type { FallbackReason, Itinerary } from "@italy/planner";
import { shortDayOfTimestamp } from "./format";
import type { PlanOrigin } from "./itineraryReducer";
import type { FallbackCause } from "./planRequest";
import type { SavedTrip } from "./savedTrip";

// The source line: one line under the trip's dates that says how the plan on screen was made
// and, for a plan made without the AI, why, in a few words. It must never claim more than the
// page knows: who planned it, whether it was built on this device and why, whether the traveler
// has edited it, and whether it currently breaks a rule. What the words mean in general (what
// every plan is checked against, what "fixed after a check" did, the reason dots) is in About
// this data's "How a plan is made"; what a traveler must know about one opened link (stops a
// shared plan left out, a saved trip timed again) is in the note over the plan.

export type SourceMarker = "ai" | "rules" | "problem";

export interface SourceText {
  claim: string; // how it was made: "Planned without AI: the AI planner timed out, edited"
  problem: string | null; // "2 problems to fix" while the plan breaks a rule
  offline: boolean; // built in the browser because the server was unreachable
  marker: SourceMarker; // gold check for AI, ink check for rules, red dot for problems
}

/** What the page knows about the plan beyond the itinerary itself. */
export interface SourceStatus {
  cause?: FallbackCause | null; // why it was built in the browser, when it was
  errors?: number; // error-level violations right now
  edited?: boolean; // the traveler has changed it since it arrived
  saved?: SavedTrip | null; // the saved trip it was opened from (origin "saved")
  now?: Date; // today, so a saved trip's day names its year only when it is not this year's
}

// Decision: a few words each, so every claim but the rare "the server's plan broke a rule" fits
// one line on a 390 px phone (328 px of text, measured). After an edit, with ", edited" and Undo
// beside it, a longer claim wraps to a second line beside the mark. Reasons that mean the same
// to a traveler share words: an unreadable answer, a cut-off answer and an API error are all
// "failed".

/** How the API's rules plan came about, by its fallback reason. */
export const FALLBACK_CLAIM: Record<FallbackReason, string> = {
  requested: "Planned without AI", // the traveler asked for it: nothing to explain
  no_key: "Planned without AI: the AI planner is off",
  disabled: "Planned without AI: the AI planner is off",
  timeout: "Planned without AI: the AI planner timed out",
  rate_limited: "Planned without AI: the AI planner was busy",
  refusal: "Planned without AI: the AI planner declined",
  invalid_after_repair: "Planned without AI: the AI's plan broke a rule",
  schema_invalid: "Planned without AI: the AI planner failed",
  max_tokens: "Planned without AI: the AI planner failed",
  llm_error: "Planned without AI: the AI planner failed",
  offline: "Planned without AI: the server was unreachable",
};

// Decision: "offline" only when the request never reached the server. A 5xx, a 429, a timeout
// or an unreadable reply says what the server did instead; a plan restored from storage has no
// cause and is still honestly "on this device".

/** How a plan the browser built came about, by why it built it. */
export const ON_DEVICE_CLAIM: Record<FallbackCause, string> = {
  offline: "Planned on this device, offline",
  timeout: "Planned on this device: the server timed out",
  busy: "Planned on this device: the server was busy",
  server: "Planned on this device: the server failed",
  unreadable: "Planned on this device: the reply was unreadable",
  invalid: "Planned on this device: the server's plan broke a rule",
};

interface Base {
  claim: string;
  ai: boolean; // the AI's why lines are on screen, so the check is gold
  edited: boolean; // edited before it was saved (a saved trip)
}

/**
 * A trip opened from a saved link. Who planned it comes from the server's record of the plan,
 * never from the link; without an AI plan on record the line claims neither the AI nor the
 * rules, since a plan made with the traveler's notes keeps no AI text on record either.
 */
function savedBase(saved: SavedTrip | null, now: Date): Base {
  if (!saved) return { claim: "Saved trip", ai: false, edited: false };
  const ai = saved.plannedBy !== "rules";
  const day = shortDayOfTimestamp(saved.createdAt, now);
  const parts = [
    "Saved trip",
    ...(ai ? ["planned with AI"] : []),
    ...(day ? [`saved ${day}`] : []),
  ];
  // A trip timed again here shows the rules' why lines, so its check is ink.
  return { claim: parts.join(", "), ai: ai && !saved.retimed, edited: saved.edited };
}

function baseFor(itinerary: Itinerary, origin: PlanOrigin, status: SourceStatus): Base {
  const base = { ai: false, edited: false };
  if (origin === "saved") return savedBase(status.saved ?? null, status.now ?? new Date());
  if (origin === "shared") return { ...base, claim: "Shared plan, rebuilt from its places" };
  if (origin === "offline") {
    const cause = status.cause ?? null;
    return { ...base, claim: cause ? ON_DEVICE_CLAIM[cause] : "Planned on this device" };
  }
  if (itinerary.source === "ai") return { ...base, claim: "Planned with AI", ai: true };
  // Decision: the page cannot tell whether the server tidied the draft itself or asked the AI
  // again (services/api/src/plan/tidy.ts), so the words claim neither; About this data says
  // both ways a draft is fixed.
  if (itinerary.source === "ai_repaired") {
    return { ...base, claim: "Planned with AI, fixed after a check", ai: true };
  }
  const reason = itinerary.meta.fallbackReason;
  return { ...base, claim: reason ? FALLBACK_CLAIM[reason] : "Planned without AI" };
}

export function sourceText(
  itinerary: Itinerary,
  origin: PlanOrigin,
  status: SourceStatus = {},
): SourceText {
  const base = baseFor(itinerary, origin, status);
  // Edited before it was saved or since it arrived: either way it is not the plan as made.
  const edited = (status.edited ?? false) || base.edited;
  const claim = edited ? `${base.claim}, edited` : base.claim;
  const offline = origin === "offline" && status.cause === "offline";
  const errors = status.errors ?? 0;
  if (errors > 0) {
    // Never a check for a plan that breaks a rule: a red dot, and the count to fix.
    const problem = errors === 1 ? "1 problem to fix" : `${errors} problems to fix`;
    return { claim, problem, offline, marker: "problem" };
  }
  return { claim, problem: null, offline, marker: base.ai ? "ai" : "rules" };
}
