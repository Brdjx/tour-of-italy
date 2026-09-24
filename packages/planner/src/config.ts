import type { Meal, Pace } from "./types";

// Every tunable number and policy table in one place. Change a value here, run `pnpm check`,
// and the tests tell you what moved. Times are minutes from local midnight.

/** Minutes from midnight for a clock time, so the tables below read like a timetable. */
const at = (hour: number, minute = 0): number => hour * 60 + minute;

// ---------- Trip shape ----------

/** Trip length in days. A 4-day trip is a one-line change here plus the UI copy. */
export const TRIP_DAYS = 3;

/**
 * Day window and visit cap per pace. Meals happen inside the window and do not count toward
 * maxVisits.
 */
// Decision: one window per day with meals inside it, instead of scheduling dinner after the day
// ends. The data has evening-only places (Evenings, by Night) that must be able to follow dinner.
export const PACE: Record<Pace, { dayStart: number; dayEnd: number; maxVisits: number }> = {
  relaxed: { dayStart: at(10), dayEnd: at(22), maxVisits: 3 }, // 10:00 to 22:00
  balanced: { dayStart: at(9, 30), dayEnd: at(22, 30), maxVisits: 5 }, // 09:30 to 22:30
  packed: { dayStart: at(8, 30), dayEnd: at(23, 30), maxVisits: 7 }, // 08:30 to 23:30
};

/**
 * Latest minute any stop time may take: 06:00 the next morning. A stop that runs later is not
 * part of its day at all, so the scheduler and the validator both report it as INVALID_TIME.
 */
// Decision: 1800, not 1440. Past-midnight closings reach 1500 (01:00), so a time just after
// midnight is a real clock time; anything later than a day window allows is OUTSIDE_DAY_WINDOW.
// Shared here (it was the validator's own constant) because the property tests found the two
// sides labelling a stop pushed past it differently.
export const LATEST_MINUTE = 1800;

/** When a meal may START. A lunch at 14:30 is fine; a lunch at 14:45 is not. */
export const MEALS: Record<Meal, { earliestStart: number; latestStart: number }> = {
  lunch: { earliestStart: at(12), latestStart: at(14, 30) }, // 12:00 to 14:30
  dinner: { earliestStart: at(19), latestStart: at(21, 30) }, // 19:00 to 21:30
};

// ---------- Travel ----------

/**
 * Straight-line travel model in four bands. Minutes are rounded up to `roundToMin`.
 * walk: up to 1.5 km at 4.5 km/h. local (taxi, bus, metro): up to 20 km, 10 min overhead plus
 * 25 km/h. regional (train or car): up to 150 km, 30 min overhead plus 70 km/h. intercity
 * (high-speed rail): 45 min overhead plus 170 km/h.
 */
// Decision: an intercity band, because one 80 km/h band makes Rome to Milan 6.5 hours when the
// Frecciarossa takes about 3.
export const TRAVEL = {
  walkMaxKm: 1.5, // longest leg we expect people to walk
  walkKmh: 4.5, // relaxed city walking speed
  localMaxKm: 20, // longest leg by taxi, bus, or metro
  localOverheadMin: 10, // waiting, boarding, and walking to the stop
  localKmh: 25, // city traffic speed
  regionalMaxKm: 150, // longest leg by regional train or car
  regionalOverheadMin: 30, // getting to the station and waiting
  regionalKmh: 70, // regional train or car average
  intercityOverheadMin: 45, // station transfer on both ends
  intercityKmh: 170, // high-speed rail average including stops
  roundToMin: 5, // every leg is rounded up to this many minutes
  bufferMin: 10, // slack between consecutive stops
} as const;

// ---------- Bases (anchors) ----------

/** A city with at least this many places becomes a base. */
export const MIN_PLACES_FOR_BASE = 5;

/** A place outside a base city joins its nearest base if it is within this distance. */
// Decision: 120 km, not the 35 km radius first proposed. 35 km would orphan every day trip in the
// data (Siena, Pienza, Parma, Lake Como, Padua).
export const DAY_TRIP_MAX_KM = 120;

/** At most this many bases in one trip. Three bases in three days is mostly transit. */
export const MAX_ANCHORS_PER_TRIP = 2;

/** A transfer longer than this adds a LONG_TRANSFER warning. */
export const LONG_TRANSFER_MIN = 180;

// ---------- Scoring ----------

/** Weights for scorePlace. Higher score is picked first; ties break by place id. */
export const SCORE_WEIGHTS = {
  interestMatch: 3, // times the share of the traveler's interests the place matches
  rating: 1.5, // times rating / 5 (a missing rating counts as 3.5)
  localFavorite: 0.5, // bonus for the local-favorite tag
  hoursUnknownPenalty: 1.5, // hours not confirmed on that date
  distancePenaltyPerKm: 0.05, // per km from the previous stop
  repeatTypePenalty: 0.75, // same type as the previous stop
  mustInclude: 100, // must-include places always win
} as const;

/** Places rated below this are never suggested unless the traveler asks for them. */
export const MIN_SUGGEST_RATING = 3.5;

// ---------- Interests and requests ----------

/** Tags not offered as interests: they describe price, crowds, time of day, or data status. */
export const INTEREST_EXCLUDED_TAGS: readonly string[] = [
  "tourist-heavy",
  "free",
  "budget",
  "splurge",
  "morning",
  "evening",
  "seasonal",
];

/** Limits on a trip request. The API rejects anything larger. */
export const REQUEST_LIMITS = {
  maxInterests: 8, // interests per request
  maxMustInclude: 10, // must-include place ids
  maxExclude: 10, // excluded place ids
  notesMaxChars: 500, // free-text notes, after trimming
  maxBodyBytes: 16 * 1024, // request body size
  minYear: 2000, // earliest trip year accepted
  maxYear: 2100, // latest trip year accepted
} as const;

/** Longest reason shown per stop, and longest AI summary. Longer text is replaced or cut. */
export const REASON_MAX_CHARS = 140;
export const SUMMARY_MAX_CHARS = 300;

// Data-cleaning policy (visit lengths, hours, notes, locations, reviewed tables) lives in
// dataPolicy.ts and is re-exported here, so every tunable is still imported from config.
export * from "./dataPolicy";
