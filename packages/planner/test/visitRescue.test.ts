import { describe, expect, it } from "vitest";
import { TRIP_DAYS } from "../src/config";
import { repairMustIncludes } from "../src/mustRepair";
import { planDeterministic } from "../src/plan";
import { tripDates } from "../src/time";
import type { Itinerary, TripRequest } from "../src/types";
import { validateItinerary } from "../src/validate";
import { makeRequest, realContext } from "./plannerFixtures";

// A day with a meal and no visit (visitRescue.ts). The failure this prevents: a day that is a
// 12:00 lunch and nothing else, while a free public space of the base city stays unused, worse
// off than an empty day, which the rescue would already have given one.

const ctx = realContext();

const visits = (itinerary: Itinerary) =>
  itinerary.days.map((day) => day.stops.filter((stop) => stop.role === "visit").length);

function errorsOf(itinerary: Itinerary) {
  return validateItinerary(itinerary, ctx).filter((v) => v.severity === "error");
}

describe("a day with meals and no visit", () => {
  it("never leaves a Milan day at budget 1 as a lone lunch while the Galleria stays unused", () => {
    // Review case 07b: day 3 was a 12:00 lunch after a 145-minute wait, back at 13:45.
    const request = makeRequest({ startDate: "2026-10-06", maxPriceLevel: 1, anchors: ["milan"] });
    const itinerary = planDeterministic(request, ctx);
    expect(visits(itinerary)).not.toContain(0);
    const placed = itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
    expect(placed).toContain("place_060");
    expect(errorsOf(itinerary)).toEqual([]);
  });

  it.each([
    [{ startDate: "2027-03-02", maxPriceLevel: 1, anchors: ["milan"] }],
    [{ startDate: "2026-11-17", pace: "relaxed", maxPriceLevel: 1, anchors: ["milan"] }],
  ] as Partial<TripRequest>[][])(
    "never leaves a budget Milan day with a meal and no visit when one can be added (%o)",
    (overrides) => {
      const itinerary = planDeterministic(makeRequest(overrides), ctx);
      for (const [index, count] of visits(itinerary).entries()) {
        const stops = itinerary.days[index]?.stops.length ?? 0;
        if (stops > 0) expect(count, itinerary.days[index]?.date).toBeGreaterThan(0);
      }
      expect(errorsOf(itinerary)).toEqual([]);
    },
  );
});

describe("a requested dinner inserted by the repair", () => {
  it("never empties a Venice day before 19:00 to fit a requested cicchetti crawl", () => {
    // Property counterexample: tried from the start of the day, the crawl went first (a dinner at
    // 19:00) and every morning stop was removed to make room; appended, it removes nothing.
    const request = makeRequest({
      startDate: "2027-02-16",
      anchors: ["venice"],
      mustInclude: ["place_068"],
    });
    const day = ["place_074", "place_067", "place_076", "place_091"];
    const draft = { anchorIds: ["venice", "venice", "venice"], days: [day, [], []], score: 0 };
    const repaired = repairMustIncludes(draft, request, ctx, tripDates(request.startDate));
    expect(repaired.days[0]).toEqual([...day, "place_068"]);
  });
});

describe("an empty day of the chosen base", () => {
  it("never leaves the chosen base when a must-include can move to the one day nothing else fills", () => {
    // Milan at budget 1 with six places excluded: the Monday can hold nothing but the requested
    // Como lakefront, so the walk's day for it gives it up and Milan stays the base every day.
    const request = makeRequest({
      startDate: "2027-08-21",
      pace: "relaxed",
      maxPriceLevel: 1,
      anchors: ["milan"],
      mustInclude: ["place_085"],
      exclude: ["place_064", "place_082", "place_100", "place_098", "place_058", "place_055"],
    });
    const itinerary = planDeterministic(request, ctx);
    expect(itinerary.days.map((day) => day.anchorId)).toEqual(Array(TRIP_DAYS).fill("milan"));
    expect(itinerary.days[2]?.stops.map((stop) => stop.placeId)).toEqual(["place_085"]);
    expect(errorsOf(itinerary)).toEqual([]);
  });
});
