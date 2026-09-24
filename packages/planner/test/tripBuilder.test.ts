import { describe, expect, it } from "vitest";
import { transferMinutes } from "../src/anchors";
import { LONG_TRANSFER_MIN, PACE, TRIP_DAYS } from "../src/config";
import { planDeterministic } from "../src/plan";
import { chosenTierGroups } from "../src/planAnchors";
import { TRANSFER_COST } from "../src/planPolicy";
import { addDays, tripDates } from "../src/time";
import { chooseTrip, transferCost } from "../src/tripBuilder";
import type { Itinerary, Pace, TripRequest } from "../src/types";
import { validateItinerary } from "../src/validate";
import { invariantProblems } from "./itineraryInvariants";
import { makeRequest, realContext } from "./plannerFixtures";

// chooseTrip picks the bases and builds the days in turns (tripWalk.ts). The failures these
// tests prevent: a place twice in one trip, a last day left with the scraps, two bases (and a
// three-hour train) for a request one base serves, an over-budget stop a thinner spread avoids,
// and a chosen base dropped because its must-includes all landed on day 1.

const ctx = realContext();

const REGRESSIONS: Partial<TripRequest>[] = [
  {
    startDate: "2027-09-11",
    pace: "packed",
    interests: ["active", "iconic", "splurge", "quiet", "scenic"],
    maxPriceLevel: 4,
    mustInclude: ["place_094", "place_064", "place_083", "place_060"],
    exclude: ["place_011", "place_046"],
  },
  {
    startDate: "2026-01-04",
    interests: ["art"],
    maxPriceLevel: 3,
    mustInclude: ["place_055", "place_073", "place_067", "place_029", "place_069", "place_013"],
    exclude: ["place_051", "place_064", "place_100", "place_011", "place_004"],
  },
];

const errorsOf = (itinerary: Itinerary) =>
  validateItinerary(itinerary, ctx).filter((v) => v.severity === "error");

describe("trips that once repeated a place", () => {
  it.each(REGRESSIONS.map((overrides, n) => [n, makeRequest(overrides)] as const))(
    "request %i: the chosen plan never repeats a place",
    (_n, request) => {
      expect(invariantProblems(planDeterministic(request, ctx), ctx)).toEqual([]);
    },
  );
});

describe("days built in turns", () => {
  const BASES = ["rome", "florence", "milan", "venice", "bologna"];
  const PACES: Pace[] = ["relaxed", "balanced", "packed"];

  it("never leaves the last day with the scraps: days of a trip rarely differ by 4 or more stops", () => {
    // Filled day by day, 40% of single-base trips had a day with 4 or more stops fewer than
    // another (Milan packed in January: 7, 5, then 2 stops and no meal). Built in turns, 3-day
    // trips never do; longer trips in thin bases can still run short on their last day.
    let trips = 0;
    let lopsided = 0;
    for (let offset = 0; offset < 730; offset += 30) {
      for (const pace of PACES) {
        for (const base of BASES) {
          const startDate = addDays("2026-01-01", offset);
          const itinerary = planDeterministic(
            makeRequest({ startDate, pace, anchors: [base] }),
            ctx,
          );
          const counts = itinerary.days.map((day) => day.stops.length);
          trips++;
          if (Math.max(...counts) - Math.min(...counts) >= 4) lopsided++;
          expect(Math.min(...counts), `${base} ${pace} ${startDate}`).toBeGreaterThanOrEqual(1);
        }
      }
    }
    expect(lopsided / trips).toBeLessThan(0.05);
  }, 60_000);

  it("rarely gives one day two meals while another has none where meal places are scarce", () => {
    // Filled day by day, every Milan trip and 57% of Bologna trips did exactly that (the first
    // days ate the few meal places). Scarcity can still force it (a Monday in Bologna has one
    // open lunch place), so this guards the share, measured over a year of start dates.
    let trips = 0;
    let lopsided = 0;
    for (let offset = 0; offset < 365; offset += 7) {
      for (const base of ["milan", "bologna", "venice"]) {
        const startDate = addDays("2026-01-01", offset);
        const itinerary = planDeterministic(makeRequest({ startDate, anchors: [base] }), ctx);
        const fed = itinerary.days.map((day) => day.stops.filter((s) => s.role !== "visit").length);
        trips++;
        if (fed.includes(0) && fed.includes(2)) lopsided++;
      }
    }
    expect(lopsided / trips).toBeLessThan(0.1);
  }, 60_000);
});

describe("choosing bases", () => {
  it("never splits a plain request over two bases, at any pace", () => {
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      for (const startDate of ["2026-01-10", "2026-06-10", "2026-10-06", "2027-05-10"]) {
        const itinerary = planDeterministic(makeRequest({ startDate, pace }), ctx);
        expect(new Set(itinerary.days.map((d) => d.anchorId)).size, `${pace} ${startDate}`).toBe(1);
      }
    }
  });

  it("still moves to a second base that holds a must-include, and pays for the move", () => {
    const itinerary = planDeterministic(
      makeRequest({ mustInclude: ["place_001", "place_026"] }),
      ctx,
    );
    expect(new Set(itinerary.days.map((d) => d.anchorId))).toEqual(new Set(["rome", "florence"]));
    expect(errorsOf(itinerary)).toEqual([]);
  });

  it("never lets a move look free: a fixed cost plus a cost per hour on the train", () => {
    expect(transferCost(["rome", "rome", "rome"], ctx)).toBe(0);
    const florence = ctx.anchorById.get("florence");
    const rome = ctx.anchorById.get("rome");
    if (!florence || !rome) throw new Error("missing base");
    const hours = transferMinutes(florence, rome) / 60;
    expect(transferCost(["florence", "rome", "rome"], ctx)).toBeCloseTo(
      TRANSFER_COST.perMove + TRANSFER_COST.perHour * hours,
    );
  });

  it("never puts a relaxed trip on a train over 3 hours unless a must-include needs it", () => {
    for (const startDate of ["2026-01-10", "2026-06-10", "2026-10-06"]) {
      for (const interests of [[], ["wine"], ["art"], ["food", "views"]]) {
        const itinerary = planDeterministic(
          makeRequest({ startDate, pace: "relaxed", interests }),
          ctx,
        );
        const long = itinerary.days.filter((day) => day.transferMin > LONG_TRANSFER_MIN);
        expect(long, `${startDate} ${interests.join(",")}`).toEqual([]);
      }
    }
  });

  it("never lets the first-listed base win a 1-day trip whose must-include is at the second", () => {
    // Latent with TRIP_DAYS = 3, real with a 1-day trip: the in-order tier held only the first
    // chosen base, so Burano (Venice) was lost with an error.
    const request = makeRequest({
      startDate: "2027-07-28",
      anchors: ["milan", "venice"],
      mustInclude: ["place_070"],
    });
    const oneDay = [request.startDate];
    const [first] = chosenTierGroups(request, ctx, oneDay);
    expect(first?.[0]).toEqual([["milan"], ["venice"]]);
    expect(chooseTrip(request, ctx, oneDay)?.anchorIds).toEqual(["venice"]);
  });
});

describe("spreading a thin base", () => {
  it("never leaves the chosen base when its must-includes could spread over the days", () => {
    // The review's repro: four Milan must-includes all went on day 1 and days 2 and 3 moved to
    // Rome (a 215-minute transfer), although a plan staying in Milan validates.
    const request = makeRequest({
      startDate: "2026-12-09",
      maxPriceLevel: 1,
      anchors: ["milan"],
      mustInclude: ["place_086", "place_094", "place_055", "place_098"],
      exclude: ["place_102", "place_060"],
    });
    const itinerary = planDeterministic(request, ctx);
    expect(itinerary.days.map((day) => day.anchorId)).toEqual(Array(TRIP_DAYS).fill("milan"));
    const placed = itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
    expect(placed).toEqual(expect.arrayContaining(request.mustInclude));
    expect(itinerary.warnings.some((w) => w.code === "ANCHOR_NOT_CHOSEN")).toBe(false);
    expect(errorsOf(itinerary)).toEqual([]);
  });

  it("never leaves the chosen base when a must-include could move to the one day it fits", () => {
    // Property counterexample: the walk put Galleria Vittorio Emanuele (a must-include) on the
    // Saturday, the Monday could hold nothing else, and the plan moved a day to Florence.
    const request = makeRequest({
      startDate: "2026-06-06",
      pace: "relaxed",
      maxPriceLevel: 1,
      anchors: ["milan"],
      mustInclude: ["place_060"],
      exclude: ["place_102", "place_082", "place_098"],
    });
    const itinerary = planDeterministic(request, ctx);
    expect(itinerary.days.map((day) => day.anchorId)).toEqual(Array(TRIP_DAYS).fill("milan"));
    const placed = itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
    expect(placed).toContain("place_060");
    // Since a relaxed day may end with the 3-hour aperitivo walk as dinner, the Monday has that
    // instead of the Galleria; either way no day is empty and the base stays.
    for (const day of itinerary.days) expect(day.stops.length, day.date).toBeGreaterThan(0);
    expect(errorsOf(itinerary)).toEqual([]);
  });

  it("never plans more visits a day than the pace allows while spreading", () => {
    const itinerary = planDeterministic(makeRequest({ anchors: ["rome"], pace: "packed" }), ctx);
    for (const day of itinerary.days) {
      const visits = day.stops.filter((stop) => stop.role === "visit").length;
      expect(visits).toBeLessThanOrEqual(PACE.packed.maxVisits);
    }
    expect(tripDates(itinerary.request.startDate)).toHaveLength(TRIP_DAYS);
  });
});

describe("automatic bases", () => {
  const PACES: Record<string, readonly Pace[]> = {
    art: ["relaxed", "balanced", "packed"],
    wine: ["balanced", "packed"],
  };
  it.each([["art"], ["wine"]])(
    "never ignores the base that clearly fits the interests (%s goes to Florence)",
    (interest) => {
      const paces = PACES[interest] ?? [];
      // Review finding: automatic choice is mostly Rome, which has the most places. Where the
      // data gives one base a clear lead for an interest, that base must still win.
      // Decision: not wine at a relaxed pace. With DINNER_RETURN_GRACE_MIN, Venice's 3-hour
      // cicchetti crawl (wine, 4.8) fits a relaxed day: three wine places is a fair choice.
      const cases = [
        ["2026-05-12", "relaxed"],
        ["2026-10-20", "balanced"],
        ["2027-02-09", "packed"],
      ] as const;
      for (const [startDate, pace] of cases.filter(([, p]) => paces.includes(p))) {
        const request = makeRequest({ startDate, pace, interests: [interest] });
        const itinerary = planDeterministic(request, ctx);
        expect(itinerary.days[0]?.anchorId, `${startDate} ${pace}`).toBe("florence");
      }
    },
  );
});
