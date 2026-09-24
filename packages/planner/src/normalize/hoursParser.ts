import { emptyWeek, parseClock, WEEKDAYS } from "../time";
import type { TimeRange, Weekday, WeeklyHours } from "../types";
import { DAY_NAME, dayNumber, expandDays } from "./dayWords";

// Grammar for listed opening hours. Handles every format in the data:
//   "9:00-19:00"  "8am-7pm"  "9am-12:30pm"  "8:00-01:00" (closes after midnight)
//   "Daily 10:00-24:00"  "Tues-Sun 9:00-19:00"  "Wed-Mon 10:00-18:00" (wraps the week)
//   "Tues, Thurs-Sun 10:00-18:00"  "12:00-14:30, 19:00-22:30" (split service)
//   "Mon-Fri 7:00-14:00, Sat 7:00-17:00"  "Mon-Sat 9:30-17:15, Sun 14:00-17:00"
// plus "24h", "Mon closed", and en dashes. A day-qualified string closes the days it does not
// list; a string without days applies to every day.

export type HoursParse =
  | { ok: true; hours: WeeklyHours; pastMidnight: boolean }
  | { ok: false; reason: string; closedDays: Weekday[] }; // closedDays: days the text closes

const DAY = `(${DAY_NAME})s?\\.?`;
const DAY_SPEC = new RegExp(
  `^(?:(daily|every\\s*day)|${DAY}(?:\\s*-\\s*${DAY})?)(?![a-z])\\s*:?\\s*`,
  "i",
);
const TIME = "\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm)?";
const TIME_RANGE = new RegExp(`(${TIME})\\s*-\\s*(${TIME})`, "gi");
// En and em dashes, built from char codes so the source stays plain ASCII.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`, "g");
const ALL_DAY = /^(open\s+)?(24\s*h(ours|rs)?|24\/7)$/i;

/** Parses listed hours text into WeeklyHours, or explains why it could not. */
export function parseWeeklyHours(text: string): HoursParse {
  const cleaned = text.replace(DASHES, "-").replace(/\s+/g, " ").trim();
  if (ALL_DAY.test(cleaned)) {
    const hours = emptyWeek();
    for (const day of WEEKDAYS) hours[day] = [{ open: 0, close: 1440 }];
    return { ok: true, hours, pastMidnight: false };
  }
  const pieces = cleaned
    .split(/[,;]/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (pieces.length === 0) return fail("No hours in the text");
  return buildWeek(pieces);
}

interface PieceParse {
  days: Weekday[] | null; // null when the piece names no days
  closed: boolean; // "Mon closed"
  ranges: TimeRange[];
  pastMidnight: boolean;
}

function buildWeek(pieces: string[]): HoursParse {
  const qualified = new Map<Weekday, TimeRange[]>();
  const closedDays = new Set<Weekday>();
  const unqualified: TimeRange[] = [];
  let pendingDays: Weekday[] = []; // "Tues" in "Tues, Thurs-Sun 10:00-18:00"
  let currentDays: Weekday[] | null = null; // days that a times-only piece continues
  let pastMidnight = false;

  for (const text of pieces) {
    const piece = parsePiece(text);
    if (typeof piece === "string") return fail(piece);
    pastMidnight ||= piece.pastMidnight;
    if (piece.closed) {
      for (const day of piece.days ?? []) closedDays.add(day);
      continue;
    }
    if (piece.days && piece.ranges.length === 0) {
      pendingDays = [...pendingDays, ...piece.days];
      continue;
    }
    let days: Weekday[] | null;
    if (piece.days) days = [...pendingDays, ...piece.days];
    else if (pendingDays.length > 0) days = pendingDays;
    else days = currentDays; // "Mon-Sat 10:00-12:00, 14:30-18:00": the second piece continues
    pendingDays = [];
    if (days === null) {
      unqualified.push(...piece.ranges);
      continue;
    }
    currentDays = days;
    for (const day of days) qualified.set(day, [...(qualified.get(day) ?? []), ...piece.ranges]);
  }
  if (pendingDays.length > 0) return fail("Days listed without times");

  const hours = emptyWeek();
  for (const day of WEEKDAYS) {
    if (closedDays.has(day)) continue;
    const dayRanges = qualified.get(day);
    if (dayRanges) hours[day] = mergeRanges(dayRanges);
    // Decision: times without days apply to every day that no day-qualified piece names.
    else if (unqualified.length > 0) hours[day] = mergeRanges(unqualified);
    // Otherwise the string names days and this is not one of them: closed.
  }
  if (WEEKDAYS.every((day) => hours[day].length === 0)) {
    // Decision: report the days the text closes, so "Closed Mondays" alone still closes Mondays
    // (hours.ts keeps the times unknown) and "Mon-Sun closed" closes the place outright.
    return fail(
      "The hours list no open times",
      [...closedDays].sort((a, b) => a - b),
    );
  }
  return { ok: true, hours, pastMidnight };
}

function fail(reason: string, closedDays: Weekday[] = []): HoursParse {
  return { ok: false, reason, closedDays };
}

/** Parses one comma-separated piece. Returns an error message string when it does not parse. */
function parsePiece(text: string): PieceParse | string {
  let rest = text;
  let days: Weekday[] | null = null;
  let closed = false;
  const closedFirst = /^closed\s+(on\s+)?/i.exec(rest);
  if (closedFirst) {
    closed = true;
    rest = rest.slice(closedFirst[0].length);
  }
  const daySpec = DAY_SPEC.exec(rest);
  if (daySpec) {
    days = daySpec[1] ? [...WEEKDAYS] : daysBetween(daySpec[2], daySpec[3]);
    rest = rest.slice(daySpec[0].length);
  }
  if (/^closed$/i.test(rest.trim())) {
    closed = true;
    rest = "";
  }
  if (closed)
    return days ? { days, closed, ranges: [], pastMidnight: false } : `Unclear closure "${text}"`;

  const ranges: TimeRange[] = [];
  let pastMidnight = false;
  for (const match of rest.matchAll(TIME_RANGE)) {
    const range = toRange(match[1] ?? "", match[2] ?? "");
    if (typeof range === "string") return `${range}: "${match[0]}"`;
    pastMidnight ||= range.close > 1440;
    ranges.push(range);
  }
  const leftover = rest
    .replace(TIME_RANGE, "")
    .replace(/\b(and)\b|[&/]/gi, "")
    .trim();
  if (leftover.length > 0) return `Unrecognized text "${leftover}"`;
  if (!days && ranges.length === 0) return `No days or times in "${text}"`;
  return { days, closed, ranges, pastMidnight };
}

function daysBetween(fromWord: string | undefined, toWord: string | undefined): Weekday[] {
  const from = dayNumber(fromWord ?? "") ?? 0;
  if (toWord === undefined) return [from];
  return expandDays(from, dayNumber(toWord) ?? from); // "Wed-Mon" wraps past Sunday
}

/** Latest closing time that may be read as after midnight (06:00), and the longest such span. */
const LATEST_NEXT_DAY_CLOSE = 6 * 60;
const LONGEST_OVERNIGHT_SPAN = 18 * 60;

/**
 * A time range, or why it cannot be read. A closing time before the opening time means after
 * midnight only when the text leaves no doubt.
 */
function toRange(openText: string, closeText: string): TimeRange | string {
  const open = parseClock(openText);
  const close = parseClock(closeText);
  if (open === null || close === null || open === close || open >= 1440) {
    return "Unreadable time range";
  }
  if (close > open) return { open, close };
  // Decision: "8:00-01:00" closes at 01:00 the next day, stored as 1500 (25:00). "9-5" or
  // "9:00-5:00" is far more likely 09:00 to 17:00, and reading it as a 20-hour day would be a
  // wrong "open", so a range only crosses midnight when it closes by 06:00, spans at most 18
  // hours, and the text is unambiguous: the close says "am" or has a leading zero ("01:00"), or
  // the open is 13:00 or later on a 24-hour clock. Anything else is unreadable (unknown hours).
  const overnight = close + 1440 - open;
  const clear = /am$/i.test(closeText.trim()) || /^0\d/.test(closeText.trim()) || open >= 780;
  if (close > LATEST_NEXT_DAY_CLOSE || overnight > LONGEST_OVERNIGHT_SPAN || !clear) {
    return "Closing time is before the opening time";
  }
  return { open, close: close + 1440 };
}

/** Sorts ranges and merges any that overlap or touch. */
function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.open - b.open);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.open <= last.close) last.close = Math.max(last.close, range.close);
    else merged.push({ ...range });
  }
  return merged;
}
