import type { FallbackReason, Itinerary } from "@italy/planner";
import { dayOfTimestamp } from "./format";
import type { PlanOrigin } from "./itineraryReducer";
import type { FallbackCause } from "./planRequest";
import type { SavedTrip } from "./savedTrip";

// What the source badge says, and the sentences in its details. The label must never claim more
// than the page knows: who planned it, whether it was built on this device and why, whether the
// traveler has edited it, and whether it currently breaks a rule.

export type SourceMarker = "ai" | "rules" | "problem";

export interface SourceText {
  label: string;
  details: string[];
  offline: boolean; // built in the browser because the server was unreachable
  marker: SourceMarker; // gold check for AI, ink check for rules, red dot for problems
}

/** What the page knows about the plan beyond the itinerary itself. */
export interface SourceStatus {
  cause?: FallbackCause | null; // why it was built in the browser, when it was
  errors?: number; // error-level violations right now
  edited?: boolean; // the traveler has changed it since it arrived
  saved?: SavedTrip | null; // the saved trip it was opened from (origin "saved")
}

const CHECKED = "Every stop was checked against opening hours, travel time, and your pace.";
const RULES_BUILT = "so this plan was built by rules. It follows the same checks.";
const ON_DEVICE = "so this plan was built on your device by rules. It follows the same checks.";

/** The fallback reason in plain words. */
export const FALLBACK_TEXT: Record<FallbackReason, string> = {
  no_key: "The AI planner is switched off on this server, so this plan was built by rules.",
  disabled: "The AI planner is switched off on this server, so this plan was built by rules.",
  requested: "You asked for a plan without AI, so this plan was built by rules.",
  timeout: `The AI planner didn't return a valid plan in time, ${RULES_BUILT}`,
  schema_invalid: `The AI planner's answer could not be read, ${RULES_BUILT}`,
  invalid_after_repair: `The AI planner's answer still broke a rule after a second try, ${RULES_BUILT}`,
  refusal: `The AI planner declined this request, ${RULES_BUILT}`,
  max_tokens: `The AI planner's answer was cut off, ${RULES_BUILT}`,
  rate_limited: `The AI planner is busy right now, ${RULES_BUILT}`,
  llm_error: `The AI planner had an error, ${RULES_BUILT}`,
  offline: `The planner service could not be reached, ${ON_DEVICE}`,
};

/** Why the browser built the plan, in plain words. */
export const CAUSE_TEXT: Record<FallbackCause, string> = {
  offline: `The planner service could not be reached, ${ON_DEVICE}`,
  timeout: `The planner service did not answer in time, ${ON_DEVICE}`,
  busy: `The planner service is busy right now, ${ON_DEVICE}`,
  server: `The planner service had an error, ${ON_DEVICE}`,
  unreadable: `The planner service sent a reply this page cannot read, ${ON_DEVICE}`,
  invalid: `The planner service's plan did not pass the checks on this device, ${ON_DEVICE}`,
};

const MARKERS =
  "A filled dot marks a reason written by the AI; an open dot marks a rule-based reason.";

interface Base {
  who: string; // "Planned with AI"
  extra: string | null; // ", offline"
  checked: boolean; // add "checked against hours and distance"
  details: string[];
  offline: boolean;
  ai: boolean;
}

/** Who planned a saved trip, in the words of its details. */
const SAVED_PLANNER: Record<SavedTrip["plannedBy"], string> = {
  ai: "The AI planner chose the places from the data.",
  ai_repaired:
    "The AI planner chose the places from the data; its first draft broke a rule and was fixed.",
  rules: "Its why lines come from the rules.",
};

/**
 * A trip opened from a saved link. Who planned it comes from the server's record of the plan,
 * never from the link; without that record the label claims neither the AI nor the rules.
 */
function savedBase(saved: SavedTrip | null, edited: boolean): Base {
  const base = { extra: null, checked: true, offline: false, ai: false };
  if (!saved) {
    return { ...base, who: "Saved trip", details: ["This plan came from a saved link.", CHECKED] };
  }
  const ai = saved.plannedBy !== "rules";
  const day = dayOfTimestamp(saved.createdAt);
  const when = day === "" ? "Saved" : `Saved on ${day}`;
  // Decision: after the traveler's own edits the times are no longer the saved ones, so the
  // details say only when it was saved; the edit sentence sourceText adds says the rest.
  const first = saved.retimed
    ? `${when}. The place data has changed since, so its times were worked out again and its why lines come from the rules.`
    : edited
      ? `${when}.`
      : `${when}. The times and why lines are as they were saved.`;
  // A trip timed again already says its why lines come from the rules.
  const planner = saved.retimed && !ai ? [] : [SAVED_PLANNER[saved.plannedBy]];
  const details = [
    first,
    ...planner,
    ...(saved.edited ? ["It was edited before it was saved."] : []),
    CHECKED,
    ...(ai && !saved.retimed ? [MARKERS] : []),
  ];
  if (!ai) return { ...base, who: "Saved trip", details };
  return { ...base, who: "Planned with AI", extra: ", saved trip", details, ai: !saved.retimed };
}

function baseFor(
  itinerary: Itinerary,
  origin: PlanOrigin,
  cause: FallbackCause | null,
  saved: SavedTrip | null,
  edited: boolean,
): Base {
  const base = { extra: null, checked: false, offline: false, ai: false };
  if (origin === "saved") return savedBase(saved, edited);
  if (origin === "shared") {
    const details = [
      "This plan came from a shared link.",
      `Its times were worked out again. ${CHECKED}`,
    ];
    return { ...base, who: "Shared plan", checked: true, details };
  }
  const reason = itinerary.meta.fallbackReason;
  if (origin === "offline") {
    // Decision: "offline" only when the request never reached the server. A 5xx, a 429, a
    // timeout or an unreadable reply says "on this device" and names the cause instead.
    // A plan restored from storage has no cause; it is still honestly "on this device".
    const offline = cause === "offline";
    const sentence = cause ? CAUSE_TEXT[cause] : "This plan was built on your device by rules.";
    const extra = offline ? ", offline" : ", on this device";
    return { ...base, who: "Planned without AI", extra, details: [sentence, CHECKED], offline };
  }
  if (itinerary.source === "ai") {
    const details = ["The AI planner chose the places from the data.", CHECKED, MARKERS];
    return { ...base, who: "Planned with AI", checked: true, details, ai: true };
  }
  if (itinerary.source === "ai_repaired") {
    // Decision: the page cannot tell whether the server tidied the draft itself or asked the AI
    // again (services/api/src/plan/tidy.ts), so the sentence names both and claims neither.
    const details = [
      "The AI planner's first draft broke a rule, so it was fixed: the app dropped or reordered stops, or asked the AI to fix it.",
      `The fixed plan passed. ${CHECKED}`,
      MARKERS,
    ];
    return { ...base, who: "Planned with AI", extra: ", fixed after a check", details, ai: true };
  }
  const details = [reason ? FALLBACK_TEXT[reason] : "This plan was built by rules.", CHECKED];
  return { ...base, who: "Planned without AI", details };
}

export function sourceText(
  itinerary: Itinerary,
  origin: PlanOrigin,
  status: SourceStatus = {},
): SourceText {
  const edited = status.edited ?? false;
  const base = baseFor(itinerary, origin, status.cause ?? null, status.saved ?? null, edited);
  const errors = status.errors ?? 0;
  if (errors > 0) {
    const count = errors === 1 ? "1 problem" : `${errors} problems`;
    const broken = errors === 1 ? "a rule" : `${errors} rules`;
    const first = edited
      ? `Your changes break ${broken}. The flagged stops and days say which; swap or remove a stop, or undo.`
      : `This plan breaks ${broken} with the current data. The flagged stops and days say which.`;
    return {
      label: edited ? `Edited by you, ${count} to fix` : `${count} to fix`,
      details: [first, ...base.details.filter((sentence) => !sentence.includes(CHECKED))],
      offline: false, // the label no longer says "offline"
      marker: "problem",
    };
  }
  const parts = [base.who + (base.extra ?? "")];
  if (edited) parts.push("edited by you");
  if (base.checked) parts.push(`${edited ? "still " : ""}checked against hours and distance`);
  const details = edited
    ? [...base.details, "You changed this plan, and every change was checked again."]
    : base.details;
  return {
    label: parts.join(", "),
    details,
    offline: base.offline,
    marker: base.ai && (origin === "api" || origin === "saved") ? "ai" : "rules",
  };
}
