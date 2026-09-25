import {
  isCandidate,
  openStatusOn,
  sharesLocation,
  TRIP_DAYS,
  TripRequestSchema,
  tripDates,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import { buildShortlist, SHORTLIST, shortlistSize } from "../../src/plan/candidates";
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

  it("never offers a place that cannot be a day's only stop on any trip date, unless asked for", () => {
    // Osteria Francescana's dinner in Modena ends at 22:00, 65 minutes from Bologna: past a
    // balanced day's last return at 23:00, but inside a packed day's.
    const francescana = "place_043";
    const bologna = (overrides: Record<string, unknown>) =>
      buildShortlist(request({ startDate: "2026-10-09", anchors: ["bologna"], ...overrides }), ctx);

    expect(bologna({}).placeIds.has(francescana)).toBe(false);
    expect(bologna({ pace: "packed" }).placeIds.has(francescana)).toBe(true);
    expect(bologna({ mustInclude: [francescana] }).placeIds.has(francescana)).toBe(true);
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

  it("sizes a base for a whole trip there: each day's visits at the pace plus two, and two meals a day plus one", () => {
    expect(shortlistSize("relaxed")).toEqual({ visits: 12, meals: 7 });
    expect(shortlistSize("balanced")).toEqual({ visits: 17, meals: 7 });
    expect(shortlistSize("packed")).toEqual({ visits: 23, meals: 7 });
  });

  it("offers the best visits until enough are open every trip day, one per spot", () => {
    // Friday 9 to Sunday 11 October 2026 in Rome, the owner's failed request. The Vatican Museums
    // and one other visit are closed on the Sunday, and the Trevi Fountain by night shares the
    // fountain's spot: they are offered but do not count, so 20 visits are offered for 17.
    const shortlist = buildShortlist(request({ startDate: "2026-10-09", anchors: ["rome"] }), ctx);
    const visits = shortlist.options[0]?.candidates.filter((c) => !c.meal) ?? [];
    const everyDay = visits.filter((c) => c.statuses.every((status) => status.kind !== "closed"));
    const spots = everyDay.filter(
      (c, i) => !everyDay.slice(0, i).some((other) => sharesLocation(other.place, c.place)),
    );

    expect(visits).toHaveLength(20);
    expect(spots).toHaveLength(shortlistSize("balanced").visits);
    expect(visits.map((c) => c.place.id)).toEqual(
      expect.arrayContaining(["place_010", "place_018", "place_077"]),
    );
    const scores = visits.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("offers every visit and meal place a base has when a whole trip there could use them", () => {
    const req = request({ startDate: "2026-10-09", anchors: ["rome"], pace: "packed" });
    const rome = buildShortlist(req, ctx).options[0]?.candidates ?? [];
    const eligible = (ctx.anchorById.get("rome")?.placeIds ?? [])
      .map((id) => ctx.placesById.get(id))
      .filter((place) => place !== undefined && isCandidate(place, req, "rome", ctx));

    expect(rome.filter((c) => !c.meal)).toHaveLength(
      eligible.filter((p) => !p?.mealCapable).length,
    );
    expect(rome.filter((c) => c.meal)).toHaveLength(eligible.filter((p) => p?.mealCapable).length);
  });

  it("still offers every must-include beyond the size", () => {
    const low = buildShortlist(request({ anchors: ["rome"], pace: "relaxed" }), ctx);
    const offered = new Set(low.placeIds);
    const extra = (ctx.anchorById.get("rome")?.placeIds ?? []).find((id) => {
      const place = ctx.placesById.get(id);
      return (
        place !== undefined && !place.mealCapable && !offered.has(id) && (place.rating ?? 5) >= 3.5
      );
    });
    if (!extra) throw new Error("no Rome place left off the relaxed shortlist");

    const asked = buildShortlist(
      request({ anchors: ["rome"], pace: "relaxed", mustInclude: [extra] }),
      ctx,
    );

    expect(asked.placeIds.has(extra)).toBe(true);
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
