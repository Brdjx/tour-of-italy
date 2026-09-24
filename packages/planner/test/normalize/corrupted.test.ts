import { describe, expect, it } from "vitest";
import { MAX_SHARED_LINKS } from "../../src/config";
import { buildDataset } from "../../src/data";
import { PlaceSchema } from "../../src/dataSchemas";
import { insideItaly } from "../../src/normalize/geo";
import { normalizePlaces } from "../../src/normalize/index";
import type { NormalizeResult } from "../../src/types";
import { rawData } from "../helpers";

// Failure vector F6: a corrupted or replaced data file. Whatever arrives, normalizePlaces returns
// only valid places, logs every exclusion, and finishes quickly.

/**
 * The invariants every result must keep, however bad the input. Each check collects the offending
 * ids and asserts once, so a 10,000-record case stays linear and the failure names the records.
 */
function expectSound(result: NormalizeResult, records: number): void {
  expect(result.places.length + result.excluded.length).toBe(records);
  const ids = result.places.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  const invalid = result.places.filter((p) => !insideItaly(p) || !PlaceSchema.safeParse(p).success);
  expect(invalid.map((p) => p.id)).toEqual([]);
  const logged = new Set(result.issues.map((issue) => issue.placeId));
  const unexplained = result.excluded.filter((record) => !logged.has(record.id));
  expect(unexplained.map((record) => record.id)).toEqual([]);
}

const mapRecords = (
  change: (record: Record<string, unknown>, index: number) => Record<string, unknown>,
) => rawData().map(change);

describe("corrupted dataset variants", () => {
  it.each([
    ["hours as numbers", { hours: 900 }],
    ["tags as a string", { tags: "food,wine" }],
    ["rating as text", { rating: "four" }],
    ["price as an object", { price_range: { level: 2 } }],
    ["duration as an array", { duration_minutes: [90] }],
    ["booking as a string", { booking_required: "yes" }],
    ["type as a number", { type: 3 }],
    ["notes as an object", { seasonal_notes: { season: "summer" } }],
  ])("keeps every place schedulable when every record has %s", (_label, override) => {
    const result = normalizePlaces(mapRecords((record) => ({ ...record, ...override })));
    expectSound(result, 103);
    expect(result.places).toHaveLength(103);
  });

  it("repairs a few NaN and Infinity coordinates from sibling places", () => {
    const records = mapRecords((record, index) =>
      index % 10 === 0
        ? { ...record, latitude: Number.NaN, longitude: Number.POSITIVE_INFINITY }
        : record,
    );
    const result = normalizePlaces(records);
    expectSound(result, 103);
    const repaired = result.places.filter((p) => p.locationSource !== "listed");
    expect(repaired.length).toBeGreaterThanOrEqual(9);
  });

  it("excludes, with a logged reason, every place when no coordinates are usable anywhere", () => {
    const result = normalizePlaces(mapRecords((record) => ({ ...record, latitude: Number.NaN })));
    expectSound(result, 103);
    expect(result.places).toEqual([]);
    expect(result.excluded.every((record) => record.reason === "no_location")).toBe(true);
  });

  it("keeps working when fields are missing entirely", () => {
    const stripped = mapRecords((record) => {
      const { tags: _tags, hours: _hours, seasonal_notes: _notes, ...rest } = record;
      return rest;
    });
    const result = normalizePlaces(stripped);
    expectSound(result, 103);
    expect(result.places.every((p) => p.tags.length === 0)).toBe(true);
  });

  it("makes ids unique when every record has the same id", () => {
    const result = normalizePlaces(mapRecords((record) => ({ ...record, id: "same" })));
    expectSound(result, 103);
    expect(result.places[0]?.id).toBe("same");
    expect(result.places[1]?.id).toBe("same-2");
  });

  it("merges exact copies of the whole file into the original 103 places", () => {
    const result = normalizePlaces([...rawData(), ...rawData()]);
    expectSound(result, 206);
    expect(result.places).toHaveLength(103);
    expect(result.excluded.every((record) => record.reason === "duplicate")).toBe(true);
  });

  it("returns nothing, and no issues, for an empty list", () => {
    expect(normalizePlaces([])).toEqual({ places: [], excluded: [], issues: [] });
  });

  it.each([null, undefined, "places", 42, true, {}, { a: 1 }, { places: [], other: [] }])(
    "loads no places from the non-list top level %j and says why",
    (raw) => {
      const result = normalizePlaces(raw);
      expect(result.places).toEqual([]);
      expect(result.issues.map((issue) => issue.kind)).toEqual(["dataset_shape"]);
      expect(buildDataset(raw).summary.headline).toBe("No places could be loaded.");
    },
  );

  it("excludes non-object entries mixed into the list and keeps the rest", () => {
    const result = normalizePlaces([null, 7, "text", [], ...rawData()]);
    expectSound(result, 107);
    expect(result.places).toHaveLength(103);
    expect(result.excluded.map((record) => record.reason)).toEqual(Array(4).fill("invalid_record"));
  });

  it("does not let a __proto__ key in the JSON pollute Object.prototype", () => {
    const json =
      '[{"__proto__": {"polluted": true}, "name": "Test", "city": "Rome", "latitude": 41.9, "longitude": 12.5}]';
    const result = normalizePlaces(JSON.parse(json));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expectSound(result, 1);
  });

  it("stays fast on megabyte-long strings in every text field", () => {
    const long = "weekday ".repeat(130_000);
    const record = {
      ...rawData()[0],
      hours: long,
      seasonal_notes: long,
      description: long,
      name: long,
    };
    const started = performance.now();
    const result = normalizePlaces([record]);
    expect(performance.now() - started).toBeLessThan(2_000);
    expectSound(result, 1);
    for (const issue of result.issues) expect(issue.detail.length).toBeLessThanOrEqual(300);
  });

  it("normalizes 10,000 distinct records in a few seconds with every invariant intact", () => {
    const base = rawData();
    const records = Array.from({ length: 10_000 }, (_, index) => {
      const source = base[index % base.length] ?? {};
      const shift = Math.floor(index / base.length) * 0.0005; // about 50 m per copy
      return {
        ...source,
        id: `place_x${index}`,
        name: `${String(source.name)} ${index}`,
        latitude: Number(source.latitude) + shift,
      };
    });
    const started = performance.now();
    const result = normalizePlaces(records);
    expect(performance.now() - started).toBeLessThan(4_000);
    expectSound(result, 10_000);
    expect(result.places).toHaveLength(10_000);
  });

  it("collapses 10,000 identical records into one place quickly", () => {
    const record = rawData()[0] ?? {};
    const started = performance.now();
    const result = normalizePlaces(Array.from({ length: 10_000 }, () => ({ ...record })));
    expect(performance.now() - started).toBeLessThan(4_000);
    expectSound(result, 10_000);
    expect(result.places).toHaveLength(1);
  });

  it("caps shared-location links when 10,000 places sit on one spot, and never links one way", () => {
    const record = rawData()[0] ?? {};
    const records = Array.from({ length: 10_000 }, (_, index) => ({
      ...record,
      id: `spot_${index}`,
      name: `Spot ${index}`,
    }));
    const started = performance.now();
    const result = normalizePlaces(records);
    expect(performance.now() - started).toBeLessThan(4_000);
    expectSound(result, 10_000);
    const links = result.places.map((p) => p.sharedLocationWith.length);
    expect(Math.max(...links)).toBeLessThanOrEqual(MAX_SHARED_LINKS);
    const byId = new Map(result.places.map((p) => [p.id, p]));
    const oneWay = result.places.flatMap((p) =>
      p.sharedLocationWith
        .filter((id) => !byId.get(id)?.sharedLocationWith.includes(p.id))
        .map((id) => `${p.id}->${id}`),
    );
    expect(oneWay).toEqual([]);
  });

  it("infers the city for 5,000 records without one, without slowing down", () => {
    const base = rawData();
    const records = Array.from({ length: 10_000 }, (_, index) => {
      const source = base[index % base.length] ?? {};
      return {
        ...source,
        id: `c_${index}`,
        name: `Place ${index}`,
        city: index % 2 ? null : source.city,
      };
    });
    const started = performance.now();
    const result = normalizePlaces(records);
    expect(performance.now() - started).toBeLessThan(4_000);
    expectSound(result, 10_000);
    expect(result.places.filter((p) => p.city === "Unknown city")).toHaveLength(0);
  });
});
