import type { Meal, Pace } from "./types";

// Every tunable number and policy table in one place. Change a value here, run `pnpm check`,
// and the tests tell you what moved. Times are minutes from local midnight.

/** Minutes from midnight for a clock time, so the tables below read like a timetable. */
const at = (hour: number, minute = 0): number => hour * 60 + minute;

// ---------- Trip shape ----------

/**
 * Trip length in days. A 4-day trip is a one-line change here plus the UI copy: the planner, the
 * validator, and the tests all read this constant, and the hand-written validator trips are
 * fitted to it (test/validate/tripLength.ts). The whole planner suite passes at 3 and at 4.
 */
// Decision: 2 or 5 days also plan and validate, but some tests pin behavior that changes with
// the length (a 2-day trip has no third day to corrupt; thin bases run dry over 5 days).
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

/**
 * An outing: a visit of at least OUTING_MIN_MINUTES that is not a meal place (a day trip, a bike
 * ride, the Vatican Museums). An outing under way for at least MEAL_COVER_MIN minutes of a meal's
 * start window includes that meal, so the day needs no separate stop for it.
 */
// Decision: 240 and 60 minutes. Every day trip in the data is 300 to 480 minutes and the longest
// city visits are 240 (Vatican Museums, Appian Way by bike); a traveler eats during those, not
// before. Burano from 09:05 to 14:05 is under way for two hours of the lunch window: lunch is on
// the island, and "no lunch stop" would be a false alarm.
export const OUTING_MIN_MINUTES = 240;
export const MEAL_COVER_MIN = 60;

/** When a meal may START. A lunch at 14:30 is fine; a lunch at 14:45 is not. */
export const MEALS: Record<Meal, { earliestStart: number; latestStart: number }> = {
  lunch: { earliestStart: at(12), latestStart: at(14, 30) }, // 12:00 to 14:30
  dinner: { earliestStart: at(19), latestStart: at(21, 30) }, // 19:00 to 21:30
};

/**
 * The trip back to the base after a dinner that ends the day may end up to this many minutes
 * after the pace's day end. The dinner itself still ends inside the day window.
 */
// Decision: 30 minutes, for the walk home after a long dinner. A cicchetti crawl or an aperitivo
// walk runs 3 hours from 19:00, so at a relaxed pace (day end 22:00) it ended at 22:00 with 20
// minutes still to go and was never planned: relaxed Milan had no dinner on any day. After the
// day's last dinner nothing else is planned, so the window only needs to cover getting home.
export const DINNER_RETURN_GRACE_MIN = 30;

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

/**
 * Areas where the local band is a water bus rather than a taxi or bus. A leg with both ends
 * inside the box is labeled with `words`; the minutes are the same local band.
 */
export const WATER_BUS_AREAS: readonly {
  name: string;
  box: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  words: string;
}[] = [
  {
    name: "Venice lagoon",
    box: { minLat: 45.38, maxLat: 45.52, minLng: 12.28, maxLng: 12.46 },
    words: "by vaporetto",
  },
];

/**
 * Islands reachable only by boat, as circles. A leg with one end on such an island and the other
 * end off it is never a walk: it takes at least the local band (the water bus).
 */
// Decision: circles for the two lagoon islands in the data. San Giorgio Maggiore is 500 m from
// the Doge's Palace, which the distance bands would call a 10-minute walk across open water.
export const BOAT_ONLY_ISLANDS: readonly {
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
}[] = [
  { name: "San Giorgio Maggiore", lat: 45.4292, lng: 12.3434, radiusKm: 0.35 },
  { name: "Burano", lat: 45.4852, lng: 12.4175, radiusKm: 0.8 },
];

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
// Decision: iconic 0.75 and localFavorite 0.25 (it was 0.5 with no iconic term). With no
// interests, 13 Roman local favorites (a book market, a gelato shop) outscored the Colosseum and
// the Vatican Museums, which then never made a Rome trip. Headline sights now lead unless the
// traveler's interests say otherwise (an interest match is worth up to 3).
export const SCORE_WEIGHTS = {
  interestMatch: 3, // times the share of the traveler's interests the place matches
  rating: 1.5, // times rating / 5 (a missing rating counts as MIN_SUGGEST_RATING)
  iconic: 0.75, // bonus for the iconic tag: the sights a first visit is built around
  localFavorite: 0.25, // bonus for the local-favorite tag
  hoursUnknownPenalty: 1.5, // hours not confirmed on that date
  distancePenaltyPerKm: 0.05, // per km from the previous stop
  repeatTypePenalty: 0.75, // same type as the previous stop
  mustInclude: 100, // must-include places always win
} as const;

/** An outing (a day trip) is charged for at most this distance by the score (score.ts). */
export const OUTING_DISTANCE_CAP_KM = 10;

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

/** Longest place or base id, violation detail, and claimed travel time the API schema accepts. */
export const ID_MAX_CHARS = 64;
export const DETAIL_MAX_CHARS = 500;
export const MAX_TRAVEL_MINUTES = 1440; // any single leg, transfer, or trip back to the base

/** Length of a record id: an AI plan the API keeps, or a saved trip (RecordIdSchema). */
export const RECORD_ID_LENGTH = 10;

// Data-cleaning policy (visit lengths, hours, notes, locations, reviewed tables) lives in
// dataPolicy.ts and is re-exported here. The greedy planner's own tunables (how it walks a day
// and picks bases) live in planPolicy.ts, because only the rules-only planner reads them.
export * from "./dataPolicy";
