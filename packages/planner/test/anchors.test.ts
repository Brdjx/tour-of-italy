import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildAnchors, transferMinutes } from "../src/anchors";
import { DAY_TRIP_MAX_KM, LONG_TRANSFER_MIN } from "../src/config";
import { AnchorSchema } from "../src/dataSchemas";
import { haversineKm, medianCentroid } from "../src/normalize/geo";
import { travelLabel } from "../src/travel";
import type { Anchor } from "../src/types";
import { realResult } from "./helpers";
import { FC_SETTINGS, realContext } from "./plannerFixtures";

// Bases decide which places a day may visit (violation OUTSIDE_ANCHOR). A place in the wrong base,
// in two bases, or in none would let the planner send a traveler 300 km on a "day trip" or hide
// a place for good. These tests pin the real grouping and the rules behind it.

const BASE_CITIES = ["Rome", "Florence", "Milan", "Venice", "Bologna"];

function anchor(id: string): Anchor {
  const found = realContext().anchorById.get(id);
  if (!found) throw new Error(`No base ${id}`);
  return found;
}

describe("bases on the real data", () => {
  it("makes exactly the five cities with enough places into bases, largest first", () => {
    const anchors = realContext().anchors;
    expect(anchors.map((a) => a.id)).toEqual(["rome", "florence", "milan", "venice", "bologna"]);
    expect(anchors.map((a) => a.region)).toEqual([
      "Lazio",
      "Tuscany",
      "Lombardy",
      "Veneto",
      "Emilia-Romagna",
    ]);
    expect(anchors.map((a) => a.placeIds.length)).toEqual([30, 22, 18, 17, 16]);
  });

  it.each([
    ["place_038", "florence"], // Siena
    ["place_089", "florence"], // Pienza
    ["place_043", "bologna"], // Modena
    ["place_044", "bologna"], // Modena
    ["place_083", "bologna"], // Modena
    ["place_045", "bologna"], // Maranello
    ["place_053", "bologna"], // Parma
    ["place_092", "bologna"], // Parma
    ["place_090", "bologna"], // Isola della Scala
    ["place_085", "milan"], // Como
    ["place_063", "milan"], // Bellagio
    ["place_064", "milan"], // Lenno
    ["place_070", "venice"], // Burano
    ["place_095", "venice"], // Padua
  ])("attaches day-trip place %s to %s, its nearest base", (placeId, anchorId) => {
    expect(realContext().anchorIdByPlaceId.get(placeId)).toBe(anchorId);
  });

  it("puts every place in exactly one base, so no place is orphaned or offered twice", () => {
    const ids = realContext().anchors.flatMap((a) => a.placeIds);
    const placeIds = realResult().places.map((p) => p.id);
    expect(ids).toHaveLength(placeIds.length);
    expect(new Set(ids)).toEqual(new Set(placeIds));
  });

  it("keeps every place in a base city in that city's base, whatever is nearer", () => {
    for (const place of realResult().places) {
      if (!BASE_CITIES.includes(place.city)) continue;
      expect(realContext().anchorIdByPlaceId.get(place.id)).toBe(place.city.toLowerCase());
    }
  });

  it("attaches each day-trip place within DAY_TRIP_MAX_KM and to no farther base than another", () => {
    const anchors = realContext().anchors;
    for (const place of realResult().places) {
      if (BASE_CITIES.includes(place.city)) continue;
      const own = anchor(realContext().anchorIdByPlaceId.get(place.id) ?? "");
      const ownKm = haversineKm(place, own.centroid);
      expect(ownKm).toBeLessThanOrEqual(DAY_TRIP_MAX_KM);
      for (const other of anchors)
        expect(ownKm).toBeLessThanOrEqual(haversineKm(place, other.centroid));
    }
  });

  it("centres each base on its own city's places, so day trips cannot drag it off", () => {
    for (const city of BASE_CITIES) {
      const own = realResult().places.filter((p) => p.city === city);
      expect(anchor(city.toLowerCase()).centroid).toEqual(medianCentroid(own));
    }
  });

  it("produces bases the API schema accepts", () => {
    for (const base of realContext().anchors) expect(AnchorSchema.parse(base)).toEqual(base);
  });

  it("gives the same bases for any order of the input places", () => {
    const places = realResult().places;
    const expected = buildAnchors(places);
    fc.assert(
      fc.property(fc.shuffledSubarray([...places], { minLength: places.length }), (shuffled) => {
        expect(buildAnchors(shuffled)).toEqual(expected);
      }),
      { ...FC_SETTINGS, numRuns: 50 },
    );
  });
});

describe("transferMinutes", () => {
  it("costs nothing when the base does not change", () => {
    expect(transferMinutes(anchor("rome"), anchor("rome"))).toBe(0);
  });

  it.each([
    ["rome", "florence", 130, "2 h 10 min by high-speed train"],
    ["bologna", "florence", 100, "1 h 40 min by train or car"],
    ["milan", "venice", 135, "2 h 15 min by high-speed train"],
  ])("moves %s to %s in %s min (%s)", (from, to, minutes, label) => {
    expect(transferMinutes(anchor(from), anchor(to))).toBe(minutes);
    expect(travelLabel(anchor(from).centroid, anchor(to).centroid)).toBe(label);
  });

  it("is the same in both directions for every pair of bases", () => {
    for (const a of realContext().anchors) {
      for (const b of realContext().anchors)
        expect(transferMinutes(a, b)).toBe(transferMinutes(b, a));
    }
  });

  it("flags Rome to Milan and Rome to Venice as long transfers but not Bologna to Florence", () => {
    expect(transferMinutes(anchor("rome"), anchor("milan"))).toBeGreaterThan(LONG_TRANSFER_MIN);
    expect(transferMinutes(anchor("rome"), anchor("venice"))).toBeGreaterThan(LONG_TRANSFER_MIN);
    expect(transferMinutes(anchor("bologna"), anchor("florence"))).toBeLessThanOrEqual(
      LONG_TRANSFER_MIN,
    );
  });
});
