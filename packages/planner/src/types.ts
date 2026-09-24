// The shared type contract. The planner, the API, and the web app all import these types, so a
// change here is a change to every layer. The runtime lists behind the union types live in
// enums.ts (re-exported here) so the Zod schemas in schemas.ts and these types cannot drift.

import type {
  EXCLUSION_REASONS,
  FALLBACK_REASONS,
  ISSUE_KINDS,
  PACES,
  PLACE_TYPES,
  PLAN_SOURCES,
  VIOLATION_CODES,
} from "./enums";

export {
  EXCLUSION_REASONS,
  FALLBACK_REASONS,
  ISSUE_KINDS,
  PACES,
  PLACE_TYPES,
  PLAN_SOURCES,
  VIOLATION_CODES,
} from "./enums";

// ---------- Time ----------

/** Day of week, 0 = Sunday ... 6 = Saturday (the JavaScript convention). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** An opening range in minutes from local midnight on the visit date. */
export interface TimeRange {
  open: number; // minutes from midnight, 0..1440
  close: number; // minutes from midnight, greater than open; may exceed 1440 when it closes after midnight
}

/** Opening ranges for each weekday. An empty array means closed that day. */
export type WeeklyHours = Record<Weekday, TimeRange[]>;

/** A calendar day without a year, used for seasons that repeat every year. */
export interface MonthDay {
  month: number; // 1..12
  day: number; // 1..31
}

/** An inclusive range of calendar days. `from` after `to` means it wraps the year (Nov to Mar). */
export interface SeasonWindow {
  from: MonthDay; // first open day, inclusive
  to: MonthDay; // last open day, inclusive
}

/**
 * A restriction on which dates a place is open. Every rule on a place must pass for the place
 * to be open on a date. Rules only ever narrow the weekly hours, never widen them.
 */
export type DateRule =
  | { kind: "season"; window: SeasonWindow; source: string } // open only inside the window
  | { kind: "weekdays"; days: Weekday[]; source: string } // open only on these weekdays
  | { kind: "day_of_month"; from: number; to: number; source: string }; // open only on days from..to of any month
// `source` is the note text that produced the rule, kept for display and audit. Day-of-month
// bounds below zero count from the end of the month (-7 to -1 is the last seven days).

// ---------- Places ----------

/** The ten types found in the data, plus "other" for anything unrecognized. */
export type PlaceType = (typeof PLACE_TYPES)[number];

/** Where a place's hours came from. */
export type HoursConfidence =
  | "listed" // parsed from the source hours text
  | "derived" // estimated from free text ("Evenings") or a time of day in the name ("by Night")
  | "open_access" // public space with no set hours, treated as open all day
  | "unknown"; // no usable hours; schedulable inside the day window with a warning

/** How a derived or open-access window was chosen. */
export interface HoursDerivation {
  source: "free_text" | "name_hint" | "open_access"; // which policy produced the window
  match: string; // the text that triggered it ("Evenings", "by Night", or the place type)
  window: TimeRange; // the window applied on every open day
}

export type DurationSource = "listed" | "type_default" | "clamped";
export type LocationSource = "listed" | "swapped" | "neighborhood_centroid" | "city_centroid";
/** 1 = € ... 4 = €€€€. Free places are level 1: the budget filter treats them the same. */
export type PriceLevel = 1 | 2 | 3 | 4;
export type Meal = "lunch" | "dinner";

export interface Place {
  id: string; // source id (place_001) or a generated slug; unique across the dataset
  name: string; // display name, trimmed
  type: PlaceType; // canonical type
  city: string; // canonical English city name
  region: string; // canonical English region name
  neighborhood: string | null; // display only; null means show the city instead
  description: string; // source text, empty when missing
  lat: number; // finite, inside Italy
  lng: number; // finite, inside Italy
  locationSource: LocationSource; // "listed" unless the coordinates were repaired
  hours: WeeklyHours | null; // null = unknown; derived and open-access windows are filled in here
  hoursConfidence: HoursConfidence; // where `hours` came from
  hoursRaw: string | null; // the original hours text, shown when hours are not confirmed
  hoursDerivation: HoursDerivation | null; // set when confidence is "derived" or "open_access"
  dateRules: DateRule[]; // seasons, weekday-only and day-of-month restrictions from source notes
  seasonalNote: string | null; // the raw seasonal note, shown to the traveler as is
  durationMin: number; // visit length in minutes; always fits inside one open range
  durationSource: DurationSource; // "listed" unless defaulted or clamped
  priceLevel: PriceLevel | null; // null = unknown; passes every budget filter
  rating: number | null; // 0..5, null when missing or unusable
  tags: string[]; // lowercase kebab-case, deduplicated, source order
  bookingRequired: boolean | null; // null when the source does not say
  bookAhead: boolean; // booking required, or a note advises booking or warns of sell-outs
  mealCapable: boolean; // can serve as a lunch or dinner stop
  meals: Meal[]; // which meals it can serve; empty when not meal-capable
  sharedLocationWith: string[]; // places never put in the same trip: same spot, or same experience
  issues: DataIssue[]; // every issue logged for this place
}

/** A record that could not become a schedulable place. Never dropped silently. */
export interface ExcludedRecord {
  id: string; // the record's id, or record_<n> when it has none
  name: string | null; // the record's name when it had one
  reason: (typeof EXCLUSION_REASONS)[number]; // why it is left out
  detail: string; // plain explanation
}

// ---------- Data issues ----------

/** Every class of data issue the normalizer logs. summary.ts explains each in plain language. */
export type IssueKind = (typeof ISSUE_KINDS)[number];

export interface DataIssue {
  placeId: string; // the place or excluded record it belongs to; "dataset" for top-level problems
  field: string; // raw field name, e.g. "hours" or "latitude"
  kind: IssueKind; // issue class
  raw: string | null; // the raw value as JSON text, cut to 120 characters; null when not useful
  detail: string; // what was wrong
  action: string; // what the normalizer did about it
}

/** Output of every single-field normalizer: a value plus the issues found. Never throws. */
export interface Normalized<T> {
  value: T;
  issues: DataIssue[];
}

export interface NormalizeResult {
  places: Place[]; // schedulable places, in source order
  excluded: ExcludedRecord[]; // records that did not become places, each with an issue
  issues: DataIssue[]; // every issue, for places and excluded records
}

/** Plain-language data notes for the "About this data" panel. */
export interface DataSummary {
  totals: { records: number; schedulable: number; excluded: number; issues: number };
  headline: string; // one sentence, e.g. "103 places loaded, all usable for planning."
  items: DataSummaryItem[]; // one per issue kind present, most traveler-relevant first
}

export interface DataSummaryItem {
  kind: IssueKind;
  title: string; // short label, sentence case
  explanation: string; // what it means for the traveler
  count: number; // distinct places affected
  places: { id: string; name: string }[]; // affected places, source order
}

// ---------- Trip request and itinerary ----------

export type Pace = (typeof PACES)[number];

export interface TripRequest {
  startDate: string; // YYYY-MM-DD, drives weekdays and seasons
  pace: Pace; // day window and visit cap, see PACE in config.ts
  interests: string[]; // canonical tags
  maxPriceLevel: PriceLevel | null; // null = any price
  anchors: string[] | "auto"; // base ids chosen by the traveler, or let the planner choose
  mustInclude: string[]; // place ids that must appear
  exclude: string[]; // place ids that must not appear
  notes?: string; // free text for the AI layer only, max 500 characters
}

export type StopRole = "visit" | "lunch" | "dinner";
export type ReasonSource = "ai" | "rule";

export interface Stop {
  placeId: string; // a Place id
  start: number; // minutes from midnight on the day's date
  end: number; // minutes from midnight, start + visit length
  travelFromPrevMin: number; // travel from the previous stop (or the base) in minutes
  role: StopRole; // meals do not count toward the pace's visit cap
  reason?: string; // why this stop, one short sentence
  reasonSource?: ReasonSource; // who wrote the reason
}

export interface DayPlan {
  date: string; // YYYY-MM-DD
  anchorId: string; // the base this day visits
  transferMin: number; // travel from the previous day's base, 0 when unchanged or on day 1
  stops: Stop[]; // in visiting order
  returnTravelMin?: number; // travel from the last stop back to the base, 0 for an empty day
}

export type PlanSource = (typeof PLAN_SOURCES)[number];

export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export type ViolationCode = (typeof VIOLATION_CODES)[number];
export type Severity = "error" | "warning";

export interface Violation {
  code: ViolationCode;
  severity: Severity; // errors never reach the traveler; warnings always do
  day?: number; // 0-based day index
  stopIndex?: number; // 0-based stop index within the day, for inline display
  placeId?: string;
  detail: string; // plain explanation
}

export interface ItineraryMeta {
  model?: string; // model id when the AI layer ran
  promptVersion?: string; // prompt version when the AI layer ran
  attempts: number; // model calls made, 0 for rules-only plans
  latencyMs: number; // total planning time
  fallbackReason?: FallbackReason; // why the rules-only planner produced this plan
  generatedAt: string; // ISO 8601 timestamp
}

export interface Itinerary {
  request: TripRequest; // the request this plan answers
  days: DayPlan[]; // TRIP_DAYS days
  source: PlanSource; // who chose the places
  warnings: Violation[]; // warnings only; a plan with errors never reaches the traveler
  summary?: string; // short AI summary, sanitized
  meta: ItineraryMeta;
}

/** A base (anchor): a city with enough places, plus the nearby places it serves as day trips. */
export interface Anchor {
  id: string; // slug of the city name, e.g. "rome"
  name: string; // city name
  region: string; // region of the city
  centroid: { lat: number; lng: number }; // median of its own city's places
  placeIds: string[]; // every place that belongs to this base
}
