import {
  MONTH_SHORT,
  type PlaceType,
  type PriceLevel,
  parseIsoDate,
  formatClock as plannerClock,
  formatDuration as plannerDuration,
  type TravelMode,
  travelLabelFor,
  weekdayOf,
} from "@italy/planner";

// Display text for times, durations, prices, ratings, dates and travel. Thin wrappers over the
// planner's own formatters where they exist, so the timetable, the swap sheet and the API all
// say the same thing. Every function here is total: bad input gives a safe placeholder, because
// a formatting throw inside render would blank the whole plan.

const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "09:30". Minutes past 1440 wrap to the next morning ("01:00"). */
export function formatClock(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "--:--";
  return plannerClock(minutes);
}

/** A `datetime` attribute for a <time> element: "2026-10-06T09:30". Past midnight moves a day. */
export function clockDateTime(date: string, minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0 || !parseIsoDate(date)) return date;
  const dayOffset = Math.floor(Math.round(minutes) / 1440);
  const day = dayOffset > 0 ? shiftDate(date, dayOffset) : date;
  return `${day}T${plannerClock(Math.round(minutes) % 1440)}`;
}

function shiftDate(date: string, days: number): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  const utc = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return utc.toISOString().slice(0, 10);
}

/** "45 min", "2 h", "1 h 15 min". */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "";
  return plannerDuration(Math.round(minutes));
}

/** "Tue 6 Oct" for tabs. */
export function shortDate(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  const weekday = WEEKDAY_SHORT[weekdayOf(date)];
  return `${weekday} ${parsed.day} ${MONTH_SHORT[parsed.month - 1] ?? ""}`.trim();
}

/** "Tuesday 6 October" for the day header. */
export function longDate(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  return `${WEEKDAY_LONG[weekdayOf(date)]} ${parsed.day} ${MONTH_LONG[parsed.month - 1] ?? ""}`;
}

/** "€€" for level 2; empty for unknown (the chip says "Price unknown" instead). */
export function priceSymbols(level: PriceLevel | null): string {
  return level === null ? "" : "€".repeat(level);
}

/** Screen reader text for a price level. */
export function priceLabel(level: PriceLevel | null): string {
  if (level === null) return "Price unknown";
  const words = ["", "Inexpensive", "Moderate", "Expensive", "Very expensive"];
  return `${words[level]}, price level ${level} of 4`;
}

/** "4.7" with one decimal, or null when there is no rating. */
export function ratingText(rating: number | null): string | null {
  if (rating === null || !Number.isFinite(rating)) return null;
  return rating.toFixed(1);
}

const TYPE_WORDS: Record<PlaceType, string> = {
  historic_site: "Historic site",
  restaurant: "Restaurant",
  experience: "Experience",
  museum: "Museum",
  viewpoint: "Viewpoint",
  cafe: "Cafe",
  neighborhood: "Neighborhood",
  market: "Market",
  park: "Park",
  shop: "Shop",
  other: "Place",
};

/** "Historic site in Monti", or "Museum in Florence" when the neighborhood is unknown. */
export function placeSubtitle(place: {
  type: PlaceType;
  neighborhood: string | null;
  city: string;
}): string {
  const where = place.neighborhood ?? place.city;
  return `${TYPE_WORDS[place.type] ?? "Place"} in ${where}`;
}

export function typeWord(type: PlaceType): string {
  return TYPE_WORDS[type] ?? "Place";
}

/** "12 min walk"; a zero-minute leg is "Same spot, no travel". */
export function travelText(minutes: number, mode: TravelMode): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "";
  return travelLabelFor(Math.round(minutes), mode);
}

/** "1 h 40 min by train or car from Rome", for a day that starts with a transfer. */
export function transferText(minutes: number, mode: TravelMode, fromName: string): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  return `${travelText(minutes, mode)} from ${fromName}`;
}

/** "1 stop" or "3 stops". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
