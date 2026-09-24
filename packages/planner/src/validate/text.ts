import { formatClock, MONTH_SHORT, parseIsoDate, WEEKDAY_SHORT, weekdayOf } from "../time";
import type { PriceLevel, TimeRange } from "../types";

// Plain-language pieces for violation details. A traveler reads these, so they use names, clock
// times and short dates, never raw ids or minute counts.

const WEEKDAY_PLURAL = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;

/** Longest note quoted from the data in a detail. */
const NOTE_MAX_CHARS = 120;

/** "day 2" for index 1. */
export function dayText(index: number): string {
  return `day ${index + 1}`;
}

/** "Day 2" for index 1, to start a sentence. */
export function dayTitle(index: number): string {
  return `Day ${index + 1}`;
}

/** "Tue 20 Oct 2026". Falls back to the raw text when it is not a real date. */
export function dateText(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return "an invalid date";
  const weekday = WEEKDAY_SHORT[weekdayOf(date)];
  return `${weekday} ${parsed.day} ${MONTH_SHORT[parsed.month - 1]} ${parsed.year}`;
}

/** "Mondays" for a date that falls on a Monday. */
export function weekdayPlural(date: string): string {
  return WEEKDAY_PLURAL[weekdayOf(date)];
}

/** "09:00". Only called with whole, non-negative minutes. */
export function clockText(minutes: number): string {
  return formatClock(minutes);
}

/** "09:00 to 11:00". */
export function spanText(start: number, end: number): string {
  return `${clockText(start)} to ${clockText(end)}`;
}

/** "09:00 to 13:00 and 15:00 to 19:00". */
export function rangesText(ranges: readonly TimeRange[]): string {
  return listText(ranges.map((range) => spanText(range.open, range.close)));
}

/** "a, b and c". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "€€" for level 2. */
export function priceText(level: PriceLevel): string {
  return "€".repeat(level);
}

/** A note from the data, cut to a readable length, in brackets; empty when there is no note. */
export function noteText(note: string | undefined): string {
  const trimmed = (note ?? "").trim();
  if (trimmed === "") return "";
  const short =
    trimmed.length <= NOTE_MAX_CHARS ? trimmed : `${trimmed.slice(0, NOTE_MAX_CHARS - 3)}...`;
  return ` (${short})`;
}
