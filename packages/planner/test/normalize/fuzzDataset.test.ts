import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PlaceSchema } from "../../src/dataSchemas";
import { PLACE_TYPES } from "../../src/enums";
import { normalizePlaces } from "../../src/normalize/index";

// Failure vector F6 at the dataset level: arbitrary lists of half-valid records. Whatever comes
// in, every record is accounted for, ids are unique, and every place passes the shared schema.
// The seed is fixed so CI is repeatable; FC_SEED and FC_RUNS widen a nightly run.

const SEED = Number(process.env.FC_SEED ?? 20260923);
const RUNS = Number(process.env.FC_RUNS ?? 400);
const anyValue = fc.oneof(
  fc.anything(),
  fc.string(),
  fc.double(),
  fc.constantFrom(null, undefined, "", " ", Number.NaN, Number.POSITIVE_INFINITY, -1, 0),
);
const placeType = fc.constantFrom(...PLACE_TYPES);
const HOURS_PIECES = [
  "Mon",
  "Tues",
  "Wed-Mon",
  "Daily",
  "Sat-Sun",
  "9:00",
  "19:00",
  "8am",
  "-",
  ",",
  " ",
  "closed",
  "01:00",
];
const hoursLike = fc
  .array(fc.constantFrom(...HOURS_PIECES), { maxLength: 8 })
  .map((parts) => parts.join(""));

describe("normalizePlaces on arbitrary input", () => {
  const recordArb = fc.record(
    {
      id: fc.oneof(fc.constantFrom("place_001", "place_002", "x"), anyValue),
      name: fc.oneof(fc.constantFrom("Colosseum", "Trevi Fountain by Night", " "), anyValue),
      type: fc.oneof(placeType, anyValue),
      city: fc.oneof(fc.constantFrom("Rome", "Roma", "Milan"), anyValue),
      region: anyValue,
      neighborhood: fc.oneof(fc.constantFrom("Brera", "Celio"), anyValue),
      description: anyValue,
      latitude: fc.oneof(fc.double({ min: 36, max: 47 }), anyValue),
      longitude: fc.oneof(fc.double({ min: 7, max: 18 }), anyValue),
      hours: fc.oneof(hoursLike, anyValue),
      duration_minutes: anyValue,
      price_range: fc.oneof(fc.constantFrom("€", "€€€€"), anyValue),
      rating: anyValue,
      tags: fc.oneof(fc.array(fc.string(), { maxLength: 4 }), anyValue),
      seasonal_notes: fc.oneof(
        fc.constantFrom("Open April-October only.", "Third weekend of each month only."),
        anyValue,
      ),
      booking_required: anyValue,
    },
    { requiredKeys: [] },
  );

  it("never throws, accounts for every record, and emits only schema-valid places", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.array(fc.oneof(recordArb, anyValue), { maxLength: 12 }), anyValue),
        (raw) => {
          const result = normalizePlaces(raw);
          const records = Array.isArray(raw)
            ? raw.length
            : result.places.length + result.excluded.length;
          expect(result.places.length + result.excluded.length).toBe(records);
          const ids = new Set(result.places.map((p) => p.id));
          expect(ids.size).toBe(result.places.length);
          for (const p of result.places) expect(PlaceSchema.safeParse(p).success).toBe(true);
          const known = new Set([...ids, ...result.excluded.map((record) => record.id), "dataset"]);
          for (const issue of result.issues) expect(known.has(issue.placeId)).toBe(true);
          for (const record of result.excluded)
            expect(result.issues.some((issue) => issue.placeId === record.id)).toBe(true);
        },
      ),
      { seed: SEED, numRuns: Math.max(100, Math.floor(RUNS / 2)) },
    );
  });
});
