import { describe, expect, it } from "vitest";
import { anchorOfPlace, buildPlannerContext, placesOfAnchor } from "../src/context";
import { realResult } from "./helpers";
import { makePlace, realContext } from "./plannerFixtures";

// The context is shared by every plan in a warm Lambda or an open browser tab. A lookup that
// disagrees with the base list, or a caller that edits it in place, would corrupt every later
// plan, so these tests pin its consistency and its immutability.

describe("buildPlannerContext", () => {
  it("indexes every place and every base, and maps each place to the base that lists it", () => {
    const ctx = realContext();
    expect(ctx.places).toHaveLength(realResult().places.length);
    expect(ctx.placesById.size).toBe(ctx.places.length);
    expect(ctx.anchorById.size).toBe(ctx.anchors.length);
    expect(ctx.anchorIdByPlaceId.size).toBe(ctx.places.length);
    for (const anchor of ctx.anchors) {
      expect(ctx.anchorById.get(anchor.id)).toBe(anchor);
      for (const id of anchor.placeIds) expect(ctx.anchorIdByPlaceId.get(id)).toBe(anchor.id);
    }
    for (const place of ctx.places) expect(ctx.placesById.get(place.id)).toBe(place);
  });

  it("refuses two places with one id, because every lookup would silently pick one", () => {
    const places = [makePlace({ id: "place_1" }), makePlace({ id: "place_1", name: "Other" })];
    expect(() => buildPlannerContext(places)).toThrow(RangeError);
  });

  it("builds an empty context from no places instead of throwing", () => {
    const ctx = buildPlannerContext([]);
    expect(ctx.places).toEqual([]);
    expect(ctx.anchors).toEqual([]);
    expect(ctx.anchorIdByPlaceId.size).toBe(0);
  });

  it("is frozen, so a caller sorting or editing it cannot corrupt the next plan", () => {
    const ctx = realContext();
    const anchor = ctx.anchors[0];
    if (!anchor) throw new Error("expected a base");
    expect(() => (ctx.anchors as unknown[]).push({})).toThrow(TypeError);
    expect(() => (ctx.places as unknown[]).pop()).toThrow(TypeError);
    expect(() => anchor.placeIds.push("place_x")).toThrow(TypeError);
    expect(() => {
      anchor.centroid.lat = 0;
    }).toThrow(TypeError);
    expect(() => {
      (ctx as { places: unknown }).places = [];
    }).toThrow(TypeError);
  });

  it("leaves the caller's array untouched and mutable", () => {
    const places = [makePlace({ id: "b" }), makePlace({ id: "a" })];
    buildPlannerContext(places);
    expect(places.map((p) => p.id)).toEqual(["b", "a"]);
    expect(Object.isFrozen(places)).toBe(false);
    expect(Object.isFrozen(places[0])).toBe(false);
  });
});

describe("context lookups", () => {
  it("never loses a day trip or reorders a base's places", () => {
    const florence = placesOfAnchor(realContext(), "florence");
    expect(florence).toHaveLength(22);
    expect(florence.map((p) => p.id)).toContain("place_038");
    const ids = florence.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("returns no places for an unknown base instead of throwing", () => {
    expect(placesOfAnchor(realContext(), "atlantis")).toEqual([]);
  });

  it("finds the base of a place, and nothing for an unknown place id", () => {
    expect(anchorOfPlace(realContext(), "place_038")?.id).toBe("florence");
    expect(anchorOfPlace(realContext(), "place_999")).toBeUndefined();
  });
});
