import {
  dateRuleNotes,
  isOpenDuring,
  openStatusOn,
  type Place,
  type TimeRange,
  type Weekday,
  type WeeklyHours,
} from "@italy/planner";
import { formatClock, formatDuration, longDate, ratingText, shortDate, typeWord } from "./format";

// The facts a stop's details sheet shows for its date: the opening hours on that date from the
// planner's own hours logic (openStatusOn and isOpenDuring, the answers the scheduler and the
// validator use), the dates it opens, booking and price with their basis, then what the data
// cannot confirm, each with the listing's own words where it has them. The listing's description is
// kept apart as the listing's words, never as ours. Every function here is total: a bad date
// gives a plain fallback, because a throw inside render would blank the whole plan.
//
// placeFacts is the same reading without a date, for a place opened outside a plan (the
// highlights' place sheet): the typical visit, the hours by weekday as the planner holds them,
// the dates it opens, booking when the listing states it, price and rating.

export type StopFactKey = "hours" | "dates" | "booking" | "price" | "visit" | "rating";

/** One line of a week's hours: "Mon to Sat", "09:00 to 19:00"; `hours` null when closed. */
export interface WeekRow {
  days: string;
  hours: string | null;
}

export interface StopFact {
  key: StopFactKey;
  label: string; // "Hours on Tue 6 Oct"
  value: string; // "09:00 to 19:00"
  numeric: boolean; // the value is clock times, set in tabular figures
  note: string | null; // a checked line under the value: "Your visit fits inside these hours."
  week?: WeekRow[]; // the hours by weekday, shown in place of the value (placeFacts only)
}

export type CaveatKey =
  | "hours"
  | "hours_conflict"
  | "location"
  | "duration"
  | "price"
  | "seasonal_note";

export interface StopCaveat {
  key: CaveatKey;
  text: string; // our sentence, plain
  quote: string | null; // the listing's own words, shown as a quotation after the text
}

export interface StopFactSheet {
  facts: StopFact[];
  unconfirmed: StopCaveat[]; // what the data cannot confirm
  description: string | null; // the listing's own description, attributed as such
}

export interface Visit {
  start: number; // minutes from midnight on the date
  end: number;
}

/** Everything a stop's details sheet says about its place on `date`, for the planned visit. */
export function stopFacts(place: Place, date: string, visit: Visit): StopFactSheet {
  const facts: StopFact[] = [hoursFact(place, date, visit)];
  const dates = datesFact(place);
  if (dates) facts.push(dates);
  facts.push(bookingFact(place), priceFact(place));
  const description = place.description.trim();
  return {
    facts,
    unconfirmed: caveats(place),
    description: description === "" ? null : description,
  };
}

/**
 * Everything the place sheet says about a place without a trip date: the typical visit, the hours
 * by weekday, the dates it opens, booking when the listing states it, price and rating; then what
 * the data cannot confirm and the listing's description, as for a stop.
 */
export function placeFacts(place: Place): StopFactSheet {
  const facts: StopFact[] = [
    {
      key: "visit",
      label: "Typical visit",
      value: formatDuration(place.durationMin),
      numeric: true,
      note: null,
    },
    weekFact(place),
  ];
  const dates = datesFact(place);
  if (dates) facts.push(dates);
  if (place.bookingRequired !== null || place.bookAhead) facts.push(bookingFact(place));
  facts.push(priceFact(place), ratingFact(place));
  const description = place.description.trim();
  return {
    facts,
    unconfirmed: caveats(place),
    description: description === "" ? null : description,
  };
}

/** "09:00 to 19:00", "12:30 to 14:30 and 19:30 to 22:30". */
export function rangesText(ranges: readonly TimeRange[]): string {
  const spans = ranges.map((range) => `${formatClock(range.open)} to ${formatClock(range.close)}`);
  if (spans.length <= 1) return spans[0] ?? "";
  return `${spans.slice(0, -1).join(", ")} and ${spans.at(-1)}`;
}

// ---------- Hours on the date ----------

function hoursFact(place: Place, date: string, visit: Visit): StopFact {
  const label = `Hours on ${shortDate(date)}`;
  let status: ReturnType<typeof openStatusOn>;
  try {
    status = openStatusOn(place, date);
  } catch {
    return {
      key: "hours",
      label: "Hours",
      value: "Not known for this date",
      numeric: false,
      note: null,
    };
  }
  if (status.state === "unknown") {
    return { key: "hours", label, value: "Not in the data", numeric: false, note: null };
  }
  if (status.state === "closed") {
    // Decision: a closed stop can only be on the board after an edit the validator flags; the
    // row's chips say what to do, so this line only states the fact and its source.
    const value =
      status.reason === "weekly"
        ? `Closed on ${weekdayName(date)}s`
        : `Closed on this date, the listing says "${status.rule?.source ?? "some dates only"}"`;
    return { key: "hours", label, value, numeric: false, note: null };
  }
  const note = visitNote(place, date, visit);
  if (place.hoursConfidence === "open_access") {
    return { key: "hours", label, value: "No set hours", numeric: false, note };
  }
  const spans = rangesText(status.ranges);
  const value = place.hoursConfidence === "derived" ? `${spans}, estimated` : spans;
  return { key: "hours", label, value, numeric: true, note };
}

/** Whether the planned visit fits the hours, in the words of the check the validator runs. */
function visitNote(place: Place, date: string, visit: Visit): string | null {
  let answer: ReturnType<typeof isOpenDuring>;
  try {
    answer = isOpenDuring(place, date, visit.start, visit.end);
  } catch {
    return null;
  }
  const whose =
    place.hoursConfidence === "open_access"
      ? "the planned window"
      : place.hoursConfidence === "derived"
        ? "the estimated hours"
        : "these hours";
  if (answer === "yes") return `Your visit fits inside ${whose}.`;
  if (answer === "no") return `Your visit does not fit inside ${whose}.`;
  return null;
}

// ---------- Hours by weekday ----------

const WEEK_ORDER: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * The week from Monday, days with the same hours run together: "Mon to Sat 09:00 to 19:00",
 * "Sun closed". One line reads "Every day" when all seven match.
 */
export function weekRows(hours: WeeklyHours): WeekRow[] {
  const runs: { days: Weekday[]; hours: string | null }[] = [];
  for (const day of WEEK_ORDER) {
    const ranges = hours[day] ?? [];
    const text = ranges.length === 0 ? null : rangesText(ranges);
    const last = runs.at(-1);
    if (last && last.hours === text) last.days.push(day);
    else runs.push({ days: [day], hours: text });
  }
  if (runs.length === 1) return [{ days: "Every day", hours: runs[0]?.hours ?? null }];
  return runs.map((run) => {
    const first = DAY_SHORT[run.days[0] ?? 0];
    const last = DAY_SHORT[run.days.at(-1) ?? 0];
    const days =
      run.days.length === 1
        ? first
        : run.days.length === 2
          ? `${first} and ${last}`
          : `${first} to ${last}`;
    return { days, hours: run.hours };
  });
}

/** The hours by weekday as the planner holds them, or what stands in for them. */
function weekFact(place: Place): StopFact {
  const base = { key: "hours" as const, label: "Hours", numeric: false, note: null };
  if (place.hoursConfidence === "unknown" || place.hours === null) {
    return { ...base, value: "Not in the data" };
  }
  if (place.hoursConfidence === "open_access") return { ...base, value: "No set hours" };
  const week = weekRows(place.hours);
  const value = week.map((row) => `${row.days} ${row.hours ?? "closed"}`).join(", ");
  if (place.hoursConfidence === "derived") {
    return { ...base, value, numeric: true, week, note: "Estimated, not listed." };
  }
  return { ...base, value, numeric: true, week };
}

function weekdayName(date: string): string {
  return longDate(date).split(" ")[0] ?? "that day";
}

/** The days a place opens, from the date rules the planner applies: "Open Apr to Oct". */
function datesFact(place: Place): StopFact | null {
  const labels = dateRuleNotes(place.dateRules).map((note) => note.label);
  if (labels.length === 0) return null;
  return {
    key: "dates",
    label: "Open dates",
    value: labels.join(", "),
    numeric: false,
    note: null,
  };
}

// ---------- Booking and price, with their basis ----------

function bookingFact(place: Place): StopFact {
  const value =
    place.bookingRequired === true
      ? "Required, says the listing. Book before you go."
      : place.bookAhead
        ? "Advised in a note in the listing. Book before you go."
        : place.bookingRequired === false
          ? "Not required, says the listing"
          : "Not in the data";
  return { key: "booking", label: "Booking", value, numeric: false, note: null };
}

function priceFact(place: Place): StopFact {
  const level = place.priceLevel;
  const value = level === null ? "Not in the data" : `Level ${level} of 4 in the data`;
  return { key: "price", label: "Price", value, numeric: false, note: null };
}

function ratingFact(place: Place): StopFact {
  const rating = ratingText(place.rating);
  const value = rating === null ? "Not in the data" : `${rating} of 5 in the data`;
  return { key: "rating", label: "Rating", value, numeric: rating !== null, note: null };
}

// ---------- What the data cannot confirm ----------

function caveats(place: Place): StopCaveat[] {
  const list: StopCaveat[] = [];
  const hours = hoursCaveat(place);
  if (hours) list.push(hours);
  if (place.issues.some((issue) => issue.kind === "hours_conflict")) {
    list.push({
      key: "hours_conflict",
      text: "The listed hours and a note in the listing disagree. The plan follows the stricter one.",
      quote: null,
    });
  }
  const location = locationCaveat(place);
  if (location) list.push(location);
  const duration = durationCaveat(place);
  if (duration) list.push(duration);
  const priceConflict = place.issues.find((issue) => issue.kind === "price_conflict");
  if (priceConflict) {
    list.push({
      key: "price",
      text: `${sentence(priceConflict.detail)} The plan uses the listed price.`,
      quote: null,
    });
  }
  const note = place.seasonalNote?.trim();
  if (note)
    list.push({ key: "seasonal_note", text: "A seasonal note in the listing:", quote: note });
  return list;
}

function hoursCaveat(place: Place): StopCaveat | null {
  const derivation = place.hoursDerivation;
  if (place.hoursConfidence === "unknown") {
    const raw = place.hoursRaw?.trim();
    return raw
      ? {
          key: "hours",
          text: "The listing's hours could not be read. Check them before you go. The listing says:",
          quote: raw,
        }
      : {
          key: "hours",
          text: "The listing gives no opening hours. Check them before you go.",
          quote: null,
        };
  }
  if (place.hoursConfidence === "open_access" && derivation) {
    return {
      key: "hours",
      text: `The listing gives no hours for this public space. It is planned between ${formatClock(derivation.window.open)} and ${formatClock(derivation.window.close)}.`,
      quote: null,
    };
  }
  if (place.hoursConfidence === "derived" && derivation) {
    const span = rangesText([derivation.window]);
    if (derivation.source === "name_hint") {
      return {
        key: "hours",
        text: `The listing gives no hours. They are estimated as ${span} from its name:`,
        quote: derivation.match,
      };
    }
    return {
      key: "hours",
      text: `The listing gives hours only in words, estimated here as ${span}. The listing says:`,
      quote: place.hoursRaw?.trim() || derivation.match,
    };
  }
  return null;
}

function locationCaveat(place: Place): StopCaveat | null {
  if (place.locationSource === "neighborhood_centroid") {
    const near = place.neighborhood ?? place.city;
    return {
      key: "location",
      text: `The listed location looked wrong, so the map shows an estimate near the middle of ${near}.`,
      quote: null,
    };
  }
  if (place.locationSource === "city_centroid") {
    return {
      key: "location",
      text: `The listed location looked wrong, so the map shows an estimate near the middle of ${place.city}.`,
      quote: null,
    };
  }
  return null;
}

function durationCaveat(place: Place): StopCaveat | null {
  if (place.durationSource === "type_default") {
    return {
      key: "duration",
      text: `The listing gives no visit length, so a typical time for a ${typeWord(place.type).toLowerCase()} is planned.`,
      quote: null,
    };
  }
  if (place.durationSource === "clamped") {
    const longer = place.issues.some((issue) => issue.kind === "duration_exceeds_hours");
    return {
      key: "duration",
      text: longer
        ? "The listed visit length is longer than the place is open, so it is shortened to fit."
        : "The listed visit length is outside the usual range for this kind of place, so it is adjusted.",
      quote: null,
    };
  }
  return null;
}

/** The normalizer's detail as a sentence: a capital first and a full stop last. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
