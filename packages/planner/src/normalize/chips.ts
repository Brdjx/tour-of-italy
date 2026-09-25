import { ORDINAL_DAYS } from "../config";
import { WEEKDAY_LONG, WEEKDAY_SHORT } from "../time";
import type { DateRule, Place } from "../types";
import { seasonText } from "./seasons";

// Short data notes shown as chips next to a place, one per fact the traveler should know.
// The wording is shared so the timetable, the swap sheet, and the map all say the same thing.

export type PlaceNoteKind =
  | "hours_unknown"
  | "hours_estimated"
  | "open_access"
  | "season"
  | "date_rule"
  | "hours_conflict"
  | "estimated_duration"
  | "approximate_location"
  | "price_unknown"
  | "book_ahead";

export interface PlaceNote {
  kind: PlaceNoteKind;
  label: string; // chip text, sentence case
}

/** Chips for a place, in a fixed order. */
export function placeNotes(place: Place): PlaceNote[] {
  const notes: PlaceNote[] = [];
  if (place.hoursConfidence === "unknown")
    notes.push({ kind: "hours_unknown", label: "Hours not confirmed" });
  if (place.hoursConfidence === "derived")
    notes.push({ kind: "hours_estimated", label: "Hours estimated from the listing" });
  if (place.hoursConfidence === "open_access")
    notes.push({ kind: "open_access", label: "Public space, no set hours" });
  notes.push(...dateRuleNotes(place.dateRules));
  if (place.issues.some((issue) => issue.kind === "hours_conflict")) {
    notes.push({
      kind: "hours_conflict",
      label: "Hours conflict in source, using the stricter one",
    });
  }
  if (place.durationSource !== "listed")
    notes.push({ kind: "estimated_duration", label: "Estimated visit time" });
  if (place.locationSource !== "listed" && place.locationSource !== "swapped") {
    notes.push({ kind: "approximate_location", label: "Approximate location" });
  }
  if (place.priceLevel === null) notes.push({ kind: "price_unknown", label: "Price unknown" });
  if (place.bookAhead) notes.push({ kind: "book_ahead", label: "Book ahead" });
  return notes;
}

/** One note per restriction: "Open Apr to Oct", "Open Oct only", "Mon to Fri only". */
export function dateRuleNotes(rules: DateRule[]): PlaceNote[] {
  const notes: PlaceNote[] = [];
  const ordinalDays = new Map<string, number[]>(); // weekdays that go with a day-of-month rule
  for (const rule of rules) {
    if (rule.kind !== "weekdays") continue;
    const paired = rules.some(
      (other) => other.kind === "day_of_month" && other.source === rule.source,
    );
    if (paired) ordinalDays.set(rule.source, rule.days);
  }
  for (const rule of rules) {
    if (rule.kind === "season") {
      const text = seasonText(rule);
      notes.push({
        kind: "season",
        label: text.includes(" to ") ? `Open ${text}` : `Open ${text} only`,
      });
    } else if (rule.kind === "day_of_month") {
      const label = dayOfMonthLabel(rule.from, rule.to, ordinalDays.get(rule.source));
      notes.push({ kind: "date_rule", label });
    } else if (!ordinalDays.has(rule.source)) {
      // Decision: the weekday rule that comes with "third weekend" is part of that label, so it
      // gets no chip of its own.
      notes.push({ kind: "date_rule", label: weekdaysLabel(rule.days) });
    }
  }
  return notes;
}

/** "Third Saturday and Sunday of the month only", "Last Sunday of the month only". */
function dayOfMonthLabel(from: number, to: number, days: number[] | undefined): string {
  const ordinal = Object.entries(ORDINAL_DAYS).find(
    ([, range]) => range.from === from && range.to === to,
  )?.[0];
  if (ordinal && days && days.length > 0) {
    const mondayFirst = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const names = mondayFirst.map((day) => WEEKDAY_LONG[day] ?? "?");
    const which =
      names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    return `${ordinal.charAt(0).toUpperCase()}${ordinal.slice(1)} ${which} of the month only`;
  }
  if (from < 0 || to < 0) return "Open some days of the month only";
  return `Open days ${from} to ${to} of the month only`;
}

function weekdaysLabel(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join(",") === "1,2,3,4,5") return "Mon to Fri only";
  if (sorted.join(",") === "0,6") return "Sat and Sun only";
  const closed = [0, 1, 2, 3, 4, 5, 6].filter((day) => !sorted.includes(day));
  if (closed.length > 0 && closed.length <= 2) {
    return `Closed ${closed.map((day) => WEEKDAY_SHORT[day] ?? "?").join(" and ")}`;
  }
  return `${sorted.map((day) => WEEKDAY_SHORT[day] ?? "?").join(", ")} only`;
}
