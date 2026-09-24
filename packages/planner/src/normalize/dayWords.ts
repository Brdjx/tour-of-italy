import type { Weekday } from "../types";
import { lookup } from "./issue";

// Day names shared by the hours parser and the note reader: "Mon", "Tues", "Sundays", and lists
// such as "Mondays and Tuesdays", "Sat & Sun", or "Mon-Wed".

const DAY_WORDS: Record<string, Weekday> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/** Alternation of day names, longest first so "tuesday" is not read as "tue". */
export const DAY_NAME =
  "sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat";

/** One day word with an optional plural "s" and period, never followed by another letter. */
const ONE_DAY = `(?:${DAY_NAME})s?\\.?(?![a-z])`;

/** One day or a range of days ("Mon-Wed"). */
const DAY_ITEM = `${ONE_DAY}(?:\\s*-\\s*${ONE_DAY})?`;

/** A list of days: "Mondays and Tuesdays", "Mon, Tue", "Sat & Sun", "Mon-Wed". No capture groups. */
export const DAY_LIST = `${DAY_ITEM}(?:\\s*(?:,|&|/|\\band\\b|\\bor\\b)\\s*${DAY_ITEM})*`;

/** The weekday for one day word ("Tues", "Sundays", "Mon."), or undefined. */
export function dayNumber(word: string): Weekday | undefined {
  const key = word.toLowerCase().replace(/\.$/, "");
  return lookup(DAY_WORDS, key) ?? lookup(DAY_WORDS, key.replace(/s$/, ""));
}

/** Days from `from` to `to` inclusive, wrapping past Sunday ("Wed-Mon"). */
export function expandDays(from: Weekday, to: Weekday): Weekday[] {
  const days: Weekday[] = [from];
  let day = from;
  while (day !== to) {
    day = ((day + 1) % 7) as Weekday;
    days.push(day);
  }
  return days;
}

/** Reads a day list into sorted, distinct weekdays, or null when any part is not a day. */
export function parseDayList(text: string): Weekday[] | null {
  const days = new Set<Weekday>();
  const items = text.split(/\s*(?:,|&|\/|\band\b|\bor\b)\s*/i).filter((item) => item.length > 0);
  if (items.length === 0) return null;
  for (const item of items) {
    const [fromWord = "", toWord, ...rest] = item.split(/\s*-\s*/);
    const from = dayNumber(fromWord);
    const to = toWord === undefined ? from : dayNumber(toWord);
    if (from === undefined || to === undefined || rest.length > 0) return null;
    for (const day of expandDays(from, to)) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}
