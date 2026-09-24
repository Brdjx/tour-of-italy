import { describe, expect, it } from "vitest";
import { type DayInput, startWalk, stepWalk } from "../src/dayBuilder";
import { planDeterministic } from "../src/plan";
import { OUTING_LATEST_START } from "../src/planPolicy";
import { tripDates } from "../src/time";
import { chooseTrip, mistimedMustIncludes, type TripDraft } from "../src/tripBuilder";
import type { TripRequest } from "../src/types";
import { makeRequest, realContext } from "./plannerFixtures";

// The walk takes turns between days (tripWalk.ts) and the trip builder compares arrangements of
// bases (tripBuilder.ts). The failures these tests prevent: a day that ends without dinner while
// a meal place it could use is only held for another day, an arrangement that sends a requested
// day trip out in the afternoon when another keeps it in the morning, a fed day taking the last
// meal place another day needs, a lunch taking the restaurant a later day needed for dinner, and
// a morning sight lost because each day left it to another.

const ctx = realContext();

describe("turns between days", () => {
  const REPROS: Partial<TripRequest>[] = [
    { startDate: "2027-01-12" }, // review case 04: day 3 had no dinner
    { startDate: "2026-07-20", pace: "packed", interests: ["views", "romantic"] },
  ];

  it.each(REPROS)(
    "never ends a Venice day without dinner while Osteria da Rioba is free (%o)",
    (overrides) => {
      const request = makeRequest({ ...overrides, anchors: ["venice"] });
      const days = planDeterministic(request, ctx).days;
      for (const day of days) {
        expect(
          day.stops.some((stop) => stop.role === "dinner"),
          day.date,
        ).toBe(true);
      }
      const rioba = days.flatMap((day) => day.stops).find((s) => s.placeId === "place_073");
      expect(rioba?.role).toBe("dinner");
    },
  );

  it("never gives day 1 five sights and leaves a later Bologna day with one", () => {
    // Filled one day after another, day 1 took every sight open that morning and days 2 and 3
    // were one day trip each. In turns, every day gets at least two.
    const request = makeRequest({ startDate: "2026-10-20", anchors: ["bologna"] });
    for (const day of planDeterministic(request, ctx).days) {
      const visits = day.stops.filter((stop) => stop.role === "visit").length;
      expect(visits, day.date).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("must-include timing", () => {
  it("never picks bases that put a requested day trip in the afternoon when others keep it early", () => {
    // Review repro: Venice, Venice, Bologna put the Parma tour at 14:10 to 20:10 in December;
    // Bologna first times it at 11:45 and keeps both must-includes.
    const request = makeRequest({
      startDate: "2027-11-30",
      pace: "relaxed",
      mustInclude: ["place_072", "place_053"],
    });
    const dates = tripDates(request.startDate);
    const chosen = chooseTrip(request, ctx, dates);
    if (!chosen) throw new Error("no trip");
    expect(chosen.anchorIds[0]).toBe("bologna");
    const itinerary = planDeterministic(request, ctx);
    const placed = itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
    expect(placed).toEqual(expect.arrayContaining(request.mustInclude));
    const parma = itinerary.days.flatMap((day) => day.stops).find((s) => s.placeId === "place_053");
    expect(parma?.start).toBeLessThanOrEqual(OUTING_LATEST_START);
  });

  it("counts each time rule a must-include breaks, so a later and darker day trip costs more", () => {
    const request = makeRequest({
      startDate: "2027-11-30",
      pace: "relaxed",
      mustInclude: ["place_053"],
    });
    const dates = tripDates(request.startDate);
    const draft = (anchorIds: string[], days: string[][]): TripDraft => ({
      anchorIds,
      days,
      score: 0,
    });
    const late = draft(
      ["venice", "venice", "bologna"],
      [["place_066"], ["place_074"], ["place_053"]],
    );
    const early = draft(
      ["bologna", "venice", "venice"],
      [["place_053"], ["place_074"], ["place_066"]],
    );
    // In December the tour ends after sunset either way; only the late one also starts after noon.
    expect(mistimedMustIncludes(late, request, ctx, dates)).toBe(2);
    expect(mistimedMustIncludes(early, request, ctx, dates)).toBe(1);
    expect(mistimedMustIncludes(early, { ...request, mustInclude: [] }, ctx, dates)).toBe(0);
  });
});

describe("a morning sight's last chance in the trip", () => {
  it.each(["relaxed", "balanced", "packed"] as const)(
    "never leaves the Vatican Museums out of a %s Rome trip starting on a Sunday",
    (pace) => {
      // Review finding, and again after the ablation removed this rule: the Vatican is closed on
      // Sundays and is an outing that starts by noon. Monday and Tuesday each gave their morning
      // to a sight open all week, so no Rome trip starting on a Sunday had the Vatican.
      for (const startDate of ["2026-10-11", "2027-02-14", "2027-06-27"]) {
        const request = makeRequest({ startDate, pace, anchors: ["rome"] });
        const ids = planDeterministic(request, ctx).days.flatMap((d) =>
          d.stops.map((s) => s.placeId),
        );
        expect(ids, `${startDate} ${pace}`).toContain("place_010");
      }
    },
  );
});

describe("interests on the last free morning", () => {
  it("never lets the Uffizi crowd out a Chianti day trip that matches both interests", () => {
    // Chianti matches both interests; the Uffizi, open until the evening every day, must not
    // take the last morning from it.
    const request = makeRequest({
      startDate: "2026-09-15",
      interests: ["wine", "outdoors"],
      anchors: ["florence"],
    });
    const ids = planDeterministic(request, ctx).days.flatMap((d) => d.stops.map((s) => s.placeId));
    expect(ids).toContain("place_035");
    expect(ids).toContain("place_026");
  });
});

describe("a lunch no stop can seat yet", () => {
  it("never ends a Bologna Monday at 10:20 because its only lunch is not yet an option", () => {
    // The only Monday lunch is Via Drapperie at noon. At 10:20 it is no option (a 95-minute wait)
    // and every sight left would lose it, so keeping the promise stopped the day after one stop.
    const request = makeRequest({ startDate: "2026-06-15", anchors: ["bologna"] });
    const monday = planDeterministic(request, ctx).days[0];
    expect(monday?.stops.length).toBeGreaterThanOrEqual(2);
  });
});

describe("meal places another day could still use", () => {
  /** A Rome day at noon with two lunch places, and how many meals each could serve elsewhere. */
  function noonInRome(mealChances?: (id: string) => number) {
    const rome = ctx.anchorById.get("rome");
    const pool = ["place_020", "place_022"].map((id) => ctx.placesById.get(id));
    if (!rome || pool.some((place) => !place)) throw new Error("missing Rome places");
    const walk = startWalk({
      date: "2026-06-20",
      anchor: rome,
      transferMin: 0,
      request: makeRequest({ startDate: "2026-06-20", anchors: ["rome"] }),
      ctx,
      pool: pool as NonNullable<(typeof pool)[number]>[],
      used: new Set(),
      obligations: new Set(),
      ...(mealChances ? { mealChances: (place) => mealChances(place.id) } : {}),
    });
    walk.state.cursor = { ...walk.state.cursor, clock: 12 * 60 };
    return walk;
  }

  it("never spends a place other days could still eat at on a meal a narrower place can seat", () => {
    const first = stepWalk(noonInRome());
    expect(first?.step.role).toBe("lunch");
    const best = first?.place.id; // the better score, when neither has other chances
    const other = best === "place_020" ? "place_022" : "place_020";
    const busy = (id: string) => (id === best ? 4 : 1);
    expect(stepWalk(noonInRome(busy))?.place.id).toBe(other);
  });

  it("never leaves a packed Rome day without dinner by giving its restaurant to an earlier lunch", () => {
    // Taken best-first, day 1's lunch took a place days 2 and 3 could also use, and day 3 of
    // this June trip ended without dinner; least flexible first, every day has both meals.
    const days = planDeterministic(
      makeRequest({ startDate: "2026-06-20", pace: "packed" }),
      ctx,
    ).days;
    for (const day of days) {
      const meals = day.stops.filter((stop) => stop.role !== "visit").map((stop) => stop.role);
      expect(meals, day.date).toEqual(["lunch", "dinner"]);
    }
  });
});

describe("a meal place over the budget", () => {
  /** A fed Florence day at 18:30 at budget 1 whose only meal place is Il Latini, one level over. */
  function fedEvening(mealWanted: boolean) {
    const florence = ctx.anchorById.get("florence");
    const latini = ctx.placesById.get("place_039");
    if (!florence || !latini) throw new Error("missing Florence or Il Latini");
    const input: DayInput = {
      date: "2026-10-20",
      anchor: florence,
      transferMin: 0,
      request: makeRequest({ startDate: "2026-10-20", maxPriceLevel: 1, anchors: ["florence"] }),
      ctx,
      pool: [latini],
      used: new Set(),
      obligations: new Set(),
      mealWanted: () => mealWanted,
    };
    const walk = startWalk(input);
    walk.state.cursor = { ...walk.state.cursor, clock: 1110, first: false, mealsTaken: ["lunch"] };
    walk.state.fed = true;
    return walk;
  }

  it("never lets a fed day take a fallback meal place another day with no meal still needs", () => {
    // Review finding: the hold for a day with no meal applied only within the budget, so day 1
    // at budget 1 in Florence took two places one level over and day 3 had nothing.
    expect(stepWalk(fedEvening(true))).toBeNull();
    expect(stepWalk(fedEvening(false))?.place.id).toBe("place_039");
  });
});
