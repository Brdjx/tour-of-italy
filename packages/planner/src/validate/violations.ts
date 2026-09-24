import type { Severity, Violation, ViolationCode } from "../types";

// The severity of every violation code, and one constructor so every violation has the same
// shape: code, severity from this table, optional day, stop and place, and a plain detail.

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

/** Where a violation points: a day, a stop within it, and the place involved. */
export interface ViolationTarget {
  day?: number; // 0-based day index
  stopIndex?: number; // 0-based stop index within the day
  placeId?: string; // the place involved, when there is one
}

/** Longest detail and place id the Violation schema accepts (schemas.ts). */
const DETAIL_MAX_CHARS = 500;
const PLACE_ID_MAX_CHARS = 64;

/** A violation with the severity from the table. Text is cut to fit the API schema. */
export function violation(
  code: ViolationCode,
  detail: string,
  target: ViolationTarget = {},
): Violation {
  const result: Violation = { code, severity: VIOLATION_SEVERITY[code], detail: cut(detail) };
  if (target.day !== undefined) result.day = target.day;
  if (target.stopIndex !== undefined) result.stopIndex = target.stopIndex;
  // Decision: a tampered plan can carry a place id of any length; it is cut rather than echoed
  // in full, so a violation always fits the API schema and never becomes a large payload.
  if (target.placeId !== undefined) result.placeId = target.placeId.slice(0, PLACE_ID_MAX_CHARS);
  return result;
}

/** True when the violation blocks the plan. */
export function isError(item: Pick<Violation, "severity">): boolean {
  return item.severity === "error";
}

function cut(text: string): string {
  if (text.length <= DETAIL_MAX_CHARS) return text;
  return `${text.slice(0, DETAIL_MAX_CHARS - 3).trimEnd()}...`;
}
