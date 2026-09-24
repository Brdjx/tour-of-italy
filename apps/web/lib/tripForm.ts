import {
  type Pace,
  type PriceLevel,
  parseIsoDate,
  REQUEST_LIMITS,
  type TripRequest,
  TripRequestSchema,
} from "@italy/planner";
import type { TripLimits } from "./tripOptions";

// The trip form's values, its checks, and the conversion to a TripRequest. Checks run in the
// browser for fast, specific messages; the final request is still parsed with the planner's
// TripRequestSchema, the same schema the API validates with.

export type AnchorMode = "auto" | "choose";

export interface TripFormValues {
  startDate: string; // YYYY-MM-DD from the date input
  pace: Pace;
  interests: string[];
  maxPriceLevel: PriceLevel | null;
  anchorMode: AnchorMode;
  anchors: string[]; // used when anchorMode is "choose"
  mustInclude: string[];
  exclude: string[];
  notes: string;
}

export type FormField =
  | "startDate"
  | "interests"
  | "anchors"
  | "mustInclude"
  | "exclude"
  | "notes"
  | "form";
export type FormErrors = Partial<Record<FormField, string>>;

/** Days from today to the default start date. */
export const DEFAULT_START_OFFSET_DAYS = 14;

/** YYYY-MM-DD for the traveler's local calendar date. */
export function localIsoDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Empty form. The start date defaults to two weeks from `today`, local time. */
// Decision: a default date so one tap plans a trip; two weeks out is a realistic planning horizon.
export function defaultFormValues(today: Date): TripFormValues {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() + DEFAULT_START_OFFSET_DAYS);
  return {
    startDate: localIsoDate(start),
    pace: "balanced",
    interests: [],
    maxPriceLevel: null,
    anchorMode: "auto",
    anchors: [],
    mustInclude: [],
    exclude: [],
    notes: "",
  };
}

/** Form values that reproduce a request (used after a shared link or "Edit trip"). */
export function valuesFromRequest(request: TripRequest): TripFormValues {
  return {
    startDate: request.startDate,
    pace: request.pace,
    interests: [...request.interests],
    maxPriceLevel: request.maxPriceLevel,
    anchorMode: request.anchors === "auto" ? "auto" : "choose",
    anchors: request.anchors === "auto" ? [] : [...request.anchors],
    mustInclude: [...request.mustInclude],
    exclude: [...request.exclude],
    notes: request.notes ?? "",
  };
}

/** Every problem with the values, one message per field. Empty when the form can be sent. */
export function validateTripForm(values: TripFormValues, limits: TripLimits): FormErrors {
  const errors: FormErrors = {};
  const date = parseIsoDate(values.startDate);
  if (values.startDate.trim() === "") errors.startDate = "Pick a start date.";
  else if (!date) errors.startDate = "Enter a real date, for example 2026-10-06.";
  else if (date.year < REQUEST_LIMITS.minYear || date.year > REQUEST_LIMITS.maxYear) {
    errors.startDate = `Pick a date between ${REQUEST_LIMITS.minYear} and ${REQUEST_LIMITS.maxYear}.`;
  }
  if (values.interests.length > limits.maxInterests) {
    errors.interests = `Pick at most ${limits.maxInterests} interests.`;
  }
  if (values.anchorMode === "choose") {
    if (values.anchors.length === 0) {
      errors.anchors = "Pick at least one base, or let the planner choose.";
    } else if (values.anchors.length > limits.maxAnchors) {
      errors.anchors = `Pick at most ${limits.maxAnchors} bases.`;
    }
  }
  if (values.mustInclude.length > limits.maxMustInclude) {
    errors.mustInclude = `Pick at most ${limits.maxMustInclude} places.`;
  }
  if (values.exclude.length > limits.maxExclude) {
    errors.exclude = `Pick at most ${limits.maxExclude} places.`;
  }
  if (values.mustInclude.some((id) => values.exclude.includes(id))) {
    errors.exclude = "A place cannot be both a must-see and skipped.";
  }
  if (values.notes.trim().length > limits.notesMaxChars) {
    errors.notes = `Keep notes to ${limits.notesMaxChars} characters or fewer.`;
  }
  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** The request for valid values, parsed with the shared schema; null if the schema refuses. */
export function toTripRequest(values: TripFormValues): TripRequest | null {
  const notes = values.notes.trim();
  const candidate = {
    startDate: values.startDate,
    pace: values.pace,
    interests: values.interests,
    maxPriceLevel: values.maxPriceLevel,
    anchors: values.anchorMode === "auto" ? "auto" : values.anchors,
    mustInclude: values.mustInclude,
    exclude: values.exclude,
    ...(notes === "" ? {} : { notes }),
  };
  const parsed = TripRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Adds or removes one value from a list, keeping at most `max` values. */
export function toggleValue(list: readonly string[], value: string, max: number): string[] {
  if (list.includes(value)) return list.filter((item) => item !== value);
  if (list.length >= max) return [...list];
  return [...list, value];
}
