import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ITALY_BBOX, MAX_SHARED_LINKS, SAME_LOCATION_MAX_M } from "../../src/config";
import { IdSchema } from "../../src/dataSchemas";
import { haversineKm, median, normalizePoint } from "../../src/normalize/geo";
import { normalizeId, resolveIdCollisions } from "../../src/normalize/ids";
import { normalizePlaces } from "../../src/normalize/index";
import { CELL_DEGREES } from "../../src/normalize/sharedLocations";
import { rawRecord } from "../helpers";

// Id and coordinate normalizers, table-driven with real values from docs/data-profile.md plus the
// variants a differently formatted dataset would bring. Each row states what it prevents.

const ctx = { placeId: "p" };
const kinds = (issues: { kind: string }[]) => issues.map((issue) => issue.kind);

describe("ids", () => {
  it("keeps a safe source id", () => {
    expect(normalizeId("place_001", { index: 0, name: "Colosseum", city: "Rome" })).toEqual({
      value: "place_001",
      issues: [],
    });
  });

  it.each([null, "", "has space", "<script>", 42, "x".repeat(65)])(
    "replaces the unsafe id %j with a city-name slug",
    (raw) => {
      const { value, issues } = normalizeId(raw, {
        index: 4,
        name: "Castel Sant'Angelo",
        city: "Rome",
      });
      expect(value).toBe("rome-castel-sant-angelo");
      expect(issues[0]).toMatchObject({ kind: "id_missing", placeId: "rome-castel-sant-angelo" });
    },
  );

  it("falls back to record_<n> when there is no name or city to slug", () => {
    expect(normalizeId(undefined, { index: 11, name: null, city: 5 }).value).toBe("record_12");
  });

  it("suffixes colliding ids in source order and never reuses an existing id", () => {
    const { ids, issues } = resolveIdCollisions(["a", "b", "a", "a-2", "a"]);
    expect(ids).toEqual(["a", "b", "a-3", "a-2", "a-4"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(issues.map((issue) => issue.placeId)).toEqual(["a-3", "a-4"]);
  });
});

describe("ids stay valid after collisions", () => {
  it("keeps a renamed 64-character id within 64 characters, so IdSchema never rejects it", () => {
    const long = "a".repeat(64);
    const { ids } = resolveIdCollisions([long, long, long]);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(IdSchema.safeParse(id).success, id).toBe(true);
  });

  it("gives every resolved id a unique IdSchema-valid value for any list of safe ids", () => {
    const safeId = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);
    const lists = fc.array(
      fc.oneof(safeId, fc.constant("x".repeat(64)), fc.constant("x".repeat(62))),
      {
        maxLength: 30,
      },
    );
    fc.assert(
      fc.property(lists, (input) => {
        const { ids } = resolveIdCollisions(input);
        expect(new Set(ids).size).toBe(input.length);
        for (const id of ids) expect(IdSchema.safeParse(id).success).toBe(true);
      }),
      { seed: 20260923, numRuns: 300 },
    );
  });
});

describe("shared locations", () => {
  const onSpot = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      rawRecord({ id: `s${index}`, name: `Stall ${index}`, latitude: 41.9, longitude: 12.48 }),
    );

  it("links all 8 places on one spot to each other, so no two can share a trip", () => {
    const { places } = normalizePlaces(onSpot(8));
    for (const p of places) {
      expect([...p.sharedLocationWith].sort(), p.id).toEqual(
        places
          .filter((other) => other !== p)
          .map((other) => other.id)
          .sort(),
      );
    }
  });

  it("never links one way, even when a spot has more places than the link cap", () => {
    const { places } = normalizePlaces(onSpot(MAX_SHARED_LINKS + 10));
    const byId = new Map(places.map((p) => [p.id, p]));
    for (const p of places) {
      expect(p.sharedLocationWith.length).toBeLessThanOrEqual(MAX_SHARED_LINKS);
      for (const id of p.sharedLocationWith)
        expect(byId.get(id)?.sharedLocationWith).toContain(p.id);
    }
  });

  it("uses grid cells at least as wide as the link distance, so the grid never misses a pair", () => {
    const west = { lat: ITALY_BBOX.maxLat, lng: 12 };
    const east = { lat: ITALY_BBOX.maxLat, lng: 12 + CELL_DEGREES };
    expect(haversineKm(west, east) * 1000).toBeGreaterThanOrEqual(SAME_LOCATION_MAX_M);
  });

  it("links two places 10 m apart that straddle a grid cell border", () => {
    const border = Math.ceil(12.48 / CELL_DEGREES) * CELL_DEGREES;
    const records = [
      rawRecord({ id: "w", name: "West", latitude: 41.9, longitude: border - 0.00005 }),
      rawRecord({ id: "e", name: "East", latitude: 41.9, longitude: border + 0.00005 }),
    ];
    const { places } = normalizePlaces(records);
    expect(places.map((p) => p.sharedLocationWith)).toEqual([["e"], ["w"]]);
  });
});

describe("normalizePoint and geo helpers", () => {
  it("keeps a point inside Italy", () => {
    expect(normalizePoint({ latitude: 41.8902, longitude: 12.4922 }, ctx)).toEqual({
      value: { lat: 41.8902, lng: 12.4922, source: "listed" },
      issues: [],
    });
  });

  it("swaps back a reversed pair", () => {
    const { value, issues } = normalizePoint({ latitude: 12.4922, longitude: 41.8902 }, ctx);
    expect(value).toEqual({ lat: 41.8902, lng: 12.4922, source: "swapped" });
    expect(kinds(issues)).toEqual(["coords_swapped"]);
  });

  it("reads numeric text and flags the format", () => {
    expect(normalizePoint({ latitude: "45.4641", longitude: "9.1919" }, ctx)).toMatchObject({
      value: { lat: 45.4641, lng: 9.1919 },
      issues: [{ kind: "coords_format" }],
    });
  });

  it.each([
    [0, 0, "coords_out_of_bounds"],
    [48.8566, 2.3522, "coords_out_of_bounds"],
    [Number.NaN, 12, "coords_missing"],
    [41.9, Number.POSITIVE_INFINITY, "coords_missing"],
    [null, 12, "coords_missing"],
    ["", "", "coords_missing"],
  ])(
    "rejects (%s, %s) with %s so no place is planned in the sea or in Paris",
    (latitude, longitude, kind) => {
      const { value, issues } = normalizePoint({ latitude, longitude }, ctx);
      expect(value).toBeNull();
      expect(kinds(issues)).toContain(kind);
    },
  );

  it("measures Colosseum to Pantheon at about 1.6 km and Rome to Florence at about 230 km", () => {
    expect(haversineKm({ lat: 41.8902, lng: 12.4922 }, { lat: 41.8986, lng: 12.4769 })).toBeCloseTo(
      1.56,
      1,
    );
    expect(
      haversineKm({ lat: 41.9028, lng: 12.4964 }, { lat: 43.7696, lng: 11.2558 }),
    ).toBeGreaterThan(225);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
