import { describe, expect, it } from "vitest";
import { DETAIL_MAX_CHARS, ID_MAX_CHARS } from "../src/config";
import { type ScheduledDay, scheduleDay } from "../src/schedule";
import { ViolationSchema } from "../src/schemas";
import type { TripRequest, ViolationCode } from "../src/types";
import { makeViolation } from "../src/violations";
import { makeRequest, realContext } from "./plannerFixtures";

// scheduleDay must report every infeasible stop with the exact code, and still time it so the
// UI can show where the problem is. A missing report is how an invalid AI pick or a bad edit
// would slip through, so each code has a test built from real places and real dates.

const ctx = realContext();
const MONDAY = "2026-10-19";
const TUESDAY = "2026-10-20";
const JANUARY_TUESDAY = "2027-01-12";

function run(
  ids: string[],
  base: string,
  date = TUESDAY,
  overrides: Partial<TripRequest> = {},
): ScheduledDay {
  const anchor = ctx.anchorById.get(base);
  if (!anchor) throw new Error(`no base ${base}`);
  return scheduleDay(ids, date, anchor, makeRequest(overrides), ctx, 0);
}

function codesAt(day: ScheduledDay, stopIndex: number): ViolationCode[] {
  return day.violations.filter((v) => v.stopIndex === stopIndex).map((v) => v.code);
}

function severityOf(day: ScheduledDay, code: ViolationCode) {
  return day.violations.find((v) => v.code === code)?.severity;
}

describe("errors for stops that cannot happen", () => {
  it("never schedules the Borghese Gallery on its closed Monday without CLOSED_AT_TIME", () => {
    const day = run(["place_007"], "rome", MONDAY);
    expect(codesAt(day, 0)).toEqual(["CLOSED_AT_TIME"]);
    expect(day.stops).toHaveLength(1);
  });

  it("never lets Villa del Balbianello pass in January: SEASONAL_CLOSED", () => {
    expect(codesAt(run(["place_064"], "milan", JANUARY_TUESDAY), 0)).toEqual(["SEASONAL_CLOSED"]);
  });

  it("never lets the weekend-only Brera market pass on a Tuesday: SEASONAL_CLOSED", () => {
    expect(codesAt(run(["place_059"], "milan"), 0)).toEqual(["SEASONAL_CLOSED"]);
  });

  it("never lets a Rome place into a Florence day: OUTSIDE_ANCHOR", () => {
    expect(codesAt(run(["place_001"], "florence"), 0)).toContain("OUTSIDE_ANCHOR");
  });

  it("never schedules a place the traveler excluded without EXCLUDED_PLACE", () => {
    const day = run(["place_005"], "rome", TUESDAY, { exclude: ["place_005"] });
    expect(codesAt(day, 0)).toEqual(["EXCLUDED_PLACE"]);
  });

  it("never lets the same place appear twice in a day: DUPLICATE_PLACE on the second", () => {
    const day = run(["place_005", "place_005"], "rome");
    expect(codesAt(day, 0)).toEqual([]);
    expect(codesAt(day, 1)).toEqual(["DUPLICATE_PLACE"]);
  });

  it("reports an invented id as UNKNOWN_PLACE and still times the real stops after it", () => {
    const day = run(["place_999", "place_005"], "rome");
    expect(day.violations[0]).toMatchObject({ code: "UNKNOWN_PLACE", placeId: "place_999" });
    expect(day.stops.map((stop) => stop.placeId)).toEqual(["place_005"]);
    expect(codesAt(day, 0)).toEqual([]);
  });

  it("flags the fourth visit of a relaxed day as TOO_MANY_VISITS, at that stop", () => {
    const ids = ["place_008", "place_014", "place_018", "place_019"];
    const day = run(ids, "rome", TUESDAY, { pace: "relaxed" });
    expect(codesAt(day, 3)).toEqual(["TOO_MANY_VISITS"]);
    expect(severityOf(day, "TOO_MANY_VISITS")).toBe("error");
  });

  it("reports an empty day as EMPTY_DAY only, without meal noise", () => {
    expect(run([], "rome").violations.map((v) => v.code)).toEqual(["EMPTY_DAY"]);
  });

  it("reports a visit that cannot fit before closing as CLOSED_AT_TIME, not as open", () => {
    // Bargello closes at 13:50; three long visits first push it past closing.
    const day = run(["place_026", "place_028", "place_101"], "florence");
    expect(codesAt(day, 2)).toContain("CLOSED_AT_TIME");
  });
});

describe("warnings the traveler should see", () => {
  it("warns HOURS_UNKNOWN for the Appian Way bike ride, never an error", () => {
    const day = run(["place_021"], "rome");
    expect(codesAt(day, 0)).toEqual(["HOURS_UNKNOWN"]);
    expect(severityOf(day, "HOURS_UNKNOWN")).toBe("warning");
  });

  it("warns OVER_BUDGET and LOW_RATING for Hard Rock Cafe on a budget of 1", () => {
    const day = run(["place_005", "place_008", "place_025"], "rome", TUESDAY, { maxPriceLevel: 1 });
    expect(codesAt(day, 2)).toEqual(["OVER_BUDGET", "LOW_RATING"]);
    expect(severityOf(day, "OVER_BUDGET")).toBe("warning");
  });

  it("warns SAME_LOCATION for Trevi Fountain by day and by night in one day", () => {
    const day = run(["place_018", "place_077"], "rome");
    expect(codesAt(day, 1)).toContain("SAME_LOCATION");
    expect(severityOf(day, "SAME_LOCATION")).toBe("warning");
  });

  it("warns MEAL_MISSING once for lunch and once for dinner on a day of visits only", () => {
    const missing = run(["place_005"], "rome").violations.filter((v) => v.code === "MEAL_MISSING");
    expect(missing.map((v) => v.detail)).toEqual([
      "No lunch stop on this day.",
      "No dinner stop on this day.",
    ]);
  });
});

describe("violation records", () => {
  it("keeps keys in a fixed order and omits missing targets, so JSON is stable", () => {
    const violation = makeViolation("EMPTY_DAY", "This day has no stops.", { day: 1 });
    expect(JSON.stringify(violation)).toBe(
      '{"code":"EMPTY_DAY","severity":"error","day":1,"detail":"This day has no stops."}',
    );
  });

  it("cuts an absurdly long unknown id to 64 characters so the response schema never rejects it", () => {
    const violation = makeViolation("UNKNOWN_PLACE", "x", { placeId: "p".repeat(500) });
    expect(violation.placeId).toHaveLength(ID_MAX_CHARS);
  });

  it("never lets a scheduler detail outgrow the response schema's 500 characters", () => {
    const violation = makeViolation("UNKNOWN_PLACE", "d".repeat(900));
    expect(violation.detail.length).toBeLessThanOrEqual(DETAIL_MAX_CHARS);
    expect(ViolationSchema.safeParse(violation).success).toBe(true);
  });

  it("writes closure details in plain words with the weekday and date, never an em dash", () => {
    const details = run(["place_007"], "rome", MONDAY).violations.map((v) => v.detail);
    for (const detail of details) expect(detail).not.toMatch(/\u2014/);
    expect(details[0]).toBe("Borghese Gallery is closed on Mon 2026-10-19.");
  });
});
