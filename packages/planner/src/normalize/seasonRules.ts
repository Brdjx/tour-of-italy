import { ORDINAL_DAYS } from "../config";
import { MONTH_SHORT, WEEKDAY_SHORT, WEEKDAYS } from "../time";
import type { DataIssue, DateRule, Weekday, WeeklyHours } from "../types";
import { parseDayList } from "./dayWords";
import { type IssueTarget, lookup, makeIssue } from "./issue";
import {
  BOOKING,
  CLOSED_DAYS,
  CLOSED_EXCEPT,
  CLOSED_OUTRIGHT,
  CLOSED_SEASON,
  EXCEPT_DAYS,
  EXCEPT_SEASON,
  monthSpan,
  ONLY_DAYS,
  OPEN_SEASON,
  OPENS_LATER,
  ORDINAL,
  RESTRICTION_HINT,
  SEASON_ONLY,
  TRAFFIC_ONLY,
  WEEKDAYS_ONLY,
  WEEKENDS_ONLY,
} from "./noteGrammar";

// Reads one clause of a note into date rules and issues. Guiding principle: notes can only make
// hours stricter. Restrictions become rules; widening text is logged and ignored; a clause that
// looks like a restriction but matches no rule is logged as note_unread so a person can add one.

export interface ClauseContext {
  listedHours: WeeklyHours | null; // hours parsed from the source, to detect conflicts
}

export interface ClauseResult {
  rules: DateRule[];
  issues: DataIssue[];
  handled: boolean; // false when the clause is information only
  closed: boolean; // the clause says the place is shut outright
}

type MonthSpan = { from: number; to: number };

const LAST_DAY_OF_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const INFO: ClauseResult = { rules: [], issues: [], handled: false, closed: false };

/** Classifies one clause and returns its rules and issues. */
export function readClause(
  clause: string,
  target: IssueTarget,
  context: ClauseContext,
): ClauseResult {
  if (TRAFFIC_ONLY.test(clause)) return INFO;
  // Decision: words after "except" describe the exception ("Closed Sundays except the last
  // Sunday"), so every restriction pattern except the "except ..." ones reads only the text
  // before it. Otherwise "last Sunday of the month" would become an opening rule.
  const head = clause.split(/\bexcept\b/i)[0] ?? clause;
  const closedSeason = closedSeasonWindow(head, clause);
  if (CLOSED_OUTRIGHT.test(clause) || closedSeason === "all_year") {
    const action = "Excluded from planning: the note says the place is closed";
    const issue = makeIssue(target, "place_closed", clause, `Note says "${clause}"`, action);
    return { rules: [], issues: [issue], handled: true, closed: true };
  }
  const rules: DateRule[] = [];
  const issues: DataIssue[] = [];
  const add = (rule: DateRule, issue: DataIssue) => {
    rules.push(rule);
    issues.push(issue);
  };
  const listed = context.listedHours;

  const seasons = [openSeasonWindow(head), closedSeason].filter((window) => window !== null);
  for (const season of seasons) {
    const rule = seasonRule(season.from, season.to, clause);
    const action = `Closed outside ${seasonText(rule)}`;
    add(rule, makeIssue(target, "season_restriction", clause, `Note says "${clause}"`, action));
  }
  const ordinal = ordinalRules(head);
  for (const rule of ordinal?.rules ?? []) rules.push({ ...rule, source: clause });
  if (ordinal) issues.push(restrictionIssue(clause, target, listed !== null, ordinal.action));

  const closedDays = ordinal ? null : closedDaysOf(head, clause);
  // Decision: a closure the listed hours already show adds nothing, so no rule is stored.
  if (closedDays && (listed === null || closedDays.some((day) => listed[day].length > 0))) {
    const open = WEEKDAYS.filter((day) => !closedDays.includes(day));
    const action = `Closed every ${closedDays.map((day) => WEEKDAY_SHORT[day]).join(", ")}`;
    const rule: DateRule = { kind: "weekdays", days: open, source: clause };
    add(rule, restrictionIssue(clause, target, listed !== null, action));
  }
  const onlyDays = ordinal || closedDays ? null : onlyDaysOf(head);
  if (onlyDays) {
    const conflicts =
      listed !== null && WEEKDAYS.some((d) => !onlyDays.includes(d) && listed[d].length > 0);
    // Decision: "Tours run weekday mornings only" keeps only the weekday part. The Parma tour's
    // times stay unknown (docs/data-issues.md), so "mornings" is shown in the note but not turned
    // into hours.
    const action = `Open only ${daysText(onlyDays)}; times of day stay as listed or unknown`;
    const rule: DateRule = { kind: "weekdays", days: onlyDays, source: clause };
    add(rule, restrictionIssue(clause, target, conflicts, action));
  }
  const widens = OPENS_LATER.test(clause) || CLOSED_EXCEPT.test(clause);
  if (widens) {
    const detail = `Note would widen the hours: "${clause}"`;
    const action = "Not applied: notes may only make hours stricter";
    issues.push(makeIssue(target, "note_not_applied", clause, detail, action));
  }
  const recognized = seasons.length > 0 || Boolean(ordinal || closedDays || onlyDays || widens);
  if (!recognized && RESTRICTION_HINT.test(clause) && !BOOKING.test(clause)) {
    const detail = `Note may restrict the dates but was not understood: "${clause}"`;
    const action = "Not applied: review the note and add a rule if it limits the dates";
    issues.push(makeIssue(target, "note_unread", clause, detail, action));
  }
  // A closure the hours already show produced nothing, so it counts as information.
  return { rules, issues, handled: issues.length > 0, closed: false };
}

/** Open window from "Open April-October only", "October only", "Summer only". */
function openSeasonWindow(head: string): MonthSpan | null {
  const match = OPEN_SEASON.exec(head) ?? SEASON_ONLY.exec(head);
  return match ? monthSpan(match) : null;
}

/** The open window left by "Closed November-March" or "Open daily except in August". */
function closedSeasonWindow(head: string, clause: string): MonthSpan | "all_year" | null {
  const match = CLOSED_SEASON.exec(head) ?? EXCEPT_SEASON.exec(clause);
  const closed = match ? monthSpan(match) : null;
  if (!closed) return null;
  const closedMonths = ((closed.to - closed.from + 12) % 12) + 1;
  if (closedMonths === 12) return "all_year";
  return { from: (closed.to % 12) + 1, to: ((closed.from + 10) % 12) + 1 };
}

function seasonRule(from: number, to: number, source: string): DateRule {
  const lastDay = LAST_DAY_OF_MONTH[to - 1] ?? 31; // Feb 29 is harmless in other years
  const window = { from: { month: from, day: 1 }, to: { month: to, day: lastDay } };
  return { kind: "season", window, source };
}

/** "Third weekend of each month" is Saturday and Sunday on days 15 to 21, and so on. */
function ordinalRules(clause: string): { rules: DateRule[]; action: string } | null {
  const match = ORDINAL.exec(clause);
  const range = match ? lookup(ORDINAL_DAYS, (match[1] ?? "").toLowerCase()) : undefined;
  const which = (match?.[2] ?? "").toLowerCase();
  const days = which === "weekend" ? ([0, 6] as Weekday[]) : parseDayList(which);
  if (!range || !days) return null;
  const rules: DateRule[] = [
    { kind: "weekdays", days, source: clause },
    { kind: "day_of_month", ...range, source: clause },
  ];
  const when = range.from < 0 ? "in the last 7 days" : `from day ${range.from} to day ${range.to}`;
  return { rules, action: `Open only ${daysText(days)} ${when} of the month` };
}

/** Days closed by "Closed Mondays and Tuesdays" or "Open daily except Mondays". */
function closedDaysOf(head: string, clause: string): Weekday[] | null {
  const found = new Set<Weekday>();
  for (const match of [CLOSED_DAYS.exec(head), EXCEPT_DAYS.exec(clause)]) {
    for (const day of match ? (parseDayList(match[1] ?? "") ?? []) : []) found.add(day);
  }
  return found.size > 0 && found.size < 7 ? [...found].sort((a, b) => a - b) : null;
}

/** Monday to Friday for "weekdays only", the listed days for "Saturdays only", and so on. */
function onlyDaysOf(clause: string): Weekday[] | null {
  if (WEEKDAYS_ONLY.test(clause)) return [1, 2, 3, 4, 5];
  if (WEEKENDS_ONLY.test(clause)) return [0, 6];
  const match = ONLY_DAYS.exec(clause);
  return match ? parseDayList(match[1] ?? match[2] ?? "") : null;
}

function daysText(days: Weekday[]): string {
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "Monday to Friday";
  if (key === "0,6") return "on Saturday and Sunday";
  return `on ${days.map((day) => WEEKDAY_SHORT[day]).join(", ")}`;
}

/** A conflict when listed hours allow more than the note, otherwise a date restriction. */
function restrictionIssue(
  clause: string,
  target: IssueTarget,
  conflicts: boolean,
  action: string,
): DataIssue {
  if (!conflicts) {
    return makeIssue(target, "date_restriction", clause, `Note says "${clause}"`, action);
  }
  const detail = `Listed hours allow more than the note: "${clause}"`;
  return makeIssue(target, "hours_conflict", clause, detail, `${action}. Using the stricter rule`);
}

/** "Apr to Oct", or "Oct" for a single month. */
export function seasonText(rule: DateRule): string {
  if (rule.kind !== "season") return "";
  const from = MONTH_SHORT[rule.window.from.month - 1] ?? "?";
  const to = MONTH_SHORT[rule.window.to.month - 1] ?? "?";
  return from === to ? from : `${from} to ${to}`;
}
