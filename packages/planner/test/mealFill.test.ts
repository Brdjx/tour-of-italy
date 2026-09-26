import { describe, expect, it } from "vitest";
import { PACE, TRAVEL } from "../src/config";
import { servesMeal, withinBudget } from "../src/constraints";
import { addMissingMeals, fillMissingMeals } from "../src/mealFill";
import { mealGaps } from "../src/mealSupply";
import { planDeterministic } from "../src/plan";
import { MEAL_WAIT_MAX_MIN } from "../src/planPolicy";
import { PoolCache } from "../src/pools";
import { scheduleDay } from "../src/schedule";
import { tripDates } from "../src/time";
import { type DaySelection, scheduleTrip } from "../src/trip";
import type { TripDraft } from "../src/tripBuilder";
import type { Itinerary, Place, TripRequest } from "../src/types";
import { validationErrors } from "../src/validate";
import { makeRequest, realContext } from "./plannerFixtures";

// The meal fill (mealFill.ts) is the last pass before timing: it seats a missing lunch or dinner
// at an unused meal place when that changes nothing else. The failures it prevents: a day with
// no dinner while a restaurant of the base stays unused, and the failures it must never cause:
// a stop removed, reordered, or given another role, a meal over the budget when one within it
// fits, and lunch back in the base city between two stops of a day trip out of town.

const ctx = realContext();

function fill(request: TripRequest, draft: TripDraft): TripDraft {
  const dates = tripDates(request.startDate);
  return fillMissingMeals(draft, request, ctx, dates, new PoolCache(request, ctx));
}

function timedDay(request: TripRequest, draft: TripDraft, index: number) {
  const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
  if (!anchor) throw new Error("unknown base");
  const date = tripDates(request.startDate)[index] ?? "";
  return scheduleDay(draft.days[index] ?? [], date, anchor, request, ctx, 0);
}

const ROME = ["rome", "rome", "rome"];

describe("fillMissingMeals", () => {
  it("never leaves a day without dinner while an unused restaurant could seat it (Rome, Sunday)", () => {
    // Review finding: day 2 of this trip ended at 20:10 with lunch only, because day 3 took the
    // dinner place day 2 was counting on; Osteria Fernanda (open Sundays) stayed unused.
    const request = makeRequest({ startDate: "2027-01-02", anchors: ["rome"] });
    const itinerary = planDeterministic(request, ctx);
    for (const day of itinerary.days) {
      expect(
        day.stops.some((stop) => stop.role === "dinner"),
        day.date,
      ).toBe(true);
    }
  });

  it("never removes, reorders, or changes the role of a stop where adding seats the meals", () => {
    const request = makeRequest({ startDate: "2026-10-20", anchors: ["rome"] });
    const draft = {
      anchorIds: ROME,
      days: [["place_005", "place_007"], ["place_001"], ["place_018", "place_004"]],
      score: 0,
    };
    const filled = fill(request, draft);
    filled.days.forEach((ids, index) => {
      const kept = ids.filter((id) => draft.days[index]?.includes(id));
      expect(kept).toEqual(draft.days[index]);
      const before = timedDay(request, draft, index).stops;
      const after = timedDay(request, filled, index).stops;
      for (const stop of before) {
        expect(after.find((s) => s.placeId === stop.placeId)?.role).toBe(stop.role);
      }
      const roles = after.map((stop) => stop.role);
      expect(roles).toContain("lunch");
      expect(roles).toContain("dinner");
    });
    const all = filled.days.flat();
    expect(new Set(all).size).toBe(all.length); // no meal place twice in the trip
  });

  it("never seats a meal over the budget while a meal place within it could take that meal", () => {
    const request = makeRequest({ startDate: "2026-10-20", anchors: ["rome"], maxPriceLevel: 2 });
    const draft = {
      anchorIds: ROME,
      days: [["place_005"], ["place_001"], ["place_018"]],
      score: 0,
    };
    const filled = fill(request, draft);
    const inTrip = new Set(filled.days.flat());
    const pool = new PoolCache(request, ctx).strict("rome");
    filled.days.forEach((ids, index) => {
      timedDay(request, filled, index).stops.forEach((stop, at) => {
        const place = ctx.placesById.get(stop.placeId);
        if (!place || stop.role === "visit" || withinBudget(place, 2)) return;
        // Over budget only when no unused meal place within it could take the same seat (six
        // meals, five meal places within budget, and an all-day food hall reached at 16:00 is
        // a visit, not dinner).
        for (const other of pool) {
          if (!withinBudget(other, 2) || !servesMeal(other, stop.role) || inTrip.has(other.id)) {
            continue;
          }
          const swapped = { ...filled, days: filled.days.map((d) => [...d]) };
          swapped.days[index] = ids.map((id, n) => (n === at ? other.id : id));
          const seat = timedDay(request, swapped, index);
          const clean = !seat.violations.some((v) => v.severity === "error");
          expect(clean && seat.stops[at]?.role === stop.role, `${other.id} for ${place.id}`).toBe(
            false,
          );
        }
      });
    });
    expect(filled.days.flat().length).toBeGreaterThan(draft.days.flat().length);
  });

  it("never brings the traveler back to the base city for lunch in the middle of a day trip", () => {
    // Modena (Acetaia Giusti) then Maranello (Ferrari Museum): lunch in Bologna between them
    // would mean leaving town twice.
    const request = makeRequest({ startDate: "2026-10-20", anchors: ["bologna"] });
    const away = ["place_083", "place_045"];
    const draft = {
      anchorIds: ["bologna", "bologna", "bologna"],
      days: [away, ["place_048"], ["place_051"]],
      score: 0,
    };
    const day = fill(request, draft).days[0] ?? [];
    const from = day.indexOf("place_083");
    expect(day.indexOf("place_045")).toBe(from + 1);
  });

  it.each([
    ["2026-06-19", "balanced", ["lively"]],
    ["2026-01-17", "packed", ["food"]],
  ] as const)(
    "never makes lunch the first stop of a Bologna day after a morning of waiting (%s, %s)",
    (startDate, pace, interests) => {
      // Review finding: the fill tried positions from the start of the day, so lunch at Via
      // Drapperie at 12:00 opened the day and every morning sight moved to the afternoon.
      const request = makeRequest({
        startDate,
        pace,
        interests: [...interests],
        anchors: ["bologna"],
      });
      for (const day of planDeterministic(request, ctx).days) {
        const first = day.stops[0];
        if (!first) continue;
        const wait =
          first.start - (PACE[pace].dayStart + day.transferMin + first.travelFromPrevMin);
        expect(wait, `${day.date} first stop ${first.placeId}`).toBeLessThanOrEqual(
          MEAL_WAIT_MAX_MIN,
        );
      }
    },
  );

  it("never lets a stop by night excuse a long wait the fill adds to the day (Bologna, packed)", () => {
    // Piazza Maggiore by night at 20:00 follows hours of rest; that wait is the evening, and it
    // must not let lunch open the day at 12:00 after the traveler waited since 08:30.
    const request = makeRequest({ startDate: "2026-01-16", pace: "packed", anchors: ["bologna"] });
    for (const day of planDeterministic(request, ctx).days) {
      let free = PACE.packed.dayStart + day.transferMin;
      day.stops.forEach((stop, index) => {
        const arrive = free + stop.travelFromPrevMin + (index === 0 ? 0 : TRAVEL.bufferMin);
        if (stop.role !== "dinner" && stop.start < 18 * 60) {
          expect(stop.start - arrive, `${day.date} ${stop.placeId}`).toBeLessThanOrEqual(60);
        }
        free = stop.end;
      });
    }
  });

  it("never touches a day that already has an error", () => {
    const request = makeRequest({ startDate: "2026-10-19", anchors: ["rome"] }); // a Monday
    const closed = ["place_007"]; // Borghese Gallery is closed on Mondays
    const draft = { anchorIds: ROME, days: [closed, ["place_001"], ["place_018"]], score: 0 };
    expect(fill(request, draft).days[0]).toEqual(closed);
  });
});

describe("fillMissingMeals, giving up a visit", () => {
  it("gives up the evening sight for dinner when another day took the dinner place (Rome, default trip)", () => {
    // The default form (start 2026-10-09, balanced, no options): day 1 took Pigneto until 20:20
    // counting on a dinner place days 2 and 3 then took, and the one left was out of reach.
    const request = makeRequest({ startDate: "2026-10-09", pace: "balanced" });
    const itinerary = planDeterministic(request, ctx);
    expect(itinerary.warnings.filter((w) => w.code === "MEAL_MISSING")).toEqual([]);
    const day1 = itinerary.days[0]?.stops ?? [];
    expect(day1.some((stop) => stop.role === "dinner")).toBe(true);
    expect(day1.filter((stop) => stop.role === "visit").length).toBeGreaterThanOrEqual(2);
  });

  it("never gives up a must-include for a meal", () => {
    const request = makeRequest({
      startDate: "2026-10-09",
      pace: "balanced",
      mustInclude: ["place_013"],
    });
    const itinerary = planDeterministic(request, ctx);
    expect(
      itinerary.days.some((day) => day.stops.some((stop) => stop.placeId === "place_013")),
    ).toBe(true);
  });
});

describe("addMissingMeals, on days someone else chose", () => {
  // The API completes an AI day with it (services/api/src/plan/mealAdd.ts): the model chose the
  // visits, and code may only add the lunch or dinner a day lacks, never move or drop a stop.
  const request = makeRequest({ startDate: "2026-10-20", anchors: ["rome"] });
  const visitsOnly = [
    { anchorId: "rome", placeIds: ["place_001", "place_004", "place_005"] },
    { anchorId: "rome", placeIds: ["place_002", "place_007"] },
    { anchorId: "rome", placeIds: ["place_013", "place_016"] },
  ];

  function timed(days: readonly DaySelection[], req: TripRequest = request) {
    const trip = scheduleTrip(req, days, ctx);
    const itinerary: Itinerary = {
      request: req,
      days: trip.days,
      source: "ai",
      warnings: [],
      meta: { attempts: 1, latencyMs: 0, generatedAt: "2026-09-26T00:00:00.000Z" },
    };
    return itinerary;
  }

  it("adds the lunch and dinner each day lacks, keeping every stop in its order and role", () => {
    const before = timed(visitsOnly);
    const { days, added } = addMissingMeals(request, visitsOnly, ctx);
    const after = timed(days);

    expect(added.length).toBeGreaterThanOrEqual(3);
    expect(validationErrors(after, ctx)).toEqual([]);
    const ids = days.flatMap((day) => day.placeIds);
    expect(new Set(ids).size).toBe(ids.length);
    days.forEach((day, index) => {
      const own = day.placeIds.filter((id) => visitsOnly[index]?.placeIds.includes(id));
      expect(own).toEqual(visitsOnly[index]?.placeIds);
      const roles = (plan: Itinerary) =>
        new Map(plan.days[index]?.stops.map((stop) => [stop.placeId, stop.role]));
      for (const [id, role] of roles(before)) expect(roles(after).get(id)).toBe(role);
    });
    for (const meal of added) {
      const stop = after.days[meal.day]?.stops.find((s) => s.placeId === meal.placeId);
      expect(stop?.role).toBe(meal.meal);
      expect(servesMeal(ctx.placesById.get(meal.placeId) as Place, meal.meal)).toBe(true);
    }
    expect(after.days.flatMap((d) => d.stops).filter((s) => s.role !== "visit")).toHaveLength(
      added.length,
    );
  });

  it("adds only places the caller allows, and only to the days it names", () => {
    expect(addMissingMeals(request, visitsOnly, ctx, { allowed: () => false })).toEqual({
      days: visitsOnly,
      added: [],
    });
    const second = addMissingMeals(request, visitsOnly, ctx, { only: [1] });
    expect(second.added.every((meal) => meal.day === 1)).toBe(true);
    expect(second.added.length).toBeGreaterThan(0);
    expect(second.days[0]).toEqual(visitsOnly[0]);
    expect(second.days[2]).toEqual(visitsOnly[2]);
  });

  it("never adds a place another day has, or one at its spot", () => {
    const withDinner = [
      { anchorId: "rome", placeIds: ["place_001", "place_009"] },
      ...visitsOnly.slice(1),
    ];
    const { added } = addMissingMeals(request, withDinner, ctx);
    expect(added.map((meal) => meal.placeId)).not.toContain("place_009");
  });

  it("adds no dinner on a Monday in Bologna, where no dinner place opens (the owner's day)", () => {
    const monday = makeRequest({ startDate: "2026-10-12" });
    const bologna = [{ anchorId: "bologna", placeIds: ["place_048", "place_054"] }];
    const { days, added } = addMissingMeals(monday, bologna, ctx);

    expect(added.map((meal) => meal.meal)).toEqual(["lunch"]);
    const gaps = mealGaps(timed(days, monday), ctx);
    expect(gaps.map((gap) => [gap.meal, gap.cause])).toEqual([["dinner", "none_open"]]);
  });
});
