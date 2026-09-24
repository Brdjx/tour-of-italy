import type { Violation, ViolationCode } from "../../src/types";

// A comparable identity for violations, so the scheduler's and the validator's reports can be
// compared by what they mean (code, day, stop) rather than by their wording.

/** Codes about a whole day. scheduleDay points TOO_MANY_VISITS at the first extra visit and the
 * validator at the day; both name the same day, so the stop is not part of the identity. */
const DAY_CODES: ReadonlySet<ViolationCode> = new Set<ViolationCode>([
  "EMPTY_DAY",
  "TOO_MANY_VISITS",
  "MEAL_MISSING",
  "LONG_TRANSFER",
  "ANCHOR_NOT_CHOSEN",
]);

/**
 * Codes only one side can know about. Must-include rules are trip-level (scheduleDay never sees
 * the other days), and scheduleDay checks SAME_LOCATION within one day while the validator checks
 * the whole trip.
 */
export const ONE_SIDED: ReadonlySet<ViolationCode> = new Set<ViolationCode>([
  "MUST_INCLUDE_MISSING",
  "MUST_INCLUDE_UNPLACEABLE",
  "SAME_LOCATION",
]);

/** "CODE|day|stop" for stop-level codes, "CODE|day" for day-level ones. */
export function keyOf(violation: Violation): string {
  const stop = DAY_CODES.has(violation.code) ? "" : `|${violation.stopIndex ?? ""}`;
  return `${violation.code}|${violation.day ?? ""}${stop}`;
}

/** Sorted unique keys of the violations both sides can report. */
export function sharedKeys(violations: readonly Violation[]): string[] {
  return [...new Set(violations.filter((v) => !ONE_SIDED.has(v.code)).map(keyOf))].sort();
}
