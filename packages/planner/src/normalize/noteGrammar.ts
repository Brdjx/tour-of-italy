import { SEASON_MONTHS } from "../config";
import { MONTH_SHORT } from "../time";
import { DAY_LIST } from "./dayWords";
import { lookup } from "./issue";

// Patterns for source notes. Each one recognizes a wording that restricts or widens the dates a
// place is open. seasonRules.ts turns matches into date rules; anything that looks like a
// restriction but matches none of these is logged as note_unread for a person to review.

const MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const SEASON = "spring|summer|autumn|fall|winter";
const RANGE_SEPARATOR = "\\s*-\\s*|\\s+(?:to|through|thru|until|till)\\s+";
// En and em dashes, built from char codes so the source stays plain ASCII.
const DASH = `[-${String.fromCharCode(0x2013, 0x2014)}]`;

/**
 * A span of months or a season word: "April-October", "May to September", "in August",
 * "during winter". Capture groups: 1 first month, 2 last month, 3 season word.
 */
const WHEN = `(?:(?:in|from|during)\\s+)?(?:the\\s+)?(?:(${MONTH})(?![a-z])(?:(?:${RANGE_SEPARATOR})(${MONTH})(?![a-z]))?|(${SEASON})(?![a-z])(?:\\s+(?:season|months))?)`;

/** "Open April-October only", "Rooftop open May-September", "open only in summer". */
export const OPEN_SEASON = new RegExp(`\\bopen\\s+(?:only\\s+)?${WHEN}`, "i");
/** "October only", "April-October only", "Summer only" at the start of a clause. */
export const SEASON_ONLY = new RegExp(`^${WHEN}\\s+only(?![a-z])`, "i");
/** "Closed in August", "Closed November-March", "Closed during winter". */
export const CLOSED_SEASON = new RegExp(
  `\\bclosed\\s+(?:for\\s+)?(?:the\\s+month\\s+of\\s+)?${WHEN}`,
  "i",
);
/** "Open daily except in August", "Open year-round except winter". */
export const EXCEPT_SEASON = new RegExp(
  `\\b(?:open|daily|every\\s*day|year[-\\s]round|all\\s+year)\\b.*?\\bexcept\\s+(?:the\\s+month\\s+of\\s+)?${WHEN}`,
  "i",
);

/** "Third weekend of each month", "Last Saturday and Sunday of the month", "First Monday ...". */
export const ORDINAL = new RegExp(
  `\\b(first|second|third|fourth|last)\\s+(weekend|${DAY_LIST})\\s+of\\s+(?:each|every|the)\\s+month\\b`,
  "i",
);
/** "Closed Mondays", "Closed on Mondays and Tuesdays", "Closed Mon." */
export const CLOSED_DAYS = new RegExp(
  `\\bclosed\\s+(?:on\\s+)?(?:every\\s+|all\\s+)?(${DAY_LIST})`,
  "i",
);
/** "Open daily except Mondays", "Every day except Mon and Tue". */
export const EXCEPT_DAYS = new RegExp(
  `\\b(?:open|daily|every\\s*day|year[-\\s]round|all\\s+year)\\b.*?\\bexcept\\s+(?:on\\s+)?(?:every\\s+)?(${DAY_LIST})`,
  "i",
);
/** "Saturdays only", "Open Fri-Sun only", "Open only on Saturdays". */
export const ONLY_DAYS = new RegExp(
  `(?:^|\\bopen\\s+)(?:on\\s+)?(${DAY_LIST})\\s+only(?![a-z])|(?:^|\\bopen\\s+)only\\s+(?:on\\s+)?(${DAY_LIST})`,
  "i",
);
export const WEEKDAYS_ONLY = /\bweekdays?\b.*\bonly\b|\bonly\s+(?:on\s+)?weekdays?\b/i;
export const WEEKENDS_ONLY = /\bweekends?\b.*\bonly\b|\bonly\s+(?:on\s+)?weekends?\b/i;

/** The place itself is shut: "Temporarily closed", "Closed for restoration", "Closed". */
export const CLOSED_OUTRIGHT =
  /^(?:(?:temporarily|permanently|currently|now)\s+closed\b|closed\s+(?:for\s+(?:restoration|renovations?|refurbishment|repairs?|works?|construction)|until\s+further\s+notice|indefinitely|temporarily|permanently)\b|closed$)/i;

/** Wording that widens the hours: never applied. */
export const OPENS_LATER =
  /\bhours?\s+extends?\b|\bextended\s+hours\b|\bopen\s+(?:until|till|late)\b/i;
/** "Closed Sundays except the last Sunday": the exception reopens, so it widens. */
export const CLOSED_EXCEPT = /\bclosed\b.*\bexcept\b/i;

/** Booking advice or sell-out warnings: the Book ahead chip. */
export const BOOKING = /\bbook|\breserv|\bsell\s+out|\bsold\s+out/i;
// Decision: "Road closed to cars on Sundays" is about traffic, not opening, so it is information.
export const TRAFFIC_ONLY = /\bclosed\s+to\s+(?:cars|traffic|vehicles|through\s+traffic)\b/i;
/**
 * A note that leaves the dates to the traveler: "check exact festival dates before planning",
 * "dates vary". It restricts nothing the planner can apply, so it stays information; the rule
 * reasons read it (reasons.ts) and say nothing of the date for such a place.
 */
export const DATES_TO_CHECK =
  /\b(?:check|confirm|verify)\b.*\bdates?\b|\bdates?\b.*\b(?:vary|varies|change|changes|to\s+be\s+confirmed|tbc|tba)\b/i;
/** Words that suggest a restriction. A clause with one that no rule reads is note_unread. */
export const RESTRICTION_HINT =
  /\b(?:closed|closes|shut|only|except|not\s+open|no\s+(?:visits|entry|access|tours))\b/i;

/** "Open May - September only" reads as one clause: spaced dashes between months are joined. */
export function joinMonthRanges(text: string): string {
  const range = new RegExp(`\\b(${MONTH})\\s*${DASH}\\s*(${MONTH})\\b`, "gi");
  return text.replace(range, "$1-$2");
}

/** First and last month (1..12) of a WHEN match, starting at capture group `first`. */
export function monthSpan(match: RegExpExecArray, first = 1): { from: number; to: number } | null {
  const season = match[first + 2];
  if (season) return lookup(SEASON_MONTHS, season.toLowerCase()) ?? null;
  const fromWord = match[first];
  if (!fromWord) return null;
  const from = monthNumber(fromWord);
  const toWord = match[first + 1];
  return { from, to: toWord ? monthNumber(toWord) : from };
}

function monthNumber(word: string): number {
  const prefix = word.slice(0, 3).toLowerCase();
  return MONTH_SHORT.findIndex((month) => month.toLowerCase() === prefix) + 1;
}
