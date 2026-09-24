import { DETAIL_MAX_CHARS, ID_MAX_CHARS } from "./config";
import type { Severity, Violation, ViolationCode } from "./types";

// The one severity table and the one violation constructor. The scheduler (scheduleChecks.ts)
// and the validator (validate/) both build their violations here.
// Decision: severity is policy, not a check, so sharing it keeps the two sides independent where
// it matters (each still decides for itself whether a rule is broken). With one table, a new code
// that is missing a severity fails to compile instead of silently becoming an error on one side.

/**
 * Errors block a plan (it never reaches the traveler); warnings travel with it. The Record type
 * makes the table exhaustive: a code added to enums.ts without a severity fails to compile.
 */
export const VIOLATION_SEVERITY: Readonly<Record<ViolationCode, Severity>> = Object.freeze({
  WRONG_DAY_COUNT: "error",
  WRONG_DATE: "error",
  UNKNOWN_ANCHOR: "error",
  TOO_MANY_ANCHORS: "error",
  UNKNOWN_PLACE: "error",
  DUPLICATE_PLACE: "error",
  EXCLUDED_PLACE: "error",
  EMPTY_DAY: "error",
  INVALID_TIME: "error",
  CLOSED_AT_TIME: "error",
  SEASONAL_CLOSED: "error",
  OVERLAP: "error",
  WRONG_TRAVEL: "error",
  OUTSIDE_DAY_WINDOW: "error",
  OUTSIDE_ANCHOR: "error",
  TOO_MANY_VISITS: "error",
  MEAL_OUTSIDE_WINDOW: "error",
  NOT_A_MEAL_PLACE: "error",
  MUST_INCLUDE_MISSING: "error",
  MUST_INCLUDE_UNPLACEABLE: "warning",
  HOURS_UNKNOWN: "warning",
  OVER_BUDGET: "warning",
  MEAL_MISSING: "warning",
  LONG_TRANSFER: "warning",
  SAME_LOCATION: "warning",
  LOW_RATING: "warning",
  ANCHOR_NOT_CHOSEN: "warning",
});

/** Where a violation points: a day, a stop within it, and the place involved. All optional. */
export interface ViolationTarget {
  day?: number | undefined; // 0-based day index
  stopIndex?: number | undefined; // 0-based stop index within the day
  placeId?: string | undefined; // the place involved, when there is one
}

/**
 * A violation with its severity from the table, keys in a fixed order for stable JSON. The
 * detail and the place id are cut to the limits of the API schema.
 */
// Decision: cut rather than echo. An unknown id comes from the model, a shared link, or a
// tampered plan, and must not make the violation itself fail the response schema or become a
// large payload.
export function makeViolation(
  code: ViolationCode,
  detail: string,
  target: ViolationTarget = {},
): Violation {
  return {
    code,
    severity: VIOLATION_SEVERITY[code],
    ...(target.day === undefined ? {} : { day: target.day }),
    ...(target.stopIndex === undefined ? {} : { stopIndex: target.stopIndex }),
    ...(target.placeId === undefined ? {} : { placeId: target.placeId.slice(0, ID_MAX_CHARS) }),
    detail: cut(detail),
  };
}

/** True for a violation that blocks the plan: it must never reach the traveler. */
export function isError(item: Pick<Violation, "severity">): boolean {
  return item.severity === "error";
}

/** True for a violation that travels with the plan and is shown to the traveler. */
export function isWarning(item: Pick<Violation, "severity">): boolean {
  return item.severity === "warning";
}

function cut(text: string): string {
  if (text.length <= DETAIL_MAX_CHARS) return text;
  return `${text.slice(0, DETAIL_MAX_CHARS - 3).trimEnd()}...`;
}
