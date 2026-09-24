import { PARSE_TEXT_MAX_CHARS } from "../config";
import type { DataIssue, DateRule, Normalized, WeeklyHours } from "../types";
import { cleanText, makeIssue } from "./issue";
import {
  BOOKING,
  CLOSED_DAYS,
  EXCEPT_DAYS,
  joinMonthRanges,
  OPENS_LATER,
  ORDINAL,
} from "./noteGrammar";
import { type ClauseResult, readClause, seasonText } from "./seasonRules";

// Reads seasonal notes (and a few precise description phrases) into date rules.
// Each clause of a note is one of:
//   restriction  "Open April-October only", "Third weekend of each month only",
//                "Tours run weekday mornings only", "Closed Mondays", "Closed in August"
//                                                   -> a DateRule, applied
//   closure      "Temporarily closed", "Closed for restoration"  -> the record is excluded
//   loosening    "Summer hours extend to 19:30", "Open until 2am",
//                "Closed Sundays except the last Sunday"         -> logged, NOT applied
//   unread       looks like a restriction, matches no rule         -> logged for review
//   booking      "pre-book online always", "Booking essential ..." -> Book ahead chip
//   information  "Best April-October", "Can be brutally hot"       -> shown as is
// Decision: notes can only make hours stricter. Loosening text is logged with the reason.

export { seasonText };

export interface NotesValue {
  dateRules: DateRule[]; // restrictions to apply
  seasonalNote: string | null; // cleaned note text
  bookAdvice: boolean; // the note advises booking or warns of sell-outs
  closed: boolean; // the note says the place is shut outright; the record is excluded
}

export interface NotesContext {
  placeId: string;
  listedHours: WeeklyHours | null; // hours parsed from the source, to detect conflicts
  existingRules?: DateRule[]; // rules already found, so a description does not repeat a note
}

// Sentence ends, semicolons, and spaced hyphens, en dashes, or em dashes (built from char codes
// so the source stays plain ASCII). Month ranges are joined first, so "May - September" stays.
const CLAUSE_BREAK = new RegExp(
  `(?<=[.!?;])\\s+|\\s+[-${String.fromCharCode(0x2013, 0x2014)}]\\s+`,
);

/** Splits note text into clauses on sentence ends, semicolons, and spaced dashes. */
export function splitClauses(text: string): string[] {
  return joinMonthRanges(text)
    .split(CLAUSE_BREAK)
    .map((clause) => clause.replace(/[.;]+$/, "").trim())
    .filter(Boolean);
}

/** Normalizes the seasonal_notes field. Pure; never throws. */
export function normalizeSeasonalNote(raw: unknown, context: NotesContext): Normalized<NotesValue> {
  const target = { placeId: context.placeId, field: "seasonal_notes" };
  const note = cleanText(raw);
  if (note === null) {
    const empty = raw === null || raw === undefined || typeof raw === "string";
    const issues = empty
      ? []
      : [makeIssue(target, "note_info", raw, "Seasonal note is not text", "Ignored")];
    return {
      value: { dateRules: [], seasonalNote: null, bookAdvice: false, closed: false },
      issues,
    };
  }
  const dateRules: DateRule[] = [];
  const issues: DataIssue[] = [];
  const informational: string[] = [];
  let closed = false;
  for (const clause of splitClauses(note)) {
    const result = readableClause(clause) ? readClause(clause, target, context) : NOT_READ;
    for (const rule of result.rules) addRule(dateRules, rule);
    issues.push(...result.issues);
    closed ||= result.closed;
    if (!result.handled) informational.push(clause);
  }
  if (informational.length > 0) {
    const detail = `Informational: ${informational.join("; ")}`;
    issues.push(makeIssue(target, "note_info", raw, detail, "Shown as a note; no effect on hours"));
  }
  return {
    value: { dateRules, seasonalNote: note, bookAdvice: BOOKING.test(note), closed },
    issues,
  };
}

/** Scans a description for weekly closures and later-opening phrases only. Pure; never throws. */
export function scanDescription(raw: unknown, context: NotesContext): Normalized<DateRule[]> {
  const target = { placeId: context.placeId, field: "description" };
  const text = cleanText(raw);
  const known = [...(context.existingRules ?? [])];
  const value: DateRule[] = [];
  const issues: DataIssue[] = [];
  for (const clause of text === null ? [] : splitClauses(text)) {
    // Decision: descriptions are prose, so only precise patterns count. Anything else in a
    // description ("weekday mornings are quieter") is ignored rather than guessed at.
    if (!readableClause(clause) || !DESCRIPTION_PATTERNS.some((p) => p.test(clause))) continue;
    const result = readClause(clause, target, context);
    const fresh = result.rules.filter((rule) => !hasRule(known, rule));
    const loosening = result.issues.filter((issue) => issue.kind === "note_not_applied");
    if (fresh.length === 0 && loosening.length === 0) continue; // the note already said it
    for (const rule of fresh) {
      addRule(known, rule);
      addRule(value, rule);
    }
    issues.push(...(fresh.length > 0 ? result.issues : loosening));
  }
  return { value, issues };
}

const DESCRIPTION_PATTERNS = [CLOSED_DAYS, EXCEPT_DAYS, ORDINAL, OPENS_LATER];

const NOT_READ: ClauseResult = { rules: [], issues: [], handled: false, closed: false };

/** Clauses longer than PARSE_TEXT_MAX_CHARS are shown but never pattern-matched. */
function readableClause(clause: string): boolean {
  return clause.length <= PARSE_TEXT_MAX_CHARS;
}

function ruleKey(rule: DateRule): string {
  if (rule.kind === "season") return `season:${JSON.stringify(rule.window)}`;
  if (rule.kind === "weekdays") return `weekdays:${[...rule.days].sort().join(",")}`;
  return `day_of_month:${rule.from}-${rule.to}`;
}

function hasRule(rules: DateRule[], rule: DateRule): boolean {
  const key = ruleKey(rule);
  return rules.some((existing) => ruleKey(existing) === key);
}

/** Adds a rule unless an identical one is already there. */
function addRule(rules: DateRule[], rule: DateRule): void {
  if (!hasRule(rules, rule)) rules.push(rule);
}
