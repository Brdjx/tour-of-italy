import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { dayWindow, earliestMealStart, earliestOpenStart, servesMeal } from "../src/constraints";
import { fitsEmptyDay, type LatestStarts, latestStartsFor, mayVisit } from "../src/dayLimits";
import { slotShortfall } from "../src/dayLookahead";
import { addDays } from "../src/time";
import type { Meal, Pace, Place } from "../src/types";
import { FC_SETTINGS, realContext, realPlace } from "./plannerFixtures";

// The greedy walk looks ahead with latest start times instead of re-running the constraint
// functions for every possible future. If the shortcut and the constraint functions ever
// disagreed, the walk would keep a promise it cannot keep (a must-include lost, a meal missed)
// or refuse a stop that was fine. The property below proves they agree on real places.

const ctx = realContext();
const TUESDAY = "2026-10-20";
const PACES: Pace[] = ["relaxed", "balanced", "packed"];

function limitsFor(places: Place[], date = TUESDAY, pace: Pace = "balanced") {
  const mustInclude = places.map((place) => place.id);
  return latestStartsFor({ date, pace, transferMin: 0, pool: places, mustInclude });
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

  it("counts visit slots against the pace's cap", () => {
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

  it("says a meal or a visit fits exactly when earliestMealStart and earliestOpenStart say so", () => {
    fc.assert(
      fc.property(anyCase, ({ place, date, pace, transferMin, fraction }) => {
        const window = dayWindow(pace, transferMin);
        const arrive = Math.round(window.start + fraction * (window.end - window.start));
        const limits: LatestStarts =
          latestStartsFor({ date, pace, transferMin, pool: [place], mustInclude: [place.id] }).get(
            place.id,
          ) ?? {};
        const duration = place.durationMin;
        for (const meal of ["lunch", "dinner"] as const) {
          if (!servesMeal(place, meal)) continue;
          const start = earliestMealStart(place, date, arrive, meal, duration);
          const fits = start !== null && start + duration <= window.end;
          if (fits !== feasibleNow(limits[meal], arrive)) return false;
        }
        const start = earliestOpenStart(place, date, arrive, duration);
        const fits = start !== null && start + duration <= window.end;
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

  it("counts travel from the base: the 90-minute Cannaregio dawn walk fits no pace at all", () => {
    const place = realPlace("place_075");
    const venice = ctx.anchorById.get("venice")?.centroid ?? { lat: 0, lng: 0 };
    for (const pace of PACES) expect(fitsEmptyDay(place, TUESDAY, pace, 0, venice)).toBe(false);
  });

  it("never lets an ordinary restaurant be a visit, but allows one the traveler asked for", () => {
    expect(mayVisit(realPlace("place_003"), [])).toBe(false);
    expect(mayVisit(realPlace("place_003"), ["place_003"])).toBe(true);
    expect(mayVisit(realPlace("place_031"), [])).toBe(true);
    expect(mayVisit(realPlace("place_001"), [])).toBe(true);
  });

  it("gives an ordinary restaurant no visit time, so the walk never plans one", () => {
    const limits = latestStartsFor({
      date: TUESDAY,
      pace: "balanced",
      transferMin: 0,
      pool: [realPlace("place_003")],
      mustInclude: [],
    });
    // Lunch 12:30 to 14:30 with a 90-minute visit: the last start is 13:00.
    expect(limits.get("place_003")).toEqual({ lunch: 780, dinner: 1260 });
  });
});
