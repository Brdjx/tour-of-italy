import {
  type DerivedWindowRule,
  FREE_TEXT_HOURS,
  NAME_TIME_HINTS,
  OPEN_ACCESS_TYPES,
  OPEN_ACCESS_WINDOW,
  PARSE_TEXT_MAX_CHARS,
} from "../config";
import { formatClock, makeWeek, WEEKDAY_SHORT, WEEKDAYS } from "../time";
import type {
  DataIssue,
  DateRule,
  HoursConfidence,
  HoursDerivation,
  Normalized,
  PlaceType,
  TimeRange,
  WeeklyHours,
} from "../types";
import { parseWeeklyHours } from "./hoursParser";
import { cleanText, type IssueTarget, makeIssue } from "./issue";
import { CLOSED_OUTRIGHT } from "./noteGrammar";

// The hours policy. Guiding principle: source notes can only make hours stricter, never looser.
// A wrong "open" wastes a traveler's trip; a wrong "closed" only hides one option.
// Order of precedence:
//   1. listed hours that parse                      -> "listed"
//   2. free text such as "Evenings"                 -> "derived" window from config
//   3. no hours, time of day in the name            -> "derived" window from config
//   4. no hours, public space (square, viewpoint)   -> "open_access" window from config
//   5. anything else                                -> hours unknown
// Text that says the place is shut ("Temporarily closed", "Mon-Sun closed") excludes the record,
// and text that only lists closed days ("Closed Mondays") keeps the times unknown but closes
// those days.

export interface HoursValue {
  hours: WeeklyHours | null; // null when unknown
  confidence: HoursConfidence;
  hoursRaw: string | null; // the original text
  derivation: HoursDerivation | null; // set for derived and open-access windows
  closed: boolean; // the text says the place is shut; the record is excluded
  dateRules: DateRule[]; // days the text closes when it lists no times ("Closed Mondays")
}

export interface HoursContext {
  placeId: string;
  type: PlaceType;
  name: string; // cleaned name, used for time-of-day hints
  publicSpace?: boolean; // open access when no hours; defaults to type in OPEN_ACCESS_TYPES
}

/** Normalizes the raw hours field of one record. Pure; never throws. */
export function normalizeHours(raw: unknown, context: HoursContext): Normalized<HoursValue> {
  const target = { placeId: context.placeId, field: "hours" };
  const text = cleanText(raw);
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    return unknownHours(null, [
      makeIssue(target, "hours_unparsed", raw, "Hours are not text", "Treated as unknown hours"),
    ]);
  }
  if (text === null) return hoursWithoutText(raw, context);

  if (text.length > PARSE_TEXT_MAX_CHARS) {
    const detail = `Hours text is longer than ${PARSE_TEXT_MAX_CHARS} characters`;
    return unknownHours(text, [
      makeIssue(target, "hours_unparsed", raw, detail, "Treated as unknown hours"),
    ]);
  }
  if (CLOSED_OUTRIGHT.test(text)) return closedHours(target, raw, text, `Hours say "${text}"`);
  const freeText = matchRule(FREE_TEXT_HOURS, text);
  if (freeText) {
    const derivation = derive("free_text", text, freeText.window);
    const detail = `Hours say "${text}" instead of times`;
    const action = `Estimated as ${windowText(freeText.window)} every day`;
    return {
      value: {
        hours: everyDay(freeText.window),
        confidence: "derived",
        hoursRaw: text,
        derivation,
        closed: false,
        dateRules: [],
      },
      issues: [makeIssue(target, "hours_free_text", raw, detail, action)],
    };
  }

  const parsed = parseWeeklyHours(text);
  if (!parsed.ok && parsed.closedDays.length === 7) {
    return closedHours(target, raw, text, `Hours close every day: "${text}"`);
  }
  if (!parsed.ok) {
    const detail = `Could not read the hours: ${parsed.reason}`;
    const closedDays = parsed.closedDays;
    if (closedDays.length === 0) {
      return unknownHours(text, [
        makeIssue(target, "hours_unparsed", raw, detail, "Treated as unknown hours"),
      ]);
    }
    const names = closedDays.map((day) => WEEKDAY_SHORT[day]).join(", ");
    const action = `Treated as unknown hours, closed every ${names}`;
    const open = WEEKDAYS.filter((day) => !closedDays.includes(day));
    const rule: DateRule = { kind: "weekdays", days: open, source: text };
    const unknown = unknownHours(text, [makeIssue(target, "hours_unparsed", raw, detail, action)]);
    return { ...unknown, value: { ...unknown.value, dateRules: [rule] } };
  }
  const issues: DataIssue[] = [];
  if (parsed.pastMidnight) {
    const detail = "Closes after midnight";
    const action = "Stored as a closing time past 24:00 on the same day";
    issues.push(makeIssue(target, "hours_past_midnight", raw, detail, action));
  }
  return {
    value: {
      hours: parsed.hours,
      confidence: "listed",
      hoursRaw: text,
      derivation: null,
      closed: false,
      dateRules: [],
    },
    issues,
  };
}

/** Policy for a record with no hours text: name hint, then open access, then unknown. */
function hoursWithoutText(raw: unknown, context: HoursContext): Normalized<HoursValue> {
  const target = { placeId: context.placeId, field: "hours" };
  const hint = matchRule(NAME_TIME_HINTS, context.name, false);
  if (hint) {
    const match = hint.pattern.exec(context.name)?.[0] ?? hint.label;
    const detail = `No hours listed; the name says "${match}"`;
    const action = `Estimated as ${windowText(hint.window)} every day`;
    return {
      value: {
        hours: everyDay(hint.window),
        confidence: "derived",
        hoursRaw: null,
        derivation: derive("name_hint", match, hint.window),
        closed: false,
        dateRules: [],
      },
      issues: [makeIssue(target, "hours_name_hint", raw ?? null, detail, action)],
    };
  }
  if (context.publicSpace ?? OPEN_ACCESS_TYPES.includes(context.type)) {
    const detail = `No hours listed for a public ${context.type.replace("_", " ")}`;
    const action = `Treated as open access, ${windowText(OPEN_ACCESS_WINDOW)} every day`;
    return {
      value: {
        hours: everyDay(OPEN_ACCESS_WINDOW),
        confidence: "open_access",
        hoursRaw: null,
        derivation: derive("open_access", context.type, OPEN_ACCESS_WINDOW),
        closed: false,
        dateRules: [],
      },
      issues: [makeIssue(target, "hours_open_access", raw ?? null, detail, action)],
    };
  }
  const action = "Hours unknown: schedulable inside the day window with a warning";
  return unknownHours(null, [
    makeIssue(target, "hours_missing", raw ?? null, "No hours listed", action),
  ]);
}

function unknownHours(hoursRaw: string | null, issues: DataIssue[]): Normalized<HoursValue> {
  const value: HoursValue = {
    hours: null,
    confidence: "unknown",
    hoursRaw,
    derivation: null,
    closed: false,
    dateRules: [],
  };
  return { value, issues };
}

/** The hours say the place is shut: the record is excluded rather than planned blind. */
// Decision: "Temporarily closed" parsed as unknown hours would stay schedulable with only a
// warning, the wrong "open" the hours policy exists to prevent.
function closedHours(
  target: IssueTarget,
  raw: unknown,
  text: string,
  detail: string,
): Normalized<HoursValue> {
  const issue = makeIssue(target, "place_closed", raw, detail, "Excluded from planning");
  const unknown = unknownHours(text, [issue]);
  return { ...unknown, value: { ...unknown.value, closed: true } };
}

/** First rule whose pattern matches. `whole` rules must match the entire text. */
function matchRule(
  rules: DerivedWindowRule[],
  text: string,
  whole = true,
): DerivedWindowRule | null {
  for (const rule of rules) {
    const match = rule.pattern.exec(text);
    if (match && (!whole || match[0].length === text.length)) return rule;
  }
  return null;
}

function derive(
  source: HoursDerivation["source"],
  match: string,
  window: TimeRange,
): HoursDerivation {
  return { source, match, window: { ...window } };
}

function everyDay(window: TimeRange): WeeklyHours {
  return makeWeek(WEEKDAYS, [window]);
}

function windowText(window: TimeRange): string {
  return `${formatClock(window.open)} to ${formatClock(window.close)}`;
}
