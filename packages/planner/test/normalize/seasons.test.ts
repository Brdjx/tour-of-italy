import { describe, expect, it } from "vitest";
import { normalizeSeasonalNote, scanDescription, splitClauses } from "../../src/normalize/seasons";
import { makeWeek, WEEKDAYS } from "../../src/time";
import type { DateRule, WeeklyHours } from "../../src/types";
import { rawData } from "../helpers";

// Source notes can only make hours stricter, never looser. These tests use every real note and
// prove that restrictions are applied, loosening text is logged but ignored, and nothing is lost.

const everyDay = makeWeek(WEEKDAYS, [{ open: 540, close: 1140 }]);
const kinds = (issues: { kind: string }[]) => issues.map((issue) => issue.kind);
const note = (raw: unknown, listedHours: WeeklyHours | null = everyDay) =>
  normalizeSeasonalNote(raw, { placeId: "p", listedHours });
const season = (fromMonth: number, toMonth: number, toDay: number, source: string): DateRule => ({
  kind: "season",
  window: { from: { month: fromMonth, day: 1 }, to: { month: toMonth, day: toDay } },
  source,
});

describe("normalizeSeasonalNote on real notes", () => {
  it.each([
    ["Open April-October only.", season(4, 10, 31, "Open April-October only")],
    [
      "Open April-October only. Best in September during harvest season.",
      season(4, 10, 31, "Open April-October only"),
    ],
    ["Rooftop open May-September only.", season(5, 9, 30, "Rooftop open May-September only")],
    [
      `October only ${String.fromCharCode(0x2014)} check exact festival dates before planning.`,
      season(10, 10, 31, "October only"),
    ],
  ])("closes the place outside the season in %j", (text, rule) => {
    const { value, issues } = note(text);
    expect(value.dateRules).toEqual([rule]);
    expect(kinds(issues)).toContain("season_restriction");
  });

  it("limits the Brera market to the third weekend and flags the conflict with its listed hours", () => {
    const weekend = makeWeek([0, 6], [{ open: 540, close: 1140 }]);
    const { value, issues } = note("Third weekend of each month only.", weekend);
    expect(value.dateRules).toEqual([
      { kind: "weekdays", days: [0, 6], source: "Third weekend of each month only" },
      { kind: "day_of_month", from: 15, to: 21, source: "Third weekend of each month only" },
    ]);
    expect(kinds(issues)).toEqual(["hours_conflict"]);
  });

  it("limits the Parma tour to weekdays while its hours stay unknown", () => {
    const text = `Tours run weekday mornings only ${String.fromCharCode(0x2014)} plan ahead.`;
    const { value, issues } = note(text, null);
    expect(value.dateRules).toEqual([
      { kind: "weekdays", days: [1, 2, 3, 4, 5], source: "Tours run weekday mornings only" },
    ]);
    expect(kinds(issues)).toEqual(["date_restriction", "note_info"]);
  });

  it("does not reopen the Vatican Museums on the last Sunday of the month", () => {
    const monSat = makeWeek([1, 2, 3, 4, 5, 6], [{ open: 540, close: 1080 }]);
    const { value, issues } = note(
      "Closed Sundays except last Sunday of the month (free entry, massive crowds).",
      monSat,
    );
    expect(value.dateRules).toEqual([]);
    expect(kinds(issues)).toEqual(["note_not_applied"]);
  });

  it("does not extend Boboli Gardens to 19:30 in summer", () => {
    const { value, issues } = note(
      "Summer hours extend to 19:30. Can be brutally hot July-August.",
    );
    expect(value.dateRules).toEqual([]);
    expect(kinds(issues)).toEqual(["note_not_applied", "note_info"]);
  });

  it.each([
    "Best April-October. Road closed to cars on Sundays only.",
    "Best May-September when canal-side seating is open.",
    "Summer weekends extremely crowded.",
    "Booking essential April-October.",
  ])("treats %j as information only, never as a closure", (text) => {
    const { value, issues } = note(text);
    expect(value.dateRules).toEqual([]);
    expect(kinds(issues)).toEqual(["note_info"]);
  });

  it.each([
    [`Summer queues can be brutal ${String.fromCharCode(0x2014)} pre-book online always.`, true],
    ["Tickets frequently sell out 2 months in advance.", true],
    ["Booking essential April-October.", true],
    ["Best April-October.", false],
  ])("detects booking advice in %j (%s) for the Book ahead chip", (text, advice) => {
    expect(note(text).value.bookAdvice).toBe(advice);
  });

  it("classifies every real seasonal note without losing one", () => {
    const notes = rawData().flatMap((record) =>
      typeof record.seasonal_notes === "string" ? [record.seasonal_notes] : [],
    );
    expect(notes).toHaveLength(16);
    for (const text of notes) {
      const { value, issues } = note(text);
      expect(value.seasonalNote).toBe(text);
      expect(issues.length, text).toBeGreaterThan(0);
    }
  });

  it.each([null, undefined, ""])("returns no rules and no issues for an empty note (%j)", (raw) => {
    expect(note(raw)).toEqual({
      value: { dateRules: [], seasonalNote: null, bookAdvice: false, closed: false },
      issues: [],
    });
  });

  it("logs a non-text note instead of crashing", () => {
    expect(kinds(note({ months: "Apr-Oct" }).issues)).toEqual(["note_info"]);
  });

  it("applies a weekly closure the listed hours do not show", () => {
    const { value, issues } = note("Closed Mondays.");
    expect(value.dateRules).toEqual([
      { kind: "weekdays", days: [0, 2, 3, 4, 5, 6], source: "Closed Mondays" },
    ]);
    expect(kinds(issues)).toEqual(["hours_conflict"]);
  });

  it("applies a weekends-only note", () => {
    expect(note("Weekends only.", null).value.dateRules).toEqual([
      { kind: "weekdays", days: [0, 6], source: "Weekends only" },
    ]);
  });
});

describe("scanDescription", () => {
  const context = { placeId: "p", listedHours: makeWeek(WEEKDAYS, [{ open: 1080, close: 1440 }]) };

  it("logs 'Open until 2am' as a note that is not applied", () => {
    const { value, issues } = scanDescription(
      "A tiny late-night wine bar. Open until 2am.",
      context,
    );
    expect(value).toEqual([]);
    expect(kinds(issues)).toEqual(["note_not_applied"]);
  });

  it("ignores prose that merely mentions a closed road", () => {
    const text = "Cycle the Via Appia Antica on a Sunday morning when the road is closed to cars.";
    expect(scanDescription(text, context)).toEqual({ value: [], issues: [] });
  });

  it("does not repeat a third-weekend rule the seasonal note already gave", () => {
    const existing = note("Third weekend of each month only.").value.dateRules;
    const text = "Third Saturday and Sunday of every month, the streets fill with stalls.";
    expect(scanDescription(text, { ...context, existingRules: existing })).toEqual({
      value: [],
      issues: [],
    });
  });

  it("adds a weekly closure found only in the description", () => {
    const { value, issues } = scanDescription("Closed on Tuesdays. Great views.", {
      placeId: "p",
      listedHours: null,
    });
    expect(value).toEqual([
      { kind: "weekdays", days: [0, 1, 3, 4, 5, 6], source: "Closed on Tuesdays" },
    ]);
    expect(kinds(issues)).toEqual(["date_restriction"]);
  });

  it("does nothing with a missing description", () => {
    expect(scanDescription(null, context)).toEqual({ value: [], issues: [] });
  });
});

describe("splitClauses", () => {
  it("splits on sentence ends and spaced dashes but keeps month ranges whole", () => {
    expect(
      splitClauses("Open April-October only. Best in September - bring water; go early."),
    ).toEqual(["Open April-October only", "Best in September", "bring water", "go early"]);
  });
});
