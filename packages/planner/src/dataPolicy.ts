import type { Meal, PlaceType, TimeRange } from "./types";

// Data-cleaning policy: how the normalizer reads visit lengths, hours, notes, and locations, plus
// the hand-reviewed tables. Re-exported from config.ts; import these from "./config".

/** Minutes from midnight for a clock time, so the tables below read like a timetable. */
const at = (hour: number, minute = 0): number => hour * 60 + minute;

// ---------- Visit length ----------

/** Default visit length and the bounds a listed duration is clamped to, per type. */
// Decision: an earlier proposal had historic_site 75 (min 20) and museum min 45. The data lists
// real short visits below those floors (Mouth of Truth 15 min; Last Supper 30 min, a timed
// slot), so the floors are 15 and 30 and those listings stay as written. The historic_site
// default is 60 because the only one without a length is the Rialto Bridge, a crossing. Rows for
// cafe, viewpoint, neighborhood, park, and shop cover the types the data actually has.
export const TYPE_DURATIONS: Record<PlaceType, { default: number; min: number; max: number }> = {
  restaurant: { default: 90, min: 45, max: 180 },
  cafe: { default: 45, min: 15, max: 120 },
  museum: { default: 120, min: 30, max: 300 },
  historic_site: { default: 60, min: 15, max: 240 },
  viewpoint: { default: 30, min: 15, max: 120 },
  neighborhood: { default: 120, min: 45, max: 240 },
  market: { default: 60, min: 20, max: 150 },
  park: { default: 90, min: 30, max: 240 },
  shop: { default: 60, min: 20, max: 180 },
  experience: { default: 150, min: 45, max: 480 },
  other: { default: 60, min: 15, max: 240 },
};

// ---------- Hours policy ----------

/** A pattern that maps text to an estimated opening window, applied every day. */
export interface DerivedWindowRule {
  pattern: RegExp; // matched case-insensitively against the trimmed text
  window: TimeRange; // estimated opening window
  label: string; // short plain description for data notes
}

/** Free-text hours that are not times but still say when a place is open. */
export const FREE_TEXT_HOURS: DerivedWindowRule[] = [
  { pattern: /^evenings?(\s+only)?$/i, window: { open: at(18), close: at(24) }, label: "evenings" },
  {
    pattern: /^mornings?(\s+only)?$/i,
    window: { open: at(7), close: at(13) },
    label: "mornings",
  },
];

/**
 * Time of day in a place's name, used only when the hours field is empty. Listed hours and
 * free-text hours always win over the name.
 */
// Decision: without this, "Trevi Fountain by Night" would be treated as an open public square and
// could be scheduled at 10:00. "Early morning" runs to 11:00 and "at dawn" to 10:00: a 90-minute
// early walk through Cannaregio, before the day-trippers arrive around 11:00, could otherwise
// never be planned at all (a packed day starts at 08:30 and the walk is 20 minutes away).
export const NAME_TIME_HINTS: DerivedWindowRule[] = [
  {
    pattern: /\b(by|at)\s+night\b/i,
    window: { open: at(20), close: at(24) },
    label: "night",
  },
  {
    pattern: /\bat\s+dawn\b/i,
    window: { open: at(6), close: at(10) },
    label: "dawn",
  },
  {
    pattern: /\bearly\s+morning\b/i,
    window: { open: at(6), close: at(11) },
    label: "early morning",
  },
  {
    pattern: /\baperitivo\b/i,
    window: { open: at(17, 30), close: at(21) },
    label: "aperitivo hour",
  },
];

/** Types that are public spaces: no hours listed means open access, not unknown. */
// Decision: every null-hours historic site in the data is a square, fountain, bridge, or arcade,
// so historic_site is included. Only these raw types (and PUBLIC_SPACE_ALIASES) get open access:
// a record typed "church" or "ruins" maps to historic_site but keeps unknown hours, because those
// are usually ticketed or have opening times.
export const OPEN_ACCESS_TYPES: readonly PlaceType[] = [
  "viewpoint",
  "neighborhood",
  "park",
  "historic_site",
];

/** Raw type words (folded, spaces as underscores) that are public spaces, like the types above. */
export const PUBLIC_SPACE_ALIASES: readonly string[] = [
  "square",
  "piazza",
  "lookout",
  "panorama",
  "district",
  "quarter",
];

/** Window for open-access public spaces with no listed hours. */
export const OPEN_ACCESS_WINDOW: TimeRange = { open: at(7), close: at(23) }; // 07:00 to 23:00

/**
 * Day-of-month ranges for "third weekend", "first Monday", "last Sunday", and so on. Negative
 * days count from the end of the month: -7 to -1 is the last seven days, whatever its length.
 */
// Decision: "third weekend" means a Saturday or Sunday on the 15th to the 21st, which is exactly
// "the third Saturday and the third Sunday" (the wording in the Brera market description). In a
// month that starts on a Sunday those two days are not adjacent, so the chip says "Third Saturday
// and Sunday of the month only" rather than "third weekend".
export const ORDINAL_DAYS: Record<string, { from: number; to: number }> = {
  first: { from: 1, to: 7 },
  second: { from: 8, to: 14 },
  third: { from: 15, to: 21 },
  fourth: { from: 22, to: 28 },
  last: { from: -7, to: -1 },
};

/** Months for season words in notes ("Summer only", "Closed in winter"). */
// Decision: meteorological seasons, the narrowest common reading, so "summer only" never opens a
// place in September.
export const SEASON_MONTHS: Record<string, { from: number; to: number }> = {
  spring: { from: 3, to: 5 },
  summer: { from: 6, to: 8 },
  autumn: { from: 9, to: 11 },
  fall: { from: 9, to: 11 },
  winter: { from: 12, to: 2 },
};

// ---------- Meals ----------

/**
 * Non-restaurant places that can serve as a meal stop, reviewed by hand. Add an id here to make
 * another place meal-capable. Every restaurant is meal-capable without being listed.
 */
export const EXTRA_MEAL_PLACES: Record<string, { meals: Meal[]; reason: string }> = {
  place_015: { meals: ["lunch"], reason: "Mercato Testaccio has lunch stalls" },
  place_031: { meals: ["lunch", "dinner"], reason: "Mercato Centrale is a food hall" },
  place_037: { meals: ["dinner"], reason: "Aperitivo at Rasputin serves food with drinks" },
  place_046: { meals: ["lunch"], reason: "Via Drapperie delis serve lunch" },
  place_068: { meals: ["dinner"], reason: "A cicchetti crawl is a dinner of small plates" },
  place_079: { meals: ["dinner"], reason: "Cremeria Mascareta serves plates with wine" },
  place_099: { meals: ["lunch", "dinner"], reason: "Eataly has restaurants inside" },
  place_100: { meals: ["dinner"], reason: "An aperitivo walk with food, eaten as dinner" },
};

// ---------- Flagship places ----------

/**
 * Places the owner wants a trip to favour, reviewed by hand. Each gets SCORE_WEIGHTS.flagship
 * (score.ts), a small lead over sights like it; a traveler's interests and must-includes still
 * decide first. Add an id here to favour another place, and measure it (docs/planner.md).
 */
// Decision: the owner's call (2026-09-25): give the Vatican Museums extra emphasis, so more Rome
// trips include them. A reviewed list, not a tag: tags come from the source and say what a place
// is ("iconic" is on 31 places), while this is an editorial pick of a few ids that a data refresh
// must not add to or drop, kept with its reason like the meal places above.
export const FLAGSHIP_PLACES: Record<string, { reason: string }> = {
  place_010: { reason: "The Vatican Museums and the Sistine Chapel, the owner's pick for Rome" },
};

// ---------- Location ----------

/**
 * Pairs of listings that are the same experience, reviewed by hand. They are linked like shared
 * locations, so the planner never puts both in one trip. Add a group to link more.
 */
export const SAME_EXPERIENCE_GROUPS: { ids: string[]; reason: string }[] = [
  {
    ids: ["place_044", "place_083"],
    reason: "The balsamic tasting (044) recommends Acetaia Giusti, which is listed as 083",
  },
];

/**
 * Neighborhood labels the source gets wrong, reviewed by hand. Applied only while the source
 * still says `from`, so a corrected source is never overwritten. `to: null` shows the city.
 */
export const NEIGHBORHOOD_CORRECTIONS: Record<
  string,
  { from: string; to: string | null; reason: string }
> = {
  place_026: {
    from: "Oltrarno",
    to: "Piazza della Signoria",
    reason: "The Uffizi is on the north bank beside Piazza della Signoria, not across the Arno",
  },
  place_033: {
    from: "Oltrarno",
    to: null,
    reason: "Buca dell'Orafo is on the north bank at Ponte Vecchio, not across the Arno",
  },
};

/** A place further than this from its city's median centroid has suspect coordinates. */
export const FAR_FROM_CITY_KM = 40;

/** The far-from-city check needs at least this many other places in the same city. */
// Decision: with a single sibling there is no way to tell which of the two is wrong.
export const MIN_SIBLINGS_FOR_FAR_CHECK = 2;

/** Two places closer than this share a location (the same fountain by day and by night). */
export const SAME_LOCATION_MAX_M = 15;

/** Most shared-location links per place. More places than this on one spot is a data error. */
// Decision: a cap keeps a corrupted file with thousands of identical points linear; links are
// always made in pairs, so a capped place is never linked one way only.
export const MAX_SHARED_LINKS = 20;

/** Bounding box of Italy. Coordinates outside it are rejected or swapped. */
export const ITALY_BBOX = { minLat: 35.4, maxLat: 47.1, minLng: 6.6, maxLng: 18.6 } as const;

// ---------- Data quality ----------

/** Ratings above 5 and up to this are read as a 10-point scale and halved. */
export const RATING_TEN_POINT_MAX = 10;

/**
 * Longest hours text or note clause the readers will pattern-match. Longer text is kept for
 * display but treated as unreadable (hours) or informational (notes), so a corrupted file with
 * megabyte-long strings cannot make the regular expressions slow.
 */
export const PARSE_TEXT_MAX_CHARS = 300;

/** Raw values in data issues are cut to this many characters. */
export const ISSUE_RAW_MAX_CHARS = 120;

/** Issue details and actions are cut to this many characters, so one bad record cannot bloat the log. */
export const ISSUE_TEXT_MAX_CHARS = 300;
