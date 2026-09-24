import { describe, expect, it } from "vitest";
import { MEALS, PACE, TRAVEL } from "../src/config";
import {
  inferRole,
  lastStopStep,
  type ScheduledDay,
  scheduleDay,
  startCursor,
  timeStep,
} from "../src/schedule";
import { travelMinutes } from "../src/travel";
import type { TripRequest } from "../src/types";
import { makeRequest, realContext, realPlace } from "./plannerFixtures";

// scheduleDay is the one clock of the app: the planner, the AI path, swap alternatives, edits,
// and shared links all time a day through it. These tests pin how it times meals, transfers,
// opening hours, and evening places, on real places and real dates.

const ctx = realContext();
const TUESDAY = "2026-10-20";
const SUNDAY = "2026-10-25";

function anchor(id: string) {
  const found = ctx.anchorById.get(id);
  if (!found) throw new Error(`no base ${id}`);
  return found;
}

function schedule(
  ids: string[],
  base: string,
  date = TUESDAY,
  overrides: Partial<TripRequest> = {},
  transferMin = 0,
): ScheduledDay {
  return scheduleDay(ids, date, anchor(base), makeRequest(overrides), ctx, transferMin);
}

const errors = (day: ScheduledDay) => day.violations.filter((v) => v.severity === "error");
const roles = (day: ScheduledDay) => day.stops.map((stop) => stop.role);
const starts = (day: ScheduledDay) => day.stops.map((stop) => stop.start);

describe("meal placement", () => {
  it("seats lunch when Da Enzo opens at 12:30, never on arrival before it opens", () => {
    const day = schedule(["place_001", "place_003"], "rome");
    expect(roles(day)).toEqual(["visit", "lunch"]);
    expect(day.stops[1]?.start).toBe(750);
    expect(errors(day)).toEqual([]);
  });

  it("never seats lunch before 12:00, even at a restaurant open since 08:00", () => {
    const day = schedule(["place_005", "place_008", "place_020"], "rome");
    const arrive =
      (day.stops[1]?.end ?? 0) + TRAVEL.bufferMin + (day.stops[2]?.travelFromPrevMin ?? 0);
    expect(arrive).toBeLessThan(MEALS.lunch.earliestStart);
    expect(day.stops[2]).toMatchObject({ role: "lunch", start: MEALS.lunch.earliestStart });
  });

  it("turns a restaurant reached after the lunch window into dinner at its evening opening", () => {
    const day = schedule(["place_010", "place_001", "place_003"], "rome");
    expect(day.stops[2]).toMatchObject({ role: "dinner", start: 1170 });
    expect(errors(day)).toEqual([]);
  });

  it("treats a market reached mid-morning, after a sight, as a visit, not a lunch hours later", () => {
    const day = schedule(["place_005", "place_015"], "rome"); // Pantheon, then Mercato Testaccio
    expect(day.stops[1]?.role).toBe("visit");
    expect(day.stops[1]?.start).toBeLessThan(MEALS.lunch.earliestStart - 60);
  });

  it("never makes a meal place the day's first sightseeing visit: the traveler leaves for its meal", () => {
    // The review's repro: a restaurant asked for was "visited" at 09:35 and lunch was eaten at
    // another restaurant. As the first stop, it is lunch; the traveler leaves the base later.
    const day = schedule(["place_015", "place_005"], "rome");
    expect(day.stops[0]).toMatchObject({ role: "lunch", start: MEALS.lunch.earliestStart });
    expect(errors(day)).toEqual([]);
  });

  it("keeps a meal place that serves only dinner waiting for dinner, not a morning visit", () => {
    const day = schedule(["place_036", "place_037"], "florence");
    expect(day.stops[1]).toMatchObject({ role: "dinner", start: MEALS.dinner.earliestStart });
  });

  it("never seats a second lunch: a restaurant reached after lunch waits for its dinner service", () => {
    const day = schedule(["place_005", "place_008", "place_020", "place_003"], "rome");
    expect(roles(day)).toEqual(["visit", "visit", "lunch", "dinner"]);
    expect(day.stops[3]?.start).toBe(1170);
  });

  it("calls a restaurant still open after lunch a visit when a stop follows, not a dinner hours away", () => {
    const ids = ["place_005", "place_008", "place_020", "place_022", "place_002"];
    const day = schedule(ids, "rome");
    expect(roles(day)).toEqual(["visit", "visit", "lunch", "visit", "visit"]);
  });

  it("never leaves a restaurant open all afternoon as a visit when it ends the day: it waits for dinner", () => {
    // Review finding: a day that ended at 15:15 could not gain Il Sorpasso as its dinner, because
    // any order with it last timed it as a 15:40 visit. The traveler goes back, then out at 19:00.
    const day = schedule(["place_005", "place_008", "place_020", "place_022"], "rome");
    expect(roles(day)).toEqual(["visit", "visit", "lunch", "dinner"]);
    expect(day.stops[3]?.start).toBe(1170); // Roscioli's dinner service opens at 19:30
    expect(errors(day)).toEqual([]);
    const late = schedule(["place_001", "place_013", "place_020"], "rome"); // Il Sorpasso last
    expect(late.stops[2]).toMatchObject({ role: "dinner", start: MEALS.dinner.earliestStart });
    expect(errors(late)).toEqual([]);
  });

  it("keeps a meal place that ends the day before noon a morning visit, not a dinner nine hours later", () => {
    const day = schedule(["place_005", "place_099"], "rome"); // Pantheon, then Eataly at 10:40
    expect(day.stops[1]?.role).toBe("visit");
    expect(day.stops[1]?.start).toBeLessThan(MEALS.lunch.earliestStart);
  });

  it("never makes a last stop a dinner when dinner is taken or the trip back would be too late", () => {
    const afterDinner = schedule(["place_003", "place_001", "place_009", "place_020"], "rome");
    expect(roles(afterDinner)).toEqual(["lunch", "visit", "dinner", "visit"]);
    const place = realPlace("place_020"); // Il Sorpasso: a 90-minute dinner from 19:00
    const centroid = anchor("rome").centroid;
    const origin = { lat: centroid.lat + 0.12, lng: centroid.lng }; // a hotel far out of town
    const cursor = { ...startCursor(anchor("rome"), "balanced", 0), clock: 900, first: false };
    const step = timeStep(place, TUESDAY, cursor);
    expect(step.role).toBe("visit");
    const back = travelMinutes(place, origin);
    expect(back).toBeGreaterThan(30);
    const fits = { start: 570, end: 1140 + 90 + back - 30 }; // home 30 minutes after the end
    expect(lastStopStep(place, TUESDAY, cursor, step, fits, origin).role).toBe("dinner");
    const tooLate = { start: 570, end: fits.end - 5 };
    expect(lastStopStep(place, TUESDAY, cursor, step, tooLate, origin).role).toBe("visit");
  });

  it("does not count meals toward a relaxed day's three visits", () => {
    const day = schedule(["place_002", "place_080", "place_013", "place_003"], "rome", TUESDAY, {
      pace: "relaxed",
    });
    expect(roles(day)).toEqual(["visit", "visit", "visit", "dinner"]);
    expect(errors(day)).toEqual([]);
  });
});

describe("transfers and the day window", () => {
  it("deducts the transfer from the start of the day and adds travel from the base centroid", () => {
    const day = schedule(["place_008"], "rome", TUESDAY, {}, 130);
    const travel = travelMinutes(anchor("rome").centroid, realPlace("place_008"));
    expect(day.stops[0]).toMatchObject({ start: PACE.balanced.dayStart + 130 + travel });
    expect(day.stops[0]?.travelFromPrevMin).toBe(travel);
  });

  it("puts no buffer before the first stop and one buffer before every later stop", () => {
    const day = schedule(["place_005", "place_008"], "rome");
    const [first, second] = day.stops;
    expect(first?.start).toBe(PACE.balanced.dayStart + (first?.travelFromPrevMin ?? 0));
    expect(second?.start).toBe(
      (first?.end ?? 0) + (second?.travelFromPrevMin ?? 0) + TRAVEL.bufferMin,
    );
  });

  it("warns LONG_TRANSFER only above 180 minutes, never at exactly 180", () => {
    const codes = (transfer: number) =>
      schedule(["place_008"], "rome", TUESDAY, {}, transfer).violations.map((v) => v.code);
    expect(codes(180)).not.toContain("LONG_TRANSFER");
    expect(codes(215)).toContain("LONG_TRANSFER");
  });

  it("reports OUTSIDE_DAY_WINDOW when a transfer eats the whole day, and still times the stop", () => {
    const day = schedule(["place_008"], "rome", TUESDAY, {}, 900);
    expect(errors(day).map((v) => v.code)).toContain("OUTSIDE_DAY_WINDOW");
    expect(day.stops).toHaveLength(1);
  });

  it("rejects a relaxed dinner that starts in the window but would end after 22:00", () => {
    const day = schedule(["place_077", "place_003"], "rome", TUESDAY, { pace: "relaxed" });
    const dinner = day.stops[1];
    expect(dinner?.role).toBe("dinner");
    expect(dinner?.start).toBeLessThanOrEqual(MEALS.dinner.latestStart);
    expect(dinner?.end).toBeGreaterThan(PACE.relaxed.dayEnd);
    expect(errors(day)).toEqual([
      expect.objectContaining({ code: "OUTSIDE_DAY_WINDOW", stopIndex: 1 }),
    ]);
  });
});

describe("waiting for opening time", () => {
  it("waits for Santa Croce's 14:00 Sunday opening instead of starting at 09:30", () => {
    expect(starts(schedule(["place_036"], "florence", SUNDAY))).toEqual([840]);
  });

  it("moves Sant'Ambrogio to its 14:30 reopening when the morning range is too short", () => {
    const day = schedule(["place_055", "place_098"], "milan");
    expect(day.stops[1]?.start).toBe(870);
    expect(errors(day)).toEqual([]);
  });

  it("holds Trevi Fountain by Night until 20:00 even as the first stop of the day", () => {
    expect(starts(schedule(["place_077"], "rome"))).toEqual([1200]);
  });
});

describe("role inference", () => {
  const cursor = startCursor(anchor("rome"), "balanced", 0);

  it("never gives a non-meal place a meal role, even at noon", () => {
    expect(inferRole(realPlace("place_001"), TUESDAY, 720, [])).toBe("visit");
  });

  it("never seats a meal already taken today", () => {
    expect(inferRole(realPlace("place_020"), TUESDAY, 720, ["lunch"])).toBe("visit");
    expect(inferRole(realPlace("place_003"), TUESDAY, 900, ["lunch"])).toBe("dinner");
    expect(inferRole(realPlace("place_003"), TUESDAY, 900, ["lunch", "dinner"])).toBe("visit");
  });

  it("times the same place identically however often it is asked (pure)", () => {
    const place = realPlace("place_003");
    expect(timeStep(place, TUESDAY, cursor)).toEqual(timeStep(place, TUESDAY, cursor));
  });
});

describe("determinism and input safety", () => {
  it("returns identical JSON for identical input and never mutates the id list", () => {
    const ids = Object.freeze(["place_001", "place_003", "place_005", "place_022"]);
    const first = scheduleDay(ids, TUESDAY, anchor("rome"), makeRequest(), ctx, 0);
    const second = scheduleDay(ids, TUESDAY, anchor("rome"), makeRequest(), ctx, 0);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("throws RangeError on an impossible date or a negative transfer, never a silent plan", () => {
    expect(() => schedule(["place_001"], "rome", "2026-02-30")).toThrow(RangeError);
    expect(() => schedule(["place_001"], "rome", TUESDAY, {}, -5)).toThrow(RangeError);
  });

  it("copies the day index into every violation so the UI can point at the right day", () => {
    const day = scheduleDay(["place_007"], "2026-10-19", anchor("rome"), makeRequest(), ctx, 0, {
      dayIndex: 2,
    });
    expect(day.violations.length).toBeGreaterThan(0);
    expect(day.violations.every((v) => v.day === 2)).toBe(true);
  });
});
