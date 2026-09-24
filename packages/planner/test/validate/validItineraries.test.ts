import { describe, expect, it } from "vitest";
import { MEALS, PACE, TRIP_DAYS } from "../../src/config";
import { buildPlannerContext } from "../../src/context";
import { ViolationSchema } from "../../src/schemas";
import { addDays, hoursOn } from "../../src/time";
import type { Itinerary } from "../../src/types";
import { VIOLATION_SEVERITY, validateItinerary, validationErrors } from "../../src/validate";
import { ctx, key, miniTrip, VALID_TRIPS } from "./fixtures";

// Failure vector F1: the mutation suite is only as good as its starting point. These tests prove
// each hand-written trip is valid twice over: once by the validator, and once by a plain re-check
// against hoursOn and the pace table that does not use the validator at all.

const ALL_TRIPS = [...VALID_TRIPS, { name: "mini trip", build: () => miniTrip(), warnings: [] }];

describe("hand-written valid trips", () => {
  it.each(VALID_TRIPS)("reports no errors and exactly the expected warnings: $name", (trip) => {
    const violations = validateItinerary(trip.build(), ctx());
    expect(violations.filter((v) => v.severity === "error")).toEqual([]);
    expect(violations.map(key)).toEqual(trip.warnings);
  });

  it("gives the mini trip only missing-meal warnings, so one-code tests start clean", () => {
    const violations = validateItinerary(miniTrip(), ctx());
    expect(new Set(violations.map((v) => v.code))).toEqual(new Set(["MEAL_MISSING"]));
  });

  it.each(ALL_TRIPS)("holds up without the validator: every stop open per hoursOn ($name)", (t) => {
    const plan = t.build();
    expect(plan.days).toHaveLength(TRIP_DAYS);
    const pace = PACE[plan.request.pace];
    plan.days.forEach((day, index) => {
      expect(day.date).toBe(addDays(plan.request.startDate, index));
      for (const stop of day.stops) {
        const place = ctx().placesById.get(stop.placeId);
        if (!place) throw new Error(`fixture uses unknown place ${stop.placeId}`);
        expect(ctx().anchorIdByPlaceId.get(place.id)).toBe(day.anchorId);
        expect(stop.end - stop.start).toBe(place.durationMin);
        expect(stop.start).toBeGreaterThanOrEqual(pace.dayStart + day.transferMin);
        expect(stop.end).toBeLessThanOrEqual(pace.dayEnd);
        const hours = hoursOn(place, day.date);
        if (hours !== "unknown") {
          const fits = hours.some((r) => r.open <= stop.start && stop.end <= r.close);
          expect(fits, `${place.name} on ${day.date}`).toBe(true);
        }
        if (stop.role !== "visit") {
          expect(stop.start).toBeGreaterThanOrEqual(MEALS[stop.role].earliestStart);
          expect(stop.start).toBeLessThanOrEqual(MEALS[stop.role].latestStart);
          expect(place.meals).toContain(stop.role);
        }
      }
    });
  });
});

describe("validator contract", () => {
  it.each(ALL_TRIPS)("never changes the plan it checks ($name)", (trip) => {
    const plan = trip.build();
    const before = JSON.stringify(plan);
    validateItinerary(deepFreeze(plan), ctx());
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("gives the same answer every time, so a retry cannot flip a plan to valid", () => {
    const plan = VALID_TRIPS[2]?.build() as Itinerary;
    plan.days[0]?.stops.reverse();
    const first = validateItinerary(plan, ctx());
    expect(first.length).toBeGreaterThan(0);
    expect(validateItinerary(plan, ctx())).toEqual(first);
  });

  it("does not depend on the order the places were loaded in", () => {
    const shuffled = buildPlannerContext([...ctx().places].reverse());
    for (const trip of VALID_TRIPS) {
      const plan = trip.build();
      plan.days[1]?.stops.pop();
      expect(validateItinerary(plan, shuffled)).toEqual(validateItinerary(plan, ctx()));
    }
  });

  it("uses the severity table for every violation, so an error is never sent as a warning", () => {
    const plan = miniTrip({ exclude: ["place_005"] });
    for (const item of validateItinerary(plan, ctx())) {
      expect(item.severity).toBe(VIOLATION_SEVERITY[item.code]);
    }
  });

  it("returns violations the API schema accepts", () => {
    const plan = miniTrip({ mustInclude: ["place_007"], maxPriceLevel: 1 });
    const violations = validateItinerary(plan, ctx());
    expect(violations.length).toBeGreaterThan(2);
    for (const item of violations) expect(ViolationSchema.safeParse(item).success).toBe(true);
  });

  it("keeps validationErrors to errors only, so a warning never blocks a plan", () => {
    const plan = VALID_TRIPS[3]?.build() as Itinerary;
    expect(validateItinerary(plan, ctx()).length).toBeGreaterThan(0);
    expect(validationErrors(plan, ctx())).toEqual([]);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}
