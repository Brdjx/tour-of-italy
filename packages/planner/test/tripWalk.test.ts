import { describe, expect, it } from "vitest";
import { coversMeal } from "../src/constraints";
import { type DayInput, startWalk, stepWalk } from "../src/dayBuilder";
import { planDeterministic } from "../src/plan";
import { OUTING_LATEST_START } from "../src/planPolicy";
import { scheduleDay } from "../src/schedule";
import { tripDates } from "../src/time";
import { buildTrip, chooseTrip, mistimedMustIncludes, type TripDraft } from "../src/tripBuilder";
import type { TripRequest } from "../src/types";
import { makeRequest, realContext } from "./plannerFixtures";

// The walk takes turns between days (tripWalk.ts) and the trip builder compares arrangements of
// bases (tripBuilder.ts). The failures these tests prevent: a day that stops for good while a
// meal place it could use is only held for another day, a must-include that other days could
// hold blocking one that only today can hold, and an arrangement that sends a requested day
// trip out in the afternoon when another keeps it in the morning.

const ctx = realContext();
const VENICE = ["venice", "venice", "venice"];

/** Each day of a draft timed on its own base, with no transfer (single-base drafts only). */
function timed(draft: TripDraft, request: TripRequest) {
  const dates = tripDates(request.startDate);
  return draft.days.map((ids, index) => {
    const anchor = ctx.anchorById.get(draft.anchorIds[index] ?? "");
    if (!anchor) throw new Error("unknown base");
    return scheduleDay(ids, dates[index] ?? "", anchor, request, ctx, 0);
  });
}

describe("turns between days", () => {
  const REPROS: [Partial<TripRequest>, string][] = [
    [{ startDate: "2027-01-12" }, "place_073"], // review case 04: day 3 had no dinner
    [{ startDate: "2026-07-20", pace: "packed", interests: ["views", "romantic"] }, "place_073"],
  ];

  it.each(REPROS)(
    "never ends a day for good on a meal place that was only held for another day (%o)",
    (overrides, freedPlace) => {
      const request = makeRequest(overrides);
      const built = buildTrip(
        VENICE,
        { ...request, anchors: ["venice"] },
        ctx,
        tripDates(request.startDate),
      );
      if (!built) throw new Error("no trip");
      const days = timed(built, request);
      for (const day of days) {
        expect(day.stops.some((stop) => stop.role === "dinner")).toBe(true);
      }
      const seated = days.flatMap((day) => day.stops).find((s) => s.placeId === freedPlace);
      expect(seated?.role).toBe("dinner");
    },
  );
});

describe("must-include timing", () => {
  it("never lets a must-include open on every day push one open on a single day past noon", () => {
    // Review repro: Torre degli Asinelli (all three days) went first at 09:35 and pushed the
    // Parma tour (Friday only, "weekday mornings") to 12:15.
    const request = makeRequest({
      startDate: "2027-04-16",
      anchors: ["bologna"],
      mustInclude: ["place_053", "place_048"],
    });
    const itinerary = planDeterministic(request, ctx);
    const stops = itinerary.days.flatMap((day) => day.stops);
    const parma = stops.find((stop) => stop.placeId === "place_053");
    expect(parma?.start).toBeLessThanOrEqual(OUTING_LATEST_START);
    expect(stops.some((stop) => stop.placeId === "place_048")).toBe(true);
  });

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
      // Review finding: 0 of 312 Sunday starts had the Vatican (closed Sundays, an outing that
      // starts by noon). Monday and Tuesday each counted on the other and gave both mornings to
      // sights open all week.
      for (const startDate of ["2026-10-11", "2027-02-14", "2027-06-27"]) {
        const request = makeRequest({ startDate, pace, anchors: ["rome"] });
        const ids = planDeterministic(request, ctx).days.flatMap((d) =>
          d.stops.map((s) => s.placeId),
        );
        expect(ids, `${startDate} ${pace}`).toContain("place_010");
      }
    },
  );

  it("never lets a morning sight's last chance beat a clearly better pick or an afternoon one", () => {
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

  it("never spends the lunch hours of a Bologna Monday on a museum when a day trip keeps lunch", () => {
    // Review finding: at 10:00 the only lunch (Via Drapperie at noon) was no option yet, so lunch
    // was no promise, and the Ferrari Museum ran from 11:00 to 13:30 with no lunch that day.
    const request = makeRequest({
      startDate: "2026-04-27",
      pace: "packed",
      maxPriceLevel: 2,
      anchors: ["bologna"],
    });
    for (const day of planDeterministic(request, ctx).days) {
      const lunch = day.stops.some((stop) => {
        const place = ctx.placesById.get(stop.placeId);
        return stop.role === "lunch" || (place && coversMeal(place, stop.start, stop.end, "lunch"));
      });
      expect(lunch, day.date).toBe(true);
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
      otherChances: () => 0,
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
    const held = fedEvening(true);
    expect(stepWalk(held)).toBeNull();
    expect(held.heldBack).toBe(true);
    expect(stepWalk(fedEvening(false))?.place.id).toBe("place_039");
  });
});
