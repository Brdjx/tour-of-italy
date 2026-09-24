import { describe, expect, it } from "vitest";
import { dateRuleAllows, hoursOn, openStatusOn, weekdayOf } from "../src/time";
import type { DateRule, WeeklyHours } from "../src/types";
import { place, realResult } from "./helpers";

// The single answer to "is this place open on this date" (failure vectors F1 and F7). A wrong
// answer here sends a traveler to a closed door, so each case uses a real place and a real date.

describe("hoursOn and openStatusOn", () => {
  const museumHours: WeeklyHours = {
    0: [{ open: 540, close: 1140 }],
    1: [],
    2: [{ open: 540, close: 1140 }],
    3: [{ open: 540, close: 1140 }],
    4: [{ open: 540, close: 1140 }],
    5: [{ open: 540, close: 1140 }],
    6: [{ open: 540, close: 1140 }],
  };
  const season: DateRule = {
    kind: "season",
    window: { from: { month: 4, day: 1 }, to: { month: 10, day: 31 } },
    source: "Open April-October only",
  };

  it("never opens a Tues-Sun museum on its closed Monday", () => {
    expect(hoursOn({ hours: museumHours, dateRules: [] }, "2026-10-19")).toEqual([]);
    expect(openStatusOn({ hours: museumHours, dateRules: [] }, "2026-10-19")).toEqual({
      state: "closed",
      reason: "weekly",
    });
  });

  it("keeps a place with unknown hours closed outside its season", () => {
    const unknownSeasonal = { hours: null, dateRules: [season] };
    expect(hoursOn(unknownSeasonal, "2027-01-15")).toEqual([]);
    expect(openStatusOn(unknownSeasonal, "2027-01-15")).toMatchObject({
      state: "closed",
      reason: "season",
    });
    expect(hoursOn(unknownSeasonal, "2026-06-15")).toBe("unknown");
  });

  it("reports a season closure before a weekly closure so the chip says why", () => {
    expect(openStatusOn({ hours: museumHours, dateRules: [season] }, "2027-01-18")).toMatchObject({
      reason: "season",
    });
  });

  it("returns copies so a caller cannot corrupt the place's hours", () => {
    const source = { hours: museumHours, dateRules: [] };
    const ranges = hoursOn(source, "2026-10-20");
    if (ranges === "unknown") throw new Error("expected ranges");
    (ranges[0] as { open: number }).open = 0;
    expect(museumHours[2][0]?.open).toBe(540);
  });

  it.each([
    ["2026-10-17", [{ open: 540, close: 1140 }]], // third Saturday
    ["2026-10-18", [{ open: 540, close: 1140 }]], // third Sunday
    ["2026-11-21", [{ open: 540, close: 1140 }]], // third Saturday, day 21
    ["2026-10-10", []], // second Saturday
    ["2026-10-24", []], // fourth Saturday
    ["2026-10-19", []], // Monday inside the window
    ["2026-11-15", [{ open: 540, close: 1140 }]], // Sunday the 15th
  ])("opens the Brera antique market only on the third weekend (%s)", (date, expected) => {
    expect(hoursOn(place("place_059"), date)).toEqual(expected);
  });

  it("opens Fondazione Prada Wed to Mon, wrapping past Sunday, and closes it on Tuesday", () => {
    const prada = place("place_062");
    expect(hoursOn(prada, "2026-10-19")).toEqual([{ open: 600, close: 1140 }]); // Monday
    expect(hoursOn(prada, "2026-10-18")).toEqual([{ open: 600, close: 1140 }]); // Sunday
    expect(hoursOn(prada, "2026-10-20")).toEqual([]); // Tuesday
  });

  it("keeps a past-midnight close as 1500 on the same day for Il Sorpasso", () => {
    expect(hoursOn(place("place_020"), "2026-10-20")).toEqual([{ open: 480, close: 1500 }]);
  });

  it.each(["2026-03-29", "2026-10-25", "2028-02-29"])(
    "answers the same on DST and leap days (%s)",
    (date) => {
      expect(hoursOn(place("place_001"), date)).toEqual([{ open: 540, close: 1140 }]);
      const brera =
        weekdayOf(date) === 0 && Number(date.slice(8)) >= 15 && Number(date.slice(8)) <= 21;
      expect(hoursOn(place("place_059"), date)).toEqual(brera ? [{ open: 540, close: 1140 }] : []);
    },
  );
});

describe("bad dates", () => {
  it.each(["2026-02-30", "not-a-date", "2026-13-01", ""])(
    "throws the same RangeError for %j on every place, never a silent unknown",
    (date) => {
      for (const p of realResult().places) {
        expect(() => hoursOn(p, date), p.id).toThrow(RangeError);
      }
    },
  );
});

describe("day-of-month rules counted from the end of the month", () => {
  const lastWeek: DateRule = { kind: "day_of_month", from: -7, to: -1, source: "last" };

  it.each([
    ["2026-04-23", false],
    ["2026-04-24", true],
    ["2026-04-30", true],
    ["2026-02-21", false],
    ["2026-02-22", true],
    ["2028-02-23", true],
    ["2028-02-22", false],
    ["2026-12-31", true],
  ])("treats %s as in the last seven days: %s", (date, expected) => {
    expect(dateRuleAllows(lastWeek, date)).toBe(expected);
  });
});
