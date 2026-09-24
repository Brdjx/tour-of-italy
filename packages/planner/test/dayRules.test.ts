import { describe, expect, it } from "vitest";
import { coversMeal, isOuting } from "../src/constraints";
import { latestStartsFor } from "../src/dayLimits";
import {
  closedForHoliday,
  daylightEnd,
  dayRuleBreaks,
  inSatelliteArea,
  keepsDayRules,
  needsDaylight,
} from "../src/dayRules";
import { planDeterministic } from "../src/plan";
import { SUNSET_BY_MONTH } from "../src/planPolicy";
import { withMealsCovered } from "../src/reasons";
import type { Place, StopRole } from "../src/types";
import { makeRequest, realContext, realPlace } from "./plannerFixtures";

// The planner's day rules turn a valid timetable into one a traveler would recognize. Each test
// names the day the review found (a day trip at 17:15, a park at dusk, gelato at 09:40,
// Maranello then Isola della Scala) and proves the rule keeps it out.

const ctx = realContext();
const bologna = { name: "Bologna" };
const at = (hour: number, minute = 0) => hour * 60 + minute;

/** keepsDayRules for one candidate stop on a day so far. */
function keeps(
  place: Place,
  role: StopRole,
  start: number,
  day: { clock?: number; meals?: ("lunch" | "dinner")[]; today?: Place[]; obligation?: boolean },
): boolean {
  return keepsDayRules(
    {
      place,
      role,
      arrive: start,
      start,
      travelMin: 10,
      obligation: day.obligation ?? false,
      latest: undefined,
    },
    {
      clock: day.clock ?? at(9, 30),
      mealsTaken: day.meals ?? [],
      today: day.today ?? [],
      anchor: bologna,
    },
  );
}

describe("outings and meals", () => {
  it("never counts a meal place, or a short visit, as an outing", () => {
    expect(isOuting(realPlace("place_038"))).toBe(true); // Siena, 6 hours
    expect(isOuting(realPlace("place_010"))).toBe(true); // Vatican Museums, 4 hours
    expect(isOuting(realPlace("place_001"))).toBe(false); // Colosseum, 2 hours
    expect(isOuting(realPlace("place_031"))).toBe(false); // a food hall is a meal place
  });

  it("never asks for a lunch stop on a day trip under way for an hour of the lunch window", () => {
    const burano = realPlace("place_070");
    expect(coversMeal(burano, at(9, 5), at(14, 5), "lunch")).toBe(true); // the review's Burano day
    expect(coversMeal(burano, at(13, 35), at(18, 35), "lunch")).toBe(false); // 55 minutes of it
    expect(coversMeal(burano, at(9, 5), at(14, 5), "dinner")).toBe(false);
    expect(coversMeal(realPlace("place_001"), at(11), at(13), "lunch")).toBe(false);
  });

  it("tells the traveler lunch is part of the outing, but only when the day has no lunch stop", () => {
    const siena = realPlace("place_038");
    const stop = { start: at(10, 45), end: at(16, 45), role: "visit" as const };
    expect(withMealsCovered("Historic site in Siena.", siena, stop)).toBe(
      "Historic site in Siena. Lunch is part of this outing.",
    );
    const itinerary = planDeterministic(
      makeRequest({ anchors: ["rome"], startDate: "2026-06-11" }),
      ctx,
    );
    for (const day of itinerary.days) {
      const hasLunch = day.stops.some((s) => s.role === "lunch");
      const says = day.stops.some((s) => s.reason?.includes("Lunch is part of this outing"));
      if (hasLunch) expect(says).toBe(false);
    }
  });
});

describe("the day rules", () => {
  it("never keeps a park or an outdoor experience going after sunset, but lets a viewpoint", () => {
    expect(needsDaylight(realPlace("place_080"))).toBe(true); // Villa Borghese
    expect(needsDaylight(realPlace("place_035"))).toBe(true); // Chianti by bike
    expect(needsDaylight(realPlace("place_077"))).toBe(false); // Trevi Fountain by Night
    expect(daylightEnd(realPlace("place_080"), "2027-01-12")).toBe(SUNSET_BY_MONTH[0]);
    expect(daylightEnd(realPlace("place_077"), "2027-01-12")).toBe(Number.POSITIVE_INFINITY);
  });

  it("never serves gelato before noon", () => {
    const giolitti = realPlace("place_011");
    expect(keeps(giolitti, "visit", at(9, 40), {})).toBe(false);
    expect(keeps(giolitti, "visit", at(15, 15), {})).toBe(true);
  });

  it("never chains out-of-town areas in different directions (Maranello then Isola della Scala)", () => {
    const maranello = realPlace("place_045");
    const isola = realPlace("place_090");
    const modena = realPlace("place_083");
    expect(inSatelliteArea(isola, [maranello], bologna)).toBe(false);
    expect(inSatelliteArea(modena, [maranello], bologna)).toBe(true);
    expect(keeps(isola, "visit", at(15), { clock: at(13), today: [maranello] })).toBe(false);
  });

  it("never leaves town late, for a meal, or for a stop shorter than the trip there", () => {
    const acetaia = realPlace("place_083"); // Modena, 90 minutes, 65 minutes away
    const como = realPlace("place_085"); // Como lakefront, 30 minutes, 65 minutes from Milan
    const parmaLunch = realPlace("place_092"); // Cantina di Parma, lunch only
    expect(keeps(acetaia, "visit", at(15, 15), { clock: at(14) })).toBe(true);
    expect(keeps(acetaia, "visit", at(17, 15), { clock: at(16) })).toBe(false);
    expect(keeps(parmaLunch, "lunch", at(13, 15), { clock: at(11, 20) })).toBe(false);
    const milan = { name: "Milan" };
    const comoStop = { place: como, role: "visit" as const, arrive: at(15, 35), start: at(15, 35) };
    const day = { clock: at(14, 20), mealsTaken: [], today: [], anchor: milan };
    expect(
      keepsDayRules({ ...comoStop, travelMin: 65, obligation: false, latest: undefined }, day),
    ).toBe(false);
  });

  it("never goes back to the base city and out again in one day (Modena, Bologna, Maranello)", () => {
    const modena = realPlace("place_083");
    const maranello = realPlace("place_045");
    const annaMaria = realPlace("place_047"); // lunch in Bologna
    expect(keeps(maranello, "visit", at(15), { clock: at(14), today: [modena] })).toBe(true);
    const backAndOut = { clock: at(14, 15), today: [modena, annaMaria] };
    expect(keeps(maranello, "visit", at(15, 30), backAndOut)).toBe(false);
  });
});

describe("drinks, treats, and holidays", () => {
  const stop = (placeId: string, start: number, end: number) => ({
    placeId,
    start,
    end,
    role: "visit" as const,
    travelFromPrevMin: 10,
  });

  it("never plans an aperitivo before 17:00, whatever its listed hours (Ceresio 7 at 13:00)", () => {
    const ceresio = realPlace("place_065"); // listed Wed-Sun 12:30 to 23:30
    expect(keeps(ceresio, "visit", at(13), {})).toBe(false);
    expect(keeps(ceresio, "visit", at(17), {})).toBe(true);
    expect(keeps(ceresio, "visit", at(13), { obligation: true })).toBe(true);
    const lunchtime = [stop("place_065", at(13, 30), at(15))];
    expect(dayRuleBreaks(lunchtime, [ceresio], "2026-05-27", [])).toEqual([0]);
    expect(dayRuleBreaks(lunchtime, [ceresio], "2026-05-27", ["place_065"])).toEqual([]);
  });

  it("never opens the day with a wine bar before noon (Enoteca al Volto at 10:05)", () => {
    const enoteca = realPlace("place_078");
    expect(keeps(enoteca, "visit", at(10, 5), {})).toBe(false);
    expect(keeps(enoteca, "visit", at(12, 30), { meals: ["lunch"] })).toBe(true);
  });

  it("never plans gelato or a wine bar before lunch, only after it or once lunch is past", () => {
    // Review finding: Gelato at Giolitti at 12:05, then lunch at Mercato Testaccio at 12:55.
    const giolitti = realPlace("place_011");
    expect(keeps(giolitti, "visit", at(12, 5), {})).toBe(false);
    expect(keeps(giolitti, "visit", at(12, 5), { meals: ["lunch"] })).toBe(true);
    expect(keeps(giolitti, "visit", at(14, 30), {})).toBe(true); // no lunch can start later
    expect(keeps(giolitti, "visit", at(12, 5), { obligation: true })).toBe(true);
    const stop = (placeId: string, start: number, role: StopRole) => ({
      placeId,
      start,
      end: start + 30,
      role,
      travelFromPrevMin: 10,
    });
    const testaccio = realPlace("place_015");
    const day = [stop("place_011", at(12, 5), "visit"), stop("place_015", at(12, 55), "lunch")];
    expect(dayRuleBreaks(day, [giolitti, testaccio], "2026-01-06", [])).toEqual([0]);
    expect(dayRuleBreaks(day, [giolitti, testaccio], "2026-01-06", ["place_011"])).toEqual([]);
  });

  it("never plans an ordinary museum on 25 December or 1 January, but keeps a requested one", () => {
    const colosseum = realPlace("place_001");
    expect(closedForHoliday(colosseum, "2026-12-25")).toBe(true);
    expect(closedForHoliday(colosseum, "2027-01-01")).toBe(true);
    expect(closedForHoliday(colosseum, "2026-12-26")).toBe(false);
    expect(closedForHoliday(realPlace("place_018"), "2026-12-25")).toBe(false); // Trevi, open air
    expect(closedForHoliday(realPlace("place_003"), "2026-12-25")).toBe(false); // a restaurant
    const rome = ctx.anchorById.get("rome");
    if (!rome) throw new Error("no Rome base");
    const input = { date: "2026-12-25", pace: "balanced" as const, transferMin: 0 };
    const limits = (mustInclude: string[]) =>
      latestStartsFor({ ...input, origin: rome.centroid, pool: [colosseum], mustInclude });
    expect(limits([]).get("place_001")).toEqual({});
    expect(limits(["place_001"]).get("place_001")?.visit).toBeDefined();
  });
});
