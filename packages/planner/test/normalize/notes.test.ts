import { describe, expect, it } from "vitest";
import { normalizeSeasonalNote, scanDescription, splitClauses } from "../../src/normalize/seasons";
import { makeWeek, openStatusOn, WEEKDAYS } from "../../src/time";
import type { DateRule, WeeklyHours } from "../../src/types";
import { rawData, realResult } from "../helpers";

// Note wordings a refreshed data file could use. Each one either restricts the dates (a rule the
// planner applies), shuts the place (excluded), widens the hours (logged, never applied), or is
// flagged note_unread for review. None may silently leave a place open when the note says closed.

const EN_DASH = String.fromCharCode(0x2013);
const everyDay = makeWeek(WEEKDAYS, [{ open: 540, close: 1140 }]);
const kinds = (issues: { kind: string }[]) => issues.map((issue) => issue.kind);
const note = (raw: unknown, listedHours: WeeklyHours | null = everyDay) =>
  normalizeSeasonalNote(raw, { placeId: "p", listedHours });
const rulesOf = (text: string) => note(text).value.dateRules.map(({ source: _s, ...rule }) => rule);
const season = (from: number, to: number, toDay: number) => ({
  kind: "season",
  window: { from: { month: from, day: 1 }, to: { month: to, day: toDay } },
});
const days = (...list: number[]) => ({ kind: "weekdays", days: list });

describe("note wordings that must restrict the dates", () => {
  it.each([
    [`Open May${EN_DASH}September only.`, [season(5, 9, 30)]],
    ["Open May - September only.", [season(5, 9, 30)]],
    [`Open April ${EN_DASH} October only.`, [season(4, 10, 31)]],
    ["Open November - March only.", [season(11, 3, 31)]],
    ["Open April-October.", [season(4, 10, 31)]],
    ["Summer only.", [season(6, 8, 31)]],
    ["Closed in August.", [season(9, 7, 31)]],
    ["Closed November-March.", [season(4, 10, 31)]],
    ["Closed during winter.", [season(3, 11, 30)]],
    ["Open daily except in August.", [season(9, 7, 31)]],
    ["Open daily except Mondays.", [days(0, 2, 3, 4, 5, 6)]],
    ["Closed on Mondays and Tuesdays.", [days(0, 3, 4, 5, 6)]],
    ["Closed Mon.", [days(0, 2, 3, 4, 5, 6)]],
    ["Open Saturdays only.", [days(6)]],
    ["Last weekend of each month only.", [days(0, 6), { kind: "day_of_month", from: -7, to: -1 }]],
    ["Third Sunday of each month only.", [days(0), { kind: "day_of_month", from: 15, to: 21 }]],
  ])("reads %j as the stricter rule, never as open every day", (text, expected) => {
    expect(rulesOf(text)).toEqual(expected);
    expect(kinds(note(text).issues)).not.toContain("note_unread");
    expect(kinds(note(text).issues)).not.toContain("note_not_applied");
  });

  it("keeps a spaced month range as one clause instead of cutting it to its last month", () => {
    expect(splitClauses("Open November - March only. Bring a coat.")).toEqual([
      "Open November-March only",
      "Bring a coat",
    ]);
    expect(kinds(note("Open April - October only.").issues)).toEqual(["season_restriction"]);
  });

  it("opens a last-weekend place only on the last Saturday and Sunday, by real month length", () => {
    const place = {
      hours: everyDay,
      dateRules: note("Last weekend of each month only.").value.dateRules,
    };
    const open = (date: string) => openStatusOn(place, date).state === "open";
    expect([open("2026-02-21"), open("2026-02-22"), open("2026-02-28")]).toEqual([
      false,
      true,
      true,
    ]);
    expect([open("2028-02-20"), open("2028-02-26"), open("2028-02-27")]).toEqual([
      false,
      true,
      true,
    ]);
    expect([open("2026-10-24"), open("2026-10-25"), open("2026-10-31")]).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("never turns the exception in 'Closed Sundays except last Sunday' into an opening rule", () => {
    const { value, issues } = note("Closed Sundays except last Sunday of the month.");
    expect(value.dateRules).toEqual([
      {
        kind: "weekdays",
        days: [1, 2, 3, 4, 5, 6],
        source: "Closed Sundays except last Sunday of the month",
      },
    ]);
    expect(kinds(issues)).toEqual(["hours_conflict", "note_not_applied"]);
  });
});

describe("notes that shut the place", () => {
  it.each([
    "Temporarily closed.",
    "Closed for restoration until 2027.",
    "Closed until further notice.",
    "Closed January-December.",
  ])("marks %j as closed so the record is excluded, not planned", (text) => {
    const { value, issues } = note(text);
    expect(value.closed).toBe(true);
    expect(kinds(issues)).toEqual(["place_closed"]);
  });

  it("does not shut a whole place for a closure of one part of it", () => {
    const { value, issues } = note("Sistine Chapel ceiling closed for restoration.");
    expect(value.closed).toBe(false);
    expect(kinds(issues)).toEqual(["note_unread"]);
  });
});

describe("notes that look like restrictions but are not understood", () => {
  it.each([
    "Closed on public holidays.",
    "Open daily except public holidays.",
    "Only open when the festival runs.",
  ])("flags %j as note_unread instead of calling it information", (text) => {
    const { value, issues } = note(text);
    expect(value.dateRules).toEqual([]);
    expect(kinds(issues)).toEqual(["note_unread"]);
  });

  it("reads every real note without a single note_unread or closure", () => {
    const texts = rawData().flatMap((r) =>
      typeof r.seasonal_notes === "string" ? [r.seasonal_notes] : [],
    );
    for (const text of texts) {
      expect(kinds(note(text).issues), text).not.toContain("note_unread");
      expect(note(text).value.closed, text).toBe(false);
    }
    const unread = realResult().issues.filter((issue) => issue.kind === "note_unread");
    expect(unread).toEqual([]);
  });

  it("keeps traffic notes as information, not as a Sunday-only rule", () => {
    const { value, issues } = note("Road closed to cars on Sundays only.");
    expect(value.dateRules).toEqual([]);
    expect(kinds(issues)).toEqual(["note_info"]);
  });
});

describe("descriptions are prose: only precise closures count", () => {
  const context = { placeId: "p", listedHours: everyDay };

  it.each([
    "Weekday mornings are quieter, and not only for locals.",
    "Busy on weekends only in high summer.",
    "Open April-October the terrace is lovely.",
    "The museum was closed in August 1944.",
  ])("ignores %j instead of guessing a rule", (text) => {
    expect(scanDescription(text, context)).toEqual({ value: [], issues: [] });
  });

  it("still applies 'Open daily except Mondays' written in a description", () => {
    const rules: DateRule[] = scanDescription("Open daily except Mondays.", context).value;
    expect(rules).toEqual([
      { kind: "weekdays", days: [0, 2, 3, 4, 5, 6], source: "Open daily except Mondays" },
    ]);
  });
});
