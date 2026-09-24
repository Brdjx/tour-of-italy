import { describe, expect, it } from "vitest";
import { AnchorSchema, ExcludedRecordSchema, PlaceSchema } from "../src/dataSchemas";
import { normalizePlaces } from "../src/normalize/index";
import { place, rawRecord } from "./helpers";

// Data schemas the web app parses /api/places, /api/meta, and the data notes with (failure vector
// F8). Every value the normalizer can produce must pass, and nothing it cannot produce may.

describe("ExcludedRecordSchema and AnchorSchema", () => {
  it("never rejects an excluded record the normalizer produces", () => {
    const { excluded } = normalizePlaces([
      42,
      rawRecord({ id: "a", name: " " }),
      rawRecord({ id: "b", hours: "Temporarily closed" }),
      rawRecord({ id: "c", city: "Atlantis", latitude: null }),
    ]);
    expect(excluded.map((record) => record.reason)).toEqual([
      "invalid_record",
      "missing_name",
      "closed",
      "no_location",
    ]);
    for (const record of excluded) expect(ExcludedRecordSchema.parse(record)).toEqual(record);
  });

  it("rejects an excluded record with an unknown reason, so the notes panel never shows garbage", () => {
    const record = { id: "x", name: null, reason: "hidden", detail: "" };
    expect(ExcludedRecordSchema.safeParse(record).success).toBe(false);
  });

  it("accepts a base and rejects one with an unsafe place id", () => {
    const rome = {
      id: "rome",
      name: "Rome",
      region: "Lazio",
      centroid: { lat: 41.9, lng: 12.48 },
      placeIds: ["place_001"],
    };
    expect(AnchorSchema.safeParse(rome).success).toBe(true);
    expect(AnchorSchema.safeParse({ ...rome, placeIds: ["<img>"] }).success).toBe(false);
  });
});

describe("day-of-month bounds in PlaceSchema", () => {
  const withRule = (from: number, to: number) => ({
    ...place("place_059"),
    dateRules: [{ kind: "day_of_month", from, to, source: "x" }],
  });

  it("accepts a rule counted from the end of the month (-7 to -1)", () => {
    expect(PlaceSchema.safeParse(withRule(-7, -1)).success).toBe(true);
  });

  it.each([
    [0, 5],
    [1, 32],
    [-32, -1],
  ])("rejects the impossible day bounds %i to %i", (from, to) => {
    expect(PlaceSchema.safeParse(withRule(from, to)).success).toBe(false);
  });
});
