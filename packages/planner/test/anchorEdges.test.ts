import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { anchorSlug, buildAnchors } from "../src/anchors";
import { DAY_TRIP_MAX_KM, MIN_PLACES_FOR_BASE } from "../src/config";
import { IdSchema } from "../src/dataSchemas";
import { haversineKm } from "../src/normalize/geo";
import { UNKNOWN_CITY } from "../src/normalize/locations";
import type { Anchor } from "../src/types";
import { realResult } from "./helpers";
import { FC_SETTINGS, italyPoint, makePlace, northOf, realContext } from "./plannerFixtures";

// Base rules on data the real file does not have: places far from every base, the exact
// DAY_TRIP_MAX_KM edge, the "Unknown city" placeholder, ties, and hostile city names. A wrong
// answer here orphans a place, sends a traveler on a 400 km "day trip", or gives two bases one id.

function anchor(id: string): Anchor {
  const found = realContext().anchorById.get(id);
  if (!found) throw new Error(`No base ${id}`);
  return found;
}

describe("bases for data the real file lacks", () => {
  const real = () => realResult().places;
  const rome = () => anchor("rome").centroid;

  it("makes a place far from every base (Palermo) a base of its own instead of a 400 km day trip", () => {
    const palermo = makePlace({
      id: "place_pa",
      city: "Palermo",
      region: "Sicily",
      lat: 38.1157,
      lng: 13.3615,
    });
    const anchors = buildAnchors([...real(), palermo]);
    const own = anchors.find((a) => a.placeIds.includes("place_pa"));
    expect(own).toEqual({
      id: "palermo",
      name: "Palermo",
      region: "Sicily",
      centroid: { lat: 38.1157, lng: 13.3615 },
      placeIds: ["place_pa"],
    });
    expect(anchors).toHaveLength(6);
  });

  it("attaches a place 119.9 km from a base and makes one 120.1 km away its own base", () => {
    const near = makePlace({
      id: "place_near",
      city: "Near",
      ...northOf(rome(), -(DAY_TRIP_MAX_KM - 0.1)),
    });
    const far = makePlace({
      id: "place_far",
      city: "Far",
      ...northOf(rome(), -(DAY_TRIP_MAX_KM + 0.1)),
    });
    const anchors = buildAnchors([...real(), near, far]);
    expect(anchors.find((a) => a.id === "rome")?.placeIds).toContain("place_near");
    expect(anchors.find((a) => a.id === "far")?.placeIds).toEqual(["place_far"]);
  });

  it("groups far places of one city into one base rather than one base per place", () => {
    const naples = [
      makePlace({ id: "place_na1", city: "Naples", region: "Campania", lat: 40.85, lng: 14.27 }),
      makePlace({ id: "place_na2", city: "Naples", region: "Campania", lat: 40.84, lng: 14.25 }),
    ];
    const own = buildAnchors([...real(), ...naples]).find((a) => a.id === "naples");
    expect(own?.placeIds).toEqual(["place_na1", "place_na2"]);
  });

  it("never makes the Unknown city placeholder a base, however many places share it", () => {
    const nearRome = Array.from({ length: MIN_PLACES_FOR_BASE }, (_, index) =>
      makePlace({ id: `place_u${index}`, city: UNKNOWN_CITY, ...northOf(rome(), 5) }),
    );
    const sardinia = makePlace({
      id: "place_sa",
      name: "Nuraghe",
      city: UNKNOWN_CITY,
      lat: 40.1,
      lng: 9.0,
    });
    const sicily = makePlace({
      id: "place_si",
      name: "Etna Hike",
      city: UNKNOWN_CITY,
      lat: 37.7,
      lng: 15.0,
    });
    const anchors = buildAnchors([...real(), ...nearRome, sardinia, sicily]);
    expect(anchors.find((a) => a.id === "rome")?.placeIds).toContain("place_u0");
    expect(anchors.find((a) => a.id === "unknown-city")).toBeUndefined();
    expect(anchors.find((a) => a.id === "nuraghe")?.placeIds).toEqual(["place_sa"]);
    expect(anchors.find((a) => a.id === "etna-hike")?.placeIds).toEqual(["place_si"]);
  });

  it("still gives every place a base when no city has enough places", () => {
    const small = [
      makePlace({ id: "a1", city: "Asti", region: "Piedmont", lat: 44.9, lng: 8.2 }),
      makePlace({ id: "l1", city: "Lecce", region: "Apulia", lat: 40.35, lng: 18.17 }),
      makePlace({ id: "l2", city: "Lecce", region: "Apulia", lat: 40.36, lng: 18.18 }),
    ];
    const anchors = buildAnchors(small);
    expect(anchors.map((a) => [a.id, a.placeIds])).toEqual([
      ["lecce", ["l1", "l2"]],
      ["asti", ["a1"]],
    ]);
  });

  it("breaks an exact distance tie between two bases by name, so input order cannot move a place", () => {
    const city = (name: string, lng: number, prefix: string) =>
      Array.from({ length: MIN_PLACES_FOR_BASE }, (_, n) =>
        makePlace({ id: `${prefix}${n}`, city: name, lat: 44, lng }),
      );
    const between = makePlace({ id: "mid", city: "Midway", lat: 44, lng: 12 });
    const places = [...city("Zeta", 11.5, "a"), ...city("Alfa", 12.5, "z"), between];
    const zeta = places[0];
    const alfa = places[MIN_PLACES_FOR_BASE];
    if (!zeta || !alfa) throw new Error("fixture");
    expect(haversineKm(between, zeta)).toBe(haversineKm(between, alfa));
    for (const order of [places, [...places].reverse()]) {
      expect(buildAnchors(order).find((a) => a.id === "alfa")?.placeIds).toContain("mid");
    }
  });

  it("takes a base's region from most of its places, ties to the first alphabetically", () => {
    const regions = ["Umbria", "Lazio", "Umbria", "Lazio", "Lazio", "Umbria"];
    const places = regions.map((region, n) => makePlace({ id: `r${n}`, city: "Orte", region }));
    expect(buildAnchors(places)[0]?.region).toBe("Lazio");
    const majority = [...places, makePlace({ id: "r9", city: "Orte", region: "Umbria" })];
    expect(buildAnchors(majority)[0]?.region).toBe("Umbria");
  });

  it("never renames the real Rome base when an Unknown-city place is itself called Rome", () => {
    const lookalike = makePlace({
      id: "aaa",
      name: "Rome",
      city: UNKNOWN_CITY,
      lat: 37.5,
      lng: 15,
    });
    const anchors = buildAnchors([...real(), lookalike]);
    expect(anchors.find((a) => a.id === "rome")?.placeIds).toHaveLength(30);
    expect(anchors.find((a) => a.id === "rome-2")?.placeIds).toEqual(["aaa"]);
  });

  it("gives same-named far places the same ids in any input order", () => {
    // A small town called Hut, and two places in "Unknown city" that are themselves named Hut.
    const huts = [
      makePlace({ id: "h2", city: "Hut", lat: 40.1, lng: 9.0 }),
      makePlace({ id: "h1", city: "Hut", lat: 40.11, lng: 9.01 }),
      makePlace({ id: "h15", name: "Hut", city: UNKNOWN_CITY, lat: 37.7, lng: 15.0 }),
      makePlace({ id: "h0", name: "Hut", city: UNKNOWN_CITY, lat: 39.2, lng: 16.3 }),
    ];
    const expected = buildAnchors(huts);
    expect(expected.map((a) => [a.id, a.placeIds])).toEqual([
      ["hut-2", ["h1", "h2"]],
      ["hut", ["h0"]],
      ["hut-3", ["h15"]],
    ]);
    fc.assert(
      fc.property(fc.shuffledSubarray(huts, { minLength: huts.length }), (shuffled) => {
        expect(buildAnchors(shuffled)).toEqual(expected);
      }),
      { ...FC_SETTINGS, numRuns: 30 },
    );
  });

  it("returns no bases for no places instead of throwing", () => {
    expect(buildAnchors([])).toEqual([]);
  });

  it("gives colliding city names distinct ids that pass the id schema", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 80, unit: "grapheme" }), {
          minLength: 1,
          maxLength: 6,
        }),
        italyPoint,
        (cities, point) => {
          const places = cities.flatMap((city, c) =>
            Array.from({ length: MIN_PLACES_FOR_BASE }, (_, n) =>
              makePlace({ id: `p${c}_${n}`, city, ...point }),
            ),
          );
          const ids = buildAnchors(places).map((a) => a.id);
          expect(new Set(ids).size).toBe(cities.length);
          for (const id of ids) expect(IdSchema.safeParse(id).success).toBe(true);
        },
      ),
      FC_SETTINGS,
    );
  });
});

describe("anchorSlug", () => {
  it.each([
    ["Isola della Scala", "isola-della-scala"],
    ["Forlì", "forli"],
    ["Sant'Angelo", "sant-angelo"],
    ["  Rome  ", "rome"],
    ["   ", "base"],
    ["東京", "base"],
  ])("turns %j into the id %j", (name, slug) => {
    expect(anchorSlug(name)).toBe(slug);
  });

  it("keeps long names short enough for a collision suffix within the 64-character id limit", () => {
    const slug = anchorSlug(`${"a".repeat(30)} ${"b".repeat(100)}`);
    expect(slug.length).toBeLessThanOrEqual(56);
    expect(slug.endsWith("-")).toBe(false);
  });
});
