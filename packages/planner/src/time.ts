import { TRIP_DAYS } from "./config";
import type {
  DateRule,
  MonthDay,
  Place,
  SeasonWindow,
  TimeRange,
  Weekday,
  WeeklyHours,
} from "./types";

// Clock and calendar helpers, and the single answer to "is this place open on this date".
// Dates are YYYY-MM-DD strings and times are minutes from local midnight in Italy.
// Decision: the only Date use is Date.UTC plus getUTC* on a calendar date, so the result never
// depends on the machine's time zone. Italian DST does not matter: a day's schedule is in local
// minutes, and a DST switch happens at 02:00 or 03:00, outside every day window.

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MINUTES_PER_DAY = 1440;
const CLOCK_PATTERN = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------- Clock ----------

/**
 * Parses "9:30", "09.30", "9", "24:00", "9am", "12:30pm" into minutes from midnight.
 * Returns null for anything else, including "25:00", "9:60", and "13pm".
 */
export function parseClock(text: string): number | null {
  const match = CLOCK_PATTERN.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const suffix = match[3]?.toLowerCase();
  if (minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    const hour24 = (hour % 12) + (suffix === "pm" ? 12 : 0); // 12am = 0, 12pm = 12
    return hour24 * 60 + minute;
  }
  if (hour > 24 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}

/**
 * Formats minutes from midnight as "HH:MM". 1440 is "24:00" (closing at midnight); later values
 * wrap to the next day, so 1500 is "01:00". Throws RangeError for negative or non-finite input.
 */
export function formatClock(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new RangeError(`formatClock needs a non-negative number of minutes, got ${minutes}`);
  }
  const rounded = Math.round(minutes);
  const clock = rounded === MINUTES_PER_DAY ? MINUTES_PER_DAY : rounded % MINUTES_PER_DAY;
  const hours = Math.floor(clock / 60);
  const mins = clock % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

// ---------- Calendar ----------

export interface CalendarDate {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
}

/** Parses a YYYY-MM-DD string into its parts, or null when it is not a real calendar date. */
export function parseIsoDate(date: string): CalendarDate | null {
  const match = typeof date === "string" ? ISO_DATE_PATTERN.exec(date) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Decision: years below 1000 are rejected because Date.UTC maps years 0 to 99 onto 1900s.
  if (year < 1000 || month < 1 || month > 12 || day < 1) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null; // Feb 30 etc.
  return { year, month, day };
}

/** True for a real calendar date in YYYY-MM-DD form. */
export function isValidIsoDate(date: string): boolean {
  return parseIsoDate(date) !== null;
}

function requireDate(date: string): CalendarDate {
  const parsed = parseIsoDate(date);
  if (!parsed) throw new RangeError(`Expected a YYYY-MM-DD calendar date, got "${date}"`);
  return parsed;
}

function toIsoDate(utc: Date): string {
  const year = String(utc.getUTCFullYear()).padStart(4, "0");
  const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Day of week for a date, 0 = Sunday. Time zone independent. Throws RangeError on bad input. */
export function weekdayOf(date: string): Weekday {
  const { year, month, day } = requireDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() as Weekday;
}

/** The date `days` days after `date` (negative goes back). Handles month, year, and leap days. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = requireDate(date);
  if (!Number.isInteger(days)) throw new RangeError(`addDays needs whole days, got ${days}`);
  return toIsoDate(new Date(Date.UTC(year, month - 1, day + days)));
}

/** The trip's dates, starting at `startDate`. */
export function tripDates(startDate: string, days: number = TRIP_DAYS): string[] {
  const dates: string[] = [];
  for (let index = 0; index < days; index++) dates.push(addDays(startDate, index));
  return dates;
}

/** Month and day of a date, ignoring the year. */
export function monthDayOf(date: string): MonthDay {
  const { month, day } = requireDate(date);
  return { month, day };
}

function monthDayKey(value: MonthDay): number {
  return value.month * 100 + value.day;
}

/** True when the date falls inside the window, inclusive. Windows may wrap the year. */
export function inSeason(date: string, window: SeasonWindow): boolean {
  const key = monthDayKey(monthDayOf(date));
  const from = monthDayKey(window.from);
  const to = monthDayKey(window.to);
  if (from <= to) return key >= from && key <= to;
  return key >= from || key <= to; // wraps the year, e.g. Nov 1 to Mar 31
}

/** Number of days in a month (1..12) of a year. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of the next month
}

/**
 * True when the date passes one date rule. Day-of-month bounds below zero count from the end of
 * the month: -1 is the last day, so -7 to -1 is the last seven days. Throws RangeError on a bad
 * date.
 */
export function dateRuleAllows(rule: DateRule, date: string): boolean {
  if (rule.kind === "season") return inSeason(date, rule.window);
  if (rule.kind === "weekdays") return rule.days.includes(weekdayOf(date));
  const { year, month, day } = requireDate(date);
  const length = daysInMonth(year, month);
  const resolve = (bound: number) => (bound < 0 ? length + 1 + bound : bound);
  return day >= resolve(rule.from) && day <= resolve(rule.to);
}

// ---------- Opening hours ----------

/** A week with the same ranges on the given days and closed on the rest. */
export function makeWeek(days: readonly Weekday[], ranges: readonly TimeRange[]): WeeklyHours {
  const week = emptyWeek();
  for (const day of days) week[day] = ranges.map((range) => ({ ...range }));
  return week;
}

/** A week closed on every day. */
export function emptyWeek(): WeeklyHours {
  return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
}

/** The longest single open range across the week, in minutes. 0 when never open. */
export function longestOpenRange(hours: WeeklyHours): number {
  let longest = 0;
  for (const day of WEEKDAYS) {
    for (const range of hours[day]) longest = Math.max(longest, range.close - range.open);
  }
  return longest;
}

/** Why a place is or is not open on a date. */
export type OpenStatus =
  | { state: "open"; ranges: TimeRange[] }
  | { state: "closed"; reason: "weekly" | "season" | "date_rule"; rule?: DateRule }
  | { state: "unknown" };

/** The fields that decide opening. Accepting this subset keeps tests small. */
export type HoursSource = Pick<Place, "hours" | "dateRules">;

/**
 * Whether a place is open on a date, and when. Date rules (seasons first) are applied before
 * weekly hours, so a place with unknown hours is still closed outside its season. Throws
 * RangeError when `date` is not a real YYYY-MM-DD date, whatever the place.
 */
export function openStatusOn(place: HoursSource, date: string): OpenStatus {
  requireDate(date); // the same error for every place, not only those with rules or hours
  // Season rules first, so a place closed for the winter says "season", not "date rule".
  const seasons = place.dateRules.filter((rule) => rule.kind === "season");
  const others = place.dateRules.filter((rule) => rule.kind !== "season");
  for (const rule of [...seasons, ...others]) {
    if (!dateRuleAllows(rule, date)) {
      return { state: "closed", reason: rule.kind === "season" ? "season" : "date_rule", rule };
    }
  }
  if (place.hours === null) return { state: "unknown" };
  const ranges = place.hours[weekdayOf(date)];
  if (ranges.length === 0) return { state: "closed", reason: "weekly" };
  return { state: "open", ranges: ranges.map((range) => ({ ...range })) };
}

/**
 * The single source of truth for opening on a date: the open ranges ([] when closed) or
 * "unknown". Ranges closing after midnight keep close > 1440 and are not carried into the next
 * day; every day window ends before midnight. Throws RangeError on a bad date.
 */
export function hoursOn(place: HoursSource, date: string): TimeRange[] | "unknown" {
  const status = openStatusOn(place, date);
  if (status.state === "unknown") return "unknown";
  if (status.state === "closed") return [];
  return status.ranges;
}
