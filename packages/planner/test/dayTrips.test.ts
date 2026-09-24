import { describe, expect, it } from "vitest";
import { isOuting } from "../src/constraints";
import { planDeterministic } from "../src/plan";
import type { TripRequest } from "../src/types";
import { makeRequest, realContext } from "./plannerFixtures";

// Day trips (Siena, Chianti by bike, Parma, the October risotto festival) are why many travelers
// pick a base. The failures these tests prevent: a traveler whose interests match a day trip
// never getting one, and a traveler with no stated interests sent out of town ahead of the
// headline sights of the city they chose.

const ctx = realContext();

/** Ids of the outings (day trips, a long bike ride) in the plan for the request. */
function dayTripsIn(request: TripRequest): string[] {
  const itinerary = planDeterministic(request, ctx);
  const ids = itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
  return ids.filter((id) => {
    const place = ctx.placesById.get(id);
    return place !== undefined && isOuting(place);
  });
}

describe("day trips", () => {
  it("never leaves out a day trip that matches the traveler's interests (Chianti in September)", () => {
    const request = makeRequest({
      startDate: "2026-09-15",
      interests: ["wine", "outdoors"],
      anchors: ["florence"],
    });
    expect(dayTripsIn(request).some((id) => id === "place_035" || id === "place_038")).toBe(true);
  });

  it("never leaves a food lover in Bologna in October without Parma or the risotto festival", () => {
    const request = makeRequest({
      startDate: "2026-10-06",
      interests: ["food"],
      anchors: ["bologna"],
    });
    expect(dayTripsIn(request).some((id) => id === "place_053" || id === "place_090")).toBe(true);
  });

  it.each(["florence", "venice", "milan"])(
    "never sends a traveler with no stated interests out of %s ahead of its headline sights",
    (anchor) => {
      const request = makeRequest({ startDate: "2026-06-09", anchors: [anchor] });
      expect(dayTripsIn(request)).toEqual([]);
    },
  );
});
