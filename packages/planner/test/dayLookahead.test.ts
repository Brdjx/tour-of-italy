import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DINNER_RETURN_GRACE_MIN } from "../src/config";
import { dayWindow, earliestMealStart, earliestOpenStart, servesMeal } from "../src/constraints";
import { anchorOfPlace } from "../src/context";
import { fitsEmptyDay, type LatestStarts, latestStartsFor, mayVisit } from "../src/dayLimits";
import { slotShortfall } from "../src/dayLookahead";
import { addDays } from "../src/time";
import { type LatLng, travelMinutes } from "../src/travel";
import type { Meal, Pace, Place } from "../src/types";
import { FC_SETTINGS, realContext, realPlace } from "./plannerFixtures";

// The greedy walk looks ahead with latest start times instead of re-running the constraint
// functions for every possible future. If the shortcut and the constraint functions ever
// disagreed, the walk would keep a promise it cannot keep (a must-include lost, a meal missed)
// or refuse a stop that was fine. The property below proves they agree on real places.

const ctx = realContext();
const TUESDAY = "2026-10-20";
const PACES: Pace[] = ["relaxed", "balanced", "packed"];

/** Where a day at the place's own base starts and ends: that base's centroid. */
function originOf(place: Place): LatLng {
  const anchor = anchorOfPlace(ctx, place.id);
  if (!anchor) throw new Error(`no base for ${place.id}`);
  return anchor.centroid;
}

function limitsFor(places: Place[], date = TUESDAY, pace: Pace = "balanced") {
  const mustInclude = places.map((place) => place.id);
  const origin = originOf(places[0] as Place);
  return latestStartsFor({ date, pace, transferMin: 0, origin, pool: places, mustInclude });
}

function shortfall(ids: string[], clock: number, taken: Meal[] = [], visitsLeft = 5): number {
  const places = ids.map(realPlace);
  const florence = ctx.anchorById.get("florence")?.centroid ?? { lat: 0, lng: 0 };
  const at = { clock, position: florence, first: true };
  return slotShortfall(places, at, taken, visitsLeft, limitsFor(places));
}

describe("slot matching for must-include places", () => {
  it("sees two dinner-only must-includes competing for the one dinner", () => {
    expect(shortfall(["place_037", "place_041"], 600)).toBe(1);
  });

  it("sees no conflict when one of the two can still take lunch", () => {
    expect(shortfall(["place_029", "place_037"], 600)).toBe(0);
  });

  it("sees the conflict appear once the lunch window has passed", () => {
    expect(shortfall(["place_029", "place_037"], 900)).toBe(1);
  });

  it("never promises more visit slots than the pace's cap", () => {
    expect(shortfall(["place_026", "place_032", "place_101"], 600, [], 2)).toBe(1);
    expect(shortfall(["place_026", "place_032", "place_101"], 600, [], 3)).toBe(0);
  });

  it("counts a must-include that can no longer happen today as lost (Bargello after 14:00)", () => {
    expect(shortfall(["place_101"], 840)).toBe(1);
  });

  it("lets a dinner-only cafe become a visit once dinner is taken, instead of counting it lost", () => {
    expect(shortfall(["place_037"], 600, ["dinner"])).toBe(0);
  });

  it("never counts a meal place as a visit while its meal is still open (inference seats it)", () => {
    // After lunch, Mercato Centrale could only be a visit once dinner is taken, so it and the
    // dinner-only Rasputin compete for the one dinner even with visit slots to spare.
    expect(shortfall(["place_031", "place_037"], 900, ["lunch"], 5)).toBe(1);
  });
});

describe("latest start times agree with the constraint functions", () => {
  const anyCase = fc.record({
    place: fc.constantFrom(...ctx.places),
    date: fc.integer({ min: 0, max: 730 }).map((n) => addDays("2026-01-01", n)),
    pace: fc.constantFrom(...PACES),
    transferMin: fc.constantFrom(0, 100, 130, 215),
    fraction: fc.double({ min: 0, max: 1, noNaN: true }),
  });

  function feasibleNow(latest: number | undefined, arrive: number): boolean {
    return latest !== undefined && arrive <= latest;
  }

  it("says a meal or a visit fits, with the trip back to the base, exactly when the constraint functions say so", () => {
    fc.assert(
      fc.property(anyCase, ({ place, date, pace, transferMin, fraction }) => {
        const window = dayWindow(pace, transferMin);
        const arrive = Math.round(window.start + fraction * (window.end - window.start));
        const origin = originOf(place);
        const input = { date, pace, transferMin, origin, pool: [place], mustInclude: [place.id] };
        const limits: LatestStarts = latestStartsFor(input).get(place.id) ?? {};
        const duration = place.durationMin;
        // A must-include has no planner preferences: only the hours, the window, and the way back
        // (which may end DINNER_RETURN_GRACE_MIN after the window when dinner ends the day).
        const back = travelMinutes(place, origin);
        const lastEnd = window.end - back;
        for (const meal of ["lunch", "dinner"] as const) {
          if (!servesMeal(place, meal)) continue;
          const start = earliestMealStart(place, date, arrive, meal, duration);
          const grace = meal === "dinner" ? DINNER_RETURN_GRACE_MIN : 0;
          const mealEnd = Math.min(window.end, window.end + grace - back);
          const fits = start !== null && start + duration <= mealEnd;
          if (fits !== feasibleNow(limits[meal], arrive)) return false;
        }
        const start = earliestOpenStart(place, date, arrive, duration);
        const fits = start !== null && start + duration <= lastEnd;
        return fits === feasibleNow(limits.visit, arrive);
      }),
      FC_SETTINGS,
    );
  });
});

describe("helpers", () => {
  it("fits Piazza del Popolo at Dawn into a packed day only, never a later start or a transfer day", () => {
    const place = realPlace("place_023");
    const rome = ctx.anchorById.get("rome")?.centroid ?? { lat: 0, lng: 0 };
    expect(fitsEmptyDay(place, TUESDAY, "packed", 0, rome)).toBe(true);
    expect(fitsEmptyDay(place, TUESDAY, "balanced", 0, rome)).toBe(false);
    expect(fitsEmptyDay(place, TUESDAY, "relaxed", 0, rome)).toBe(false);
    expect(fitsEmptyDay(place, TUESDAY, "packed", 130, rome)).toBe(false);
  });

  it("never leaves the 90-minute early walk in Cannaregio unplannable: it fits a packed day", () => {
    const place = realPlace("place_075");
    const venice = originOf(place);
    expect(fitsEmptyDay(place, TUESDAY, "packed", 0, venice)).toBe(true);
    expect(fitsEmptyDay(place, TUESDAY, "balanced", 0, venice)).toBe(false);
    expect(fitsEmptyDay(place, TUESDAY, "relaxed", 0, venice)).toBe(false);
  });

  it("never lets an ordinary meal place be a visit, but allows one the traveler asked for", () => {
    expect(mayVisit(realPlace("place_003"), [])).toBe(false);
    expect(mayVisit(realPlace("place_003"), ["place_003"])).toBe(true);
    expect(mayVisit(realPlace("place_031"), [])).toBe(false); // the food hall is a meal place
    expect(mayVisit(realPlace("place_001"), [])).toBe(true);
  });

  it("gives an ordinary restaurant no visit time, and ends dinner inside the window with the walk home at most 30 minutes after it", () => {
    const place = realPlace("place_003");
    const limits = latestStartsFor({
      date: TUESDAY,
      pace: "balanced",
      transferMin: 0,
      origin: originOf(place),
      pool: [place],
      mustInclude: [],
    });
    // Lunch 12:30 to 14:30 with a 90-minute visit: the last start is 13:00. Dinner must end by
    // 22:30 and be back at the Rome base by 23:00 (a 15-minute trip back: 22:30 decides).
    const back = travelMinutes(place, originOf(place));
    const dinnerEnd = Math.min(1350, 1350 + DINNER_RETURN_GRACE_MIN - back);
    expect(limits.get("place_003")).toEqual({ lunch: 780, dinner: dinnerEnd - 90 });
    expect(dinnerEnd).toBe(1350);
  });

  it("starts an ordinary outing by noon and ends an outdoor one by sunset, but never a must-include", () => {
    const siena = realPlace("place_038"); // 360-minute day trip, outdoors, hours unknown
    const origin = originOf(siena);
    const input = { date: "2027-01-12", pace: "packed" as const, transferMin: 0, origin };
    const preferred = latestStartsFor({ ...input, pool: [siena], mustInclude: [] });
    const asked = latestStartsFor({ ...input, pool: [siena], mustInclude: [siena.id] });
    // January sunset is 17:00, so a 6-hour trip starts by 11:00; asked for, only the day's end
    // and the way back limit it.
    expect(preferred.get(siena.id)?.visit).toBe(17 * 60 - 360);
    expect(asked.get(siena.id)?.visit).toBe(23 * 60 + 30 - travelMinutes(siena, origin) - 360);
  });
});
