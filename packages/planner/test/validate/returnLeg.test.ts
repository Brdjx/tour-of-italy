import { describe, expect, it } from "vitest";
import { planDeterministic } from "../../src/plan";
import { scheduleDay } from "../../src/schedule";
import { travelMinutes } from "../../src/travel";
import type { TripRequest } from "../../src/types";
import { validateItinerary } from "../../src/validate";
import { ctx, dayOf, errorCodes, key, withCode } from "./fixtures";
import { itinerary, stop } from "./trips";

// The trip back to the base is part of the day: a day that ends at a restaurant in Modena at
// 22:00 ends in Bologna at 23:05. Both the validator and the scheduler must refuse a last stop
// that leaves no time to get back, agree on where the problem is, and hold a day's stated trip
// back to the travel model. An outing through lunch (a day in Siena) needs no lunch stop.

const request: TripRequest = {
  startDate: "2026-10-20", // a Tuesday: Osteria Francescana serves dinner 20:00 to 22:00
  pace: "balanced",
  interests: [],
  maxPriceLevel: null,
  anchors: ["bologna"],
  mustInclude: [],
  exclude: [],
};

const bologna = () => {
  const anchor = ctx().anchorById.get("bologna");
  if (!anchor) throw new Error("no Bologna base");
  return anchor;
};
const francescana = () => {
  const place = ctx().placesById.get("place_043");
  if (!place) throw new Error("no Osteria Francescana");
  return place;
};

/** A Bologna trip whose first day is dinner in Modena from `start`, and quiet days after it. */
function modenaDinner(start: number) {
  const leg = travelMinutes(bologna().centroid, francescana());
  const dinner = stop("place_043", start, start + francescana().durationMin, leg, "dinner");
  return itinerary(request, [
    { date: "2026-10-20", anchorId: "bologna", transferMin: 0, stops: [dinner] },
  ]);
}

describe("the trip back to the base", () => {
  it("never passes a last stop that leaves no time to get back before the day ends", () => {
    const plan = modenaDinner(1200); // 20:00 to 22:00, then 65 min back: 23:05, after 22:30 + 30
    expect(errorCodes(plan)).toEqual(["OUTSIDE_DAY_WINDOW"]);
    const [found] = withCode(plan, "OUTSIDE_DAY_WINDOW");
    expect(found).toMatchObject({ day: 0, stopIndex: 0, placeId: "place_043" });
    expect(found?.detail).toBe(
      "Osteria Francescana ends at 22:00, and the trip back to the Bologna base takes 1 h 5 min, so the day would end at 23:05, after 23:00, the latest return after dinner.",
    );
  });

  it("never lets the scheduler and the validator disagree on that last stop", () => {
    const day = scheduleDay(["place_043"], "2026-10-20", bologna(), request, ctx(), 0, {
      dayIndex: 0,
    });
    const flagged = day.violations.filter((v) => v.severity === "error").map(key);
    expect(flagged).toEqual(["OUTSIDE_DAY_WINDOW 0 place_043"]);
    expect(day.returnTravelMin).toBe(travelMinutes(francescana(), bologna().centroid));
  });

  it("never rejects a stated trip back that matches the travel model, or a day that states none", () => {
    const plan = modenaDinner(1200);
    plan.request = { ...request, pace: "packed" }; // 23:30: there is time to get back
    expect(errorCodes(plan)).toEqual([]);
    dayOf(plan, 0).returnTravelMin = travelMinutes(francescana(), bologna().centroid);
    expect(errorCodes(plan)).toEqual([]);
  });

  it("never trusts a stated trip back that the travel model does not give", () => {
    const plan = modenaDinner(1200);
    plan.request = { ...request, pace: "packed" };
    dayOf(plan, 0).returnTravelMin = 10;
    expect(withCode(plan, "WRONG_TRAVEL")[0]).toMatchObject({
      day: 0,
      detail: "Day 1 lists 10 min for the trip back to Bologna, but it takes 1 h 5 min.",
    });
    dayOf(plan, 0).returnTravelMin = Number.NaN;
    expect(withCode(plan, "WRONG_TRAVEL")[0]?.detail).toContain("not a valid number of minutes");
  });
});

describe("the walk home after a dinner that ends the day", () => {
  const relaxed: TripRequest = { ...request, pace: "relaxed", anchors: ["venice"] };
  const venice = () => {
    const anchor = ctx().anchorById.get("venice");
    if (!anchor) throw new Error("no Venice base");
    return anchor;
  };
  /** A relaxed Venice day that ends with `id` from `start` in `role`. */
  function endsWith(id: string, start: number, role: "visit" | "dinner") {
    const place = ctx().placesById.get(id);
    if (!place) throw new Error(`no ${id}`);
    const leg = travelMinutes(venice().centroid, place);
    const last = stop(id, start, start + place.durationMin, leg, role);
    return itinerary(relaxed, [
      { date: "2026-10-20", anchorId: "venice", transferMin: 0, stops: [last] },
    ]);
  }

  it("never refuses a relaxed day ending with the 3-hour cicchetti crawl and a 20-minute walk home", () => {
    const plan = endsWith("place_068", 1140, "dinner"); // 19:00 to 22:00, home at 22:20
    expect(errorCodes(plan)).toEqual([]);
    const day = scheduleDay(["place_068"], "2026-10-20", venice(), relaxed, ctx(), 0);
    expect(day.stops[0]).toMatchObject({ role: "dinner", start: 1140, end: 1320 });
    expect(day.violations.filter((v) => v.severity === "error")).toEqual([]);
  });

  it("never gives the walk-home allowance to a visit that ends the day", () => {
    const plan = endsWith("place_068", 1140, "visit"); // the same times, but not a dinner
    expect(errorCodes(plan)).toContain("OUTSIDE_DAY_WINDOW");
  });

  it.each([
    ["venice", "place_068"], // Cicchetti Bar Crawl, 3 hours
    ["milan", "place_100"], // Aperitivo Culture Walk, 3 hours
  ])("never leaves the long evening dinner out of a relaxed %s trip", (base, id) => {
    // Review finding: 0 of 243 relaxed trips had either, so relaxed Milan had no dinner at all.
    const plan = planDeterministic({ ...relaxed, startDate: "2026-06-16", anchors: [base] }, ctx());
    const stops = plan.days.flatMap((day) => day.stops);
    expect(stops.find((stop) => stop.placeId === id)?.role).toBe("dinner");
    expect(errorCodes(plan)).toEqual([]);
  });

  it("never lets the dinner itself run past the day window, only the walk home", () => {
    const plan = endsWith("place_068", 1155, "dinner"); // 19:15 to 22:15, after 22:00
    expect(withCode(plan, "OUTSIDE_DAY_WINDOW")[0]).toMatchObject({ day: 0, stopIndex: 0 });
  });
});

describe("an outing through a meal", () => {
  it("never warns of no lunch on a day in Siena under way through the lunch window", () => {
    const florence = ctx().anchorById.get("florence");
    const siena = ctx().placesById.get("place_038");
    if (!florence || !siena) throw new Error("missing Florence or Siena");
    const leg = travelMinutes(florence.centroid, siena);
    const start = 570 + leg; // leaves at 09:30
    const outing = stop("place_038", start, start + siena.durationMin, leg, "visit");
    const plan = itinerary({ ...request, anchors: ["florence"] }, [
      { date: "2026-10-20", anchorId: "florence", transferMin: 0, stops: [outing] },
    ]);
    const missing = validateItinerary(plan, ctx()).filter(
      (v) => v.code === "MEAL_MISSING" && v.day === 0,
    );
    expect(missing.map((v) => v.detail)).toEqual(["Day 1 has no dinner stop."]);
  });
});
