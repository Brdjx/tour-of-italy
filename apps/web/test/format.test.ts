import { describe, expect, it } from "vitest";
import {
  calendarDate,
  clockDateTime,
  formatClock,
  formatDuration,
  longDate,
  placeSubtitle,
  placeWhere,
  plural,
  priceLabel,
  priceSymbols,
  ratingText,
  shortDate,
  shortDayOfTimestamp,
  transferText,
  travelText,
  typeWord,
} from "../lib/format";

// Formatting runs inside render, so a throw here would blank the whole plan. Every function
// must be total, and times must read right around midnight.

describe("times", () => {
  it("formats minutes as a 24-hour clock, wrapping past midnight", () => {
    expect(formatClock(570)).toBe("09:30");
    expect(formatClock(1440)).toBe("24:00");
    expect(formatClock(1500)).toBe("01:00");
  });

  it("shows a placeholder instead of throwing on impossible minutes", () => {
    expect(formatClock(-5)).toBe("--:--");
    expect(formatClock(Number.NaN)).toBe("--:--");
  });

  it("moves a <time> past midnight onto the next date, across a year end", () => {
    expect(clockDateTime("2026-10-06", 570)).toBe("2026-10-06T09:30");
    expect(clockDateTime("2026-12-31", 1500)).toBe("2027-01-01T01:00");
    expect(clockDateTime("2026-12-31", 1440)).toBe("2027-01-01T00:00");
    expect(clockDateTime("not-a-date", 570)).toBe("not-a-date");
    expect(clockDateTime("2026-10-06", Number.NaN)).toBe("2026-10-06");
  });

  it("formats durations and ignores nonsense", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(75)).toBe("1 h 15 min");
    expect(formatDuration(-1)).toBe("");
  });
});

describe("dates", () => {
  it("names the weekday without depending on the browser's time zone", () => {
    expect(shortDate("2026-10-06")).toBe("Tue 6 Oct");
    expect(longDate("2026-10-06")).toBe("Tuesday 6 October");
    expect(longDate("2028-02-29")).toBe("Tuesday 29 February");
    expect(shortDate("2026-02-30")).toBe("2026-02-30");
    expect(longDate("garbage")).toBe("garbage");
    expect(calendarDate("2026-09-25")).toBe("25 September 2026");
    expect(calendarDate("garbage")).toBe("garbage");
  });

  it("names a saved day on the reader's calendar, with its year only when it is not this one", () => {
    const now = new Date(2026, 8, 25, 12);
    expect(shortDayOfTimestamp(new Date(2026, 8, 20, 23, 30).toISOString(), now)).toBe("20 Sep");
    expect(shortDayOfTimestamp(new Date(2025, 11, 31, 9).toISOString(), now)).toBe("31 Dec 2025");
    expect(shortDayOfTimestamp("garbage", now)).toBe("");
  });
});

describe("places", () => {
  it("writes price levels as symbols with a spoken label", () => {
    expect(priceSymbols(3)).toBe("€€€");
    expect(priceSymbols(null)).toBe("");
    expect(priceLabel(1)).toBe("Inexpensive, price level 1 of 4");
    expect(priceLabel(null)).toBe("Price unknown");
  });

  it("shows ratings with one decimal and hides missing ones", () => {
    expect(ratingText(4)).toBe("4.0");
    expect(ratingText(4.75)).toBe("4.8");
    expect(ratingText(null)).toBeNull();
    expect(ratingText(Number.NaN)).toBeNull();
  });

  it("falls back to the city when the neighborhood is unknown", () => {
    expect(placeSubtitle({ type: "historic_site", neighborhood: "Monti", city: "Rome" })).toBe(
      "Historic site in Monti",
    );
    expect(placeSubtitle({ type: "museum", neighborhood: null, city: "Florence" })).toBe(
      "Museum in Florence",
    );
    expect(typeWord("other")).toBe("Place");
  });

  it("names the city too outside a plan, once, and never an empty neighbourhood", () => {
    expect(placeWhere({ type: "historic_site", neighborhood: "Celio", city: "Rome" })).toBe(
      "Historic site in Celio, Rome",
    );
    expect(placeWhere({ type: "museum", neighborhood: null, city: "Florence" })).toBe(
      "Museum in Florence",
    );
    expect(placeWhere({ type: "cafe", neighborhood: " ", city: "Milan" })).toBe("Cafe in Milan");
    expect(placeWhere({ type: "market", neighborhood: "venice", city: "Venice" })).toBe(
      "Market in Venice",
    );
    // A type the data never had still reads as a place.
    expect(placeWhere({ type: "nope" as "other", neighborhood: null, city: "Rome" })).toBe(
      "Place in Rome",
    );
  });

  it("labels travel legs and transfers the same way as the planner", () => {
    expect(travelText(12, "walk")).toBe("12 min walk");
    expect(travelText(0, "walk")).toBe("Same spot, no travel");
    expect(travelText(-3, "walk")).toBe("");
    expect(transferText(100, "intercity", "Rome")).toBe("1 h 40 min by high-speed train from Rome");
    expect(transferText(0, "local", "Rome")).toBe("");
    expect(plural(1, "stop", "stops")).toBe("1 stop");
    expect(plural(3, "stop", "stops")).toBe("3 stops");
  });
});
