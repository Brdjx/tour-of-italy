import { openStatusOn, TRIP_DAYS, TripRequestSchema, tripDates } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import { buildShortlist, SHORTLIST } from "../../src/plan/candidates";
import { START_DATE } from "../helpers/app";

// The shortlist is the model's whole world: anything not on it is rejected later. It must hold
// only places that could really be visited, and always the traveler's must-includes.

const { ctx } = shippedData();

function request(overrides: Record<string, unknown> = {}) {
  return TripRequestSchema.parse({ startDate: START_DATE, pace: "balanced", ...overrides });
}

describe("buildShortlist", () => {
  it("offers at most four bases when the traveler lets the planner choose", () => {
    const shortlist = buildShortlist(request(), ctx);

    expect(shortlist.options.length).toBeGreaterThan(0);
    expect(shortlist.options.length).toBeLessThanOrEqual(SHORTLIST.maxAnchorOptions);
  });

  it("offers exactly the traveler's bases, in their order, when they chose some", () => {
    const shortlist = buildShortlist(request({ anchors: ["venice", "florence"] }), ctx);

    expect(shortlist.options.map((o) => o.anchor.id)).toEqual(["venice", "florence"]);
  });

  it("never offers an excluded place", () => {
    const excluded = ctx.anchorById.get("rome")?.placeIds.slice(0, 5) ?? [];

    const shortlist = buildShortlist(request({ anchors: ["rome"], exclude: excluded }), ctx);

    for (const id of excluded) expect(shortlist.placeIds.has(id)).toBe(false);
  });

  it("never offers a place closed on every trip date", () => {
    const dates = tripDates(START_DATE);
    const shortlist = buildShortlist(request(), ctx);

    for (const option of shortlist.options) {
      for (const candidate of option.candidates) {
        const states = dates.map((date) => openStatusOn(candidate.place, date).state);
        expect(states.every((state) => state === "closed")).toBe(false);
      }
    }
  });

  it("never offers a place outside its base", () => {
    const shortlist = buildShortlist(request(), ctx);

    for (const option of shortlist.options) {
      for (const candidate of option.candidates) {
        expect(ctx.anchorIdByPlaceId.get(candidate.place.id)).toBe(option.anchor.id);
      }
    }
  });

  it("never offers a place above the budget unless the traveler asked for it", () => {
    const shortlist = buildShortlist(request({ maxPriceLevel: 1 }), ctx);

    for (const option of shortlist.options) {
      for (const candidate of option.candidates) {
        const level = candidate.place.priceLevel;
        expect(level === null || level <= 1 || candidate.mustInclude).toBe(true);
      }
    }
  });

  it("never offers a low-rated place the traveler did not ask for", () => {
    const shortlist = buildShortlist(request({ anchors: ["rome"] }), ctx);
    const low = ctx.places.filter((p) => p.rating !== null && p.rating < 3.5).map((p) => p.id);

    expect(low.length).toBeGreaterThan(0);
    for (const id of low) expect(shortlist.placeIds.has(id)).toBe(false);
  });

  it("always offers a must-include place that can be visited, and puts its base first", () => {
    const venicePlace = ctx.anchorById.get("venice")?.placeIds.find((id) => {
      const place = ctx.placesById.get(id);
      return place !== undefined && !place.mealCapable && (place.rating ?? 5) >= 3.5;
    });
    if (!venicePlace) throw new Error("no Venice place");

    const shortlist = buildShortlist(request({ mustInclude: [venicePlace] }), ctx);

    expect(shortlist.placeIds.has(venicePlace)).toBe(true);
    expect(shortlist.options[0]?.anchor.id).toBe("venice");
    expect(shortlist.mustInclude).toEqual([venicePlace]);
  });

  it("keeps each base to the top visits and meals, plus must-includes", () => {
    const shortlist = buildShortlist(request({ anchors: ["rome"] }), ctx);
    const rome = shortlist.options[0];

    expect(rome?.candidates.filter((c) => !c.meal).length).toBeLessThanOrEqual(
      SHORTLIST.visitsPerAnchor,
    );
    expect(rome?.candidates.filter((c) => c.meal).length).toBeLessThanOrEqual(
      SHORTLIST.mealsPerAnchor,
    );
    expect(rome?.candidates.some((c) => c.meal)).toBe(true);
  });

  it("is deterministic, so the same request always builds the same prompt", () => {
    const a = buildShortlist(request({ interests: ["art"] }), ctx);
    const b = buildShortlist(request({ interests: ["art"] }), ctx);

    expect([...a.placeIds]).toEqual([...b.placeIds]);
  });

  it("records each candidate's status on every trip date", () => {
    const shortlist = buildShortlist(request(), ctx);

    for (const option of shortlist.options) {
      for (const candidate of option.candidates) {
        expect(candidate.statuses).toHaveLength(TRIP_DAYS);
      }
    }
  });
});
