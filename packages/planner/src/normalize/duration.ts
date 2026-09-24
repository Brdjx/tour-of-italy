import { TYPE_DURATIONS } from "../config";
import { longestOpenRange } from "../time";
import type { DataIssue, DurationSource, Normalized, PlaceType, WeeklyHours } from "../types";
import { makeIssue } from "./issue";

// Visit length in minutes. Missing values take the type default, values outside the type's
// bounds are clamped, and a visit longer than the longest open range is clamped to that range so
// the whole visit always fits inside one opening (the scheduler's invariant).

export interface DurationValue {
  durationMin: number;
  durationSource: DurationSource;
}

export interface DurationContext {
  placeId: string;
  type: PlaceType;
  hours: WeeklyHours | null; // final hours (listed, derived, or open access); null when unknown
}

const HALF_DAY_MIN = 240;
const FULL_DAY_MIN = 480;

/** Normalizes duration_minutes. Pure; never throws. */
export function normalizeDuration(
  raw: unknown,
  context: DurationContext,
): Normalized<DurationValue> {
  const target = { placeId: context.placeId, field: "duration_minutes" };
  const bounds = TYPE_DURATIONS[context.type];
  const issues: DataIssue[] = [];
  let minutes: number | null = null;
  let source: DurationSource = "listed";

  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    minutes = Math.round(raw);
  } else if (typeof raw === "string" && parseDurationText(raw) !== null) {
    minutes = parseDurationText(raw);
    issues.push(
      makeIssue(
        target,
        "duration_format",
        raw,
        "Duration given as text",
        `Read as ${minutes} minutes`,
      ),
    );
  } else if (raw === null || raw === undefined) {
    const action = `Used the ${context.type.replace("_", " ")} default of ${bounds.default} minutes`;
    issues.push(makeIssue(target, "duration_missing", raw ?? null, "No duration listed", action));
  } else {
    const action = `Used the ${context.type.replace("_", " ")} default of ${bounds.default} minutes`;
    issues.push(
      makeIssue(
        target,
        "duration_invalid",
        raw,
        "Duration is not a positive number of minutes",
        action,
      ),
    );
  }
  if (minutes === null) {
    minutes = bounds.default;
    source = "type_default";
  }

  if (minutes < bounds.min || minutes > bounds.max) {
    const clamped = Math.min(Math.max(minutes, bounds.min), bounds.max);
    const detail = `${minutes} minutes is outside the ${bounds.min} to ${bounds.max} minute range for a ${context.type.replace("_", " ")}`;
    issues.push(
      makeIssue(target, "duration_out_of_bounds", raw, detail, `Clamped to ${clamped} minutes`),
    );
    minutes = clamped;
    source = "clamped";
  }

  const longest = context.hours ? longestOpenRange(context.hours) : 0;
  if (longest > 0 && minutes > longest) {
    const detail = `${minutes} minutes is longer than the longest opening (${longest} minutes)`;
    const action = `Clamped to ${longest} minutes so the visit fits inside one opening`;
    issues.push(makeIssue(target, "duration_exceeds_hours", raw, detail, action));
    minutes = longest;
    source = "clamped";
  }
  return { value: { durationMin: minutes, durationSource: source }, issues };
}

/**
 * Reads "90", "90 min", "2h", "1.5 hours", "1-2 hours" (midpoint, rounded to 15), "half day",
 * and "full day". Returns null for anything else or a non-positive result.
 */
export function parseDurationText(text: string): number | null {
  const value = text.trim().toLowerCase();
  if (value.length > 40) return null; // no real duration is this long
  if (/^half[\s-]?day$/.test(value)) return HALF_DAY_MIN;
  if (/^(full|whole)[\s-]?day$/.test(value)) return FULL_DAY_MIN;
  const match =
    /^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*(h|hr|hrs|hours?|m|min|mins|minutes?)?$/.exec(
      value,
    );
  if (!match) return null;
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : Number(match[2]);
  if (high < low) return null;
  const unit = match[3] ?? "min";
  const perUnit = unit.startsWith("h") ? 60 : 1;
  const midpoint = ((low + high) / 2) * perUnit;
  const minutes = match[2] === undefined ? Math.round(midpoint) : Math.round(midpoint / 15) * 15;
  return minutes > 0 && Number.isFinite(minutes) ? minutes : null;
}
