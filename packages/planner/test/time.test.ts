import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TRIP_DAYS } from "../src/config";
import {
  addDays,
  formatClock,
  inSeason,
  isValidIsoDate,
  parseClock,
  tripDates,
  weekdayOf,
} from "../src/time";
import type { SeasonWindow } from "../src/types";

// Failure vector F7: date and time bugs. A wrong weekday or season puts a traveler at a closed
// door. Every expectation here is independent of the machine's time zone; CI runs this file under
// TZ=UTC, Pacific/Kiritimati (UTC+14), and America/Los_Angeles.

/** Weekday by Zeller's congruence: a reference that uses no Date at all. */
function referenceWeekday(year: number, month: number, day: number): number {
  const m = month < 3 ? month + 12 : month;
  const y = month < 3 ? year - 1 : year;
  const h =
    (day +
      Math.floor((13 * (m + 1)) / 5) +
      y +
      Math.floor(y / 4) -
      Math.floor(y / 100) +
      Math.floor(y / 400)) %
    7;
  return (h + 6) % 7; // Zeller counts 0 = Saturday; shift to 0 = Sunday
}

const isoDate = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

describe("parseClock", () => {
  it.each([
    ["9:30", 570],
    ["09:30", 570],
    ["9.30", 570],
    ["9", 540],
    ["0:00", 0],
    ["24:00", 1440],
    ["9am", 540],
    ["12:30pm", 750],
    ["12am", 0],
    ["12pm", 720],
    ["11:59pm", 1439],
    [" 7pm ", 1140],
    ["8 AM", 480],
  ])("reads %j as %i minutes so listed hours are not shifted", (text, minutes) => {
    expect(parseClock(text)).toBe(minutes);
  });

  it.each(["25:00", "24:30", "9:60", "13pm", "0am", "", "abc", "9:5", "-1:00", "9::00", "1234"])(
    "rejects %j instead of inventing a time",
    (text) => {
      expect(parseClock(text)).toBeNull();
    },
  );
});

describe("formatClock", () => {
  it.each([
    [0, "00:00"],
    [570, "09:30"],
    [1439, "23:59"],
    [1440, "24:00"],
    [1500, "01:00"],
  ])("formats %i as %s so the timetable shows the right time", (minutes, text) => {
    expect(formatClock(minutes)).toBe(text);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws for %s instead of printing garbage",
    (minutes) => {
      expect(() => formatClock(minutes)).toThrow(RangeError);
    },
  );

  it("round-trips every minute of the day through parseClock", () => {
    for (let minute = 0; minute <= 1440; minute++)
      expect(parseClock(formatClock(minute))).toBe(minute);
  });
});

describe("calendar dates", () => {
  it.each(["2028-02-29", "2026-12-31", "2027-01-01", "2026-03-29", "2026-10-25", "1000-01-01"])(
    "accepts the real date %s",
    (date) => {
      expect(isValidIsoDate(date)).toBe(true);
    },
  );

  it.each([
    "2027-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "26-04-01",
    "2026-4-1",
    "0099-01-01",
    "2026-04-01T00:00:00Z",
    "",
  ])("rejects %j so a bad date never reaches the scheduler", (date) => {
    expect(isValidIsoDate(date)).toBe(false);
    expect(() => weekdayOf(date)).toThrow(RangeError);
  });

  it.each([
    ["2028-02-29", 2], // leap day, Tuesday
    ["2026-12-31", 4], // Thursday
    ["2027-01-01", 5], // Friday
    ["2026-03-29", 0], // Italian DST starts, Sunday
    ["2026-10-25", 0], // Italian DST ends, Sunday
    ["2026-10-17", 6], // Saturday
  ])("knows %s is weekday %i in every time zone", (date, weekday) => {
    expect(weekdayOf(date)).toBe(weekday);
  });

  it("agrees with a Date-free reference for any date from 1900 to 2200", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1900, max: 2200 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (year, month, day) => {
          expect(weekdayOf(isoDate(year, month, day))).toBe(referenceWeekday(year, month, day));
        },
      ),
      { numRuns: 500, seed: 20261017 },
    );
  });

  it.each([
    ["2028-02-28", 1, "2028-02-29"],
    ["2028-02-29", 1, "2028-03-01"],
    ["2027-02-28", 1, "2027-03-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2027-01-01", -1, "2026-12-31"],
    ["2026-03-28", 2, "2026-03-30"],
    ["2026-10-24", 2, "2026-10-26"],
    ["2026-01-31", 400, "2027-03-07"],
  ])("adds days across month, year, leap, and DST boundaries (%s + %i)", (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it("refuses fractional day offsets instead of rounding silently", () => {
    expect(() => addDays("2026-10-01", 0.5)).toThrow(RangeError);
  });

  it("never skips or repeats a date when a trip crosses New Year", () => {
    expect(tripDates("2026-12-30", 3)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
    expect(tripDates("2026-03-28", 3).map(weekdayOf)).toEqual([6, 0, 1]);
    expect(tripDates("2026-12-30")).toHaveLength(TRIP_DAYS);
  });
});

describe("inSeason", () => {
  const winter: SeasonWindow = { from: { month: 11, day: 1 }, to: { month: 3, day: 31 } };
  const summer: SeasonWindow = { from: { month: 4, day: 1 }, to: { month: 10, day: 31 } };

  it.each(["2027-01-10", "2026-12-31", "2027-01-01", "2028-02-29", "2026-11-01", "2027-03-31"])(
    "includes %s in a Nov to Mar window that wraps the year",
    (date) => {
      expect(inSeason(date, winter)).toBe(true);
    },
  );

  it.each(["2026-06-01", "2026-04-01", "2026-10-31"])(
    "excludes %s from a Nov to Mar window",
    (date) => {
      expect(inSeason(date, winter)).toBe(false);
    },
  );

  it.each([
    ["2026-03-31", false],
    ["2026-04-01", true],
    ["2026-10-25", true],
    ["2026-10-31", true],
    ["2026-11-01", false],
  ])("treats Apr to Oct edges inclusively (%s open: %s)", (date, open) => {
    expect(inSeason(date, summer)).toBe(open);
  });
});
