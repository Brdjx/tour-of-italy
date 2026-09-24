import { describe, expect, it } from "vitest";
import {
  dateText,
  listText,
  noteText,
  priceText,
  rangesText,
  weekdayPlural,
} from "../../src/validate/text";

// Violation details are read by travelers and fed back to the model in repair turns, so the
// small text helpers must never throw, never print raw minute counts, and never run long.

describe("violation text helpers", () => {
  it("writes dates the way a traveler reads them, and never throws on a bad one", () => {
    expect(dateText("2028-02-29")).toBe("Tue 29 Feb 2028");
    expect(dateText("2026-12-31")).toBe("Thu 31 Dec 2026");
    expect(dateText("2026-02-30")).toBe("an invalid date");
  });

  it("names the weekday a place is closed on", () => {
    expect(weekdayPlural("2026-10-19")).toBe("Mondays");
    expect(weekdayPlural("2026-10-25")).toBe("Sundays");
  });

  it("joins lists in plain English, including empty and single lists", () => {
    expect(listText([])).toBe("");
    expect(listText(["Rome"])).toBe("Rome");
    expect(listText(["Rome", "Venice", "Florence"])).toBe("Rome, Venice and Florence");
  });

  it("shows split and past-midnight hours as clock times", () => {
    const ranges = [
      { open: 750, close: 870 },
      { open: 1170, close: 1500 },
    ];
    expect(rangesText(ranges)).toBe("12:30 to 14:30 and 19:30 to 01:00");
  });

  it("shows price levels as euro signs", () => {
    expect(priceText(1)).toBe("€");
    expect(priceText(4)).toBe("€€€€");
  });

  it("quotes a data note in brackets, cut short when it is long, and nothing when empty", () => {
    expect(noteText(undefined)).toBe("");
    expect(noteText("  ")).toBe("");
    expect(noteText("Open April-October only")).toBe(" (Open April-October only)");
    const long = noteText("x".repeat(400));
    expect(long.length).toBeLessThanOrEqual(123);
    expect(long.endsWith("...)")).toBe(true);
  });
});
