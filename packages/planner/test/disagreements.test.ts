import { describe, expect, it } from "vitest";
import { removeStop, rescheduleDay } from "../src/alternatives";
import { LATEST_MINUTE, TRIP_DAYS } from "../src/config";
import { compareViolations, planDeterministic } from "../src/plan";
import { scheduleDay } from "../src/schedule";
import { makeViolation } from "../src/scheduleChecks";
import { tripDates } from "../src/time";
import { scheduleTrip } from "../src/trip";
import { buildTrip } from "../src/tripBuilder";
import type { Itinerary, TripRequest, Violation } from "../src/types";
import { VIOLATION_CODES } from "../src/types";
import { VIOLATION_SEVERITY, validateItinerary } from "../src/validate";
import { makeRequest, realContext } from "./plannerFixtures";

// Regression tests for each place the T17 property tests (test/properties) found the scheduler
// and the validator disagreeing. Each describe names the disagreement; the report lists them.

const ctx = realContext();

const errorsOf = (violations: readonly Violation[]) =>
  violations.filter((v) => v.severity === "error");

function asItinerary(request: TripRequest, days: Itinerary["days"]): Itinerary {
  const meta = { attempts: 0, latencyMs: 0, generatedAt: "1970-01-01T00:00:00.000Z" };
  return { request, days, source: "deterministic", warnings: [], meta };
}

describe("disagreement 1: a stop pushed past 06:00 the next morning", () => {
  // Three Tuscan day trips in a row on a packed Tuesday: Pienza would run 01:45 to 07:45.
  const request = makeRequest({ pace: "packed", startDate: "2026-10-20" });
  const ids = ["place_035", "place_038", "place_089"];

  it("never lets scheduleDay call it closed while the validator calls it INVALID_TIME", () => {
    const florence = ctx.anchorById.get("florence");
    if (!florence) throw new Error("no Florence base");
    const day = scheduleDay(ids, request.startDate, florence, request, ctx, 0, { dayIndex: 0 });
    expect(day.stops[2]?.end).toBeGreaterThan(LATEST_MINUTE);
    const trip = scheduleTrip(request, [{ anchorId: "florence", placeIds: ids }], ctx);
    const validated = validateItinerary(asItinerary(request, trip.days), ctx);
    const key = (v: Violation) => `${v.code}@${v.stopIndex ?? "day"}`;
    const onDay = errorsOf(validated).filter((v) => v.day === 0);
    expect(errorsOf(day.violations).map(key).sort()).toEqual(onDay.map(key).sort());
    expect(errorsOf(day.violations).map(key)).toContain("INVALID_TIME@2");
  });
});

describe("disagreement 2: a day at a base the traveler did not choose", () => {
  it("never moves a day off a chosen base that fewer visits a day can still fill", () => {
    // Milan alone in January at a packed pace: the greedy walk at 7 visits a day ran dry on day
    // 3 and the plan moved that day to another base, silently. 618 of 5,490 single-base
    // requests over 2027 did this.
    const request = makeRequest({ anchors: ["milan"], pace: "packed", startDate: "2027-01-01" });
    const dates = tripDates(request.startDate);
    expect(buildTrip(Array(TRIP_DAYS).fill("milan"), request, ctx, dates)).toBeNull();
    const itinerary = planDeterministic(request, ctx);
    expect(itinerary.days.map((day) => day.anchorId)).toEqual(Array(TRIP_DAYS).fill("milan"));
    expect(errorsOf(validateItinerary(itinerary, ctx))).toEqual([]);
  });

  it("never leaves a starved chosen base without an ANCHOR_NOT_CHOSEN warning on each day", () => {
    // Nine Venice exclusions and budget 1 in January leave Venice one day's worth of places.
    const exclude = ["place_096", "place_078", "place_066", "place_074", "place_068"];
    exclude.push("place_072", "place_088", "place_067", "place_070");
    const request = makeRequest({
      startDate: "2026-01-02",
      maxPriceLevel: 1,
      anchors: ["venice"],
      exclude,
    });
    const itinerary = planDeterministic(request, ctx);
    expect(errorsOf(validateItinerary(itinerary, ctx))).toEqual([]);
    const offDays = itinerary.days.flatMap((day, i) => (day.anchorId === "venice" ? [] : [i]));
    expect(offDays.length).toBeGreaterThan(0);
    const warned = itinerary.warnings.filter((w) => w.code === "ANCHOR_NOT_CHOSEN");
    expect(warned.map((w) => w.day)).toEqual(offDays);
    expect(warned[0]?.detail).toContain("not one of the bases you chose (Venice)");
    // An edit on that day keeps the note: scheduleDay reports it too.
    const day = offDays[0] ?? -1;
    const plan = itinerary.days[day];
    if (!plan) throw new Error("no day off the chosen base");
    const edited = rescheduleDay(itinerary, day, removeStop(plan, 0), ctx);
    expect(edited.violations.some((v) => v.code === "ANCHOR_NOT_CHOSEN")).toBe(true);
    expect(edited.itinerary.warnings.some((w) => w.code === "ANCHOR_NOT_CHOSEN")).toBe(true);
  });
});

describe("disagreement 3: warnings after an edit", () => {
  it("never shows different warnings after an edit than the validator gives the same trip", () => {
    // Trevi by day and by night, both asked for: SAME_LOCATION on day 1. Editing that day used
    // to swap the validator's warnings for scheduleDay's differently worded ones.
    const request = makeRequest({ mustInclude: ["place_018", "place_077"], anchors: ["rome"] });
    const itinerary = planDeterministic(request, ctx);
    const first = itinerary.days[0];
    if (!first) throw new Error("no first day");
    const edited = rescheduleDay(itinerary, 0, removeStop(first, 1), ctx).itinerary;
    const expected = validateItinerary(edited, ctx).filter((v) => v.severity === "warning");
    expect(edited.warnings).toEqual(expected.sort(compareViolations));
    expect(edited.warnings.map((w) => w.code)).toContain("SAME_LOCATION");
  });
});

describe("contract: one severity per code", () => {
  it("never lets the scheduler and the validator give one code two severities", () => {
    for (const code of VIOLATION_CODES) {
      expect(makeViolation(code, "x").severity, code).toBe(VIOLATION_SEVERITY[code]);
    }
  });
});
