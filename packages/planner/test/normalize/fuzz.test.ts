import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ITALY_BBOX, TYPE_DURATIONS } from "../../src/config";
import { DataIssueSchema } from "../../src/dataSchemas";
import { PLACE_TYPES } from "../../src/enums";
import { normalizeDuration, parseDurationText } from "../../src/normalize/duration";
import { normalizePoint } from "../../src/normalize/geo";
import { normalizeHours } from "../../src/normalize/hours";
import { parseWeeklyHours } from "../../src/normalize/hoursParser";
import { normalizeId, resolveIdCollisions } from "../../src/normalize/ids";
import {
  normalizeBooking,
  normalizeCity,
  normalizeDescription,
  normalizeName,
  normalizeNeighborhood,
  normalizeRegion,
} from "../../src/normalize/names";
import { normalizeType } from "../../src/normalize/placeType";
import { normalizePrice } from "../../src/normalize/price";
import { normalizeRating } from "../../src/normalize/rating";
import { normalizeSeasonalNote, scanDescription } from "../../src/normalize/seasons";
import { normalizeTags } from "../../src/normalize/tags";
import { longestOpenRange, parseClock, WEEKDAYS } from "../../src/time";
import type { DataIssue, WeeklyHours } from "../../src/types";

// Failure vector F6: a data regression breaks parsing. Every normalizer gets arbitrary strings,
// numbers, nulls, and objects and must return a well-formed value with well-formed issues, never
// throw. The seed is fixed so CI is repeatable; FC_SEED and FC_RUNS widen a nightly run.

const SEED = Number(process.env.FC_SEED ?? 20260923);
const RUNS = Number(process.env.FC_RUNS ?? 400);
const settings = { seed: SEED, numRuns: RUNS };

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
  "7pm",
  "-",
  ",",
  " ",
  "closed",
  "24:00",
  "01:00",
  "12:30pm",
  "Evenings",
];
const hoursLike = fc
  .array(fc.constantFrom(...HOURS_PIECES), { maxLength: 8 })
  .map((parts) => parts.join(""));

function expectIssuesWellFormed(issues: DataIssue[]): void {
  for (const issue of issues) expect(DataIssueSchema.safeParse(issue).success).toBe(true);
}

function expectWeekWellFormed(hours: WeeklyHours | null): void {
  if (hours === null) return;
  for (const day of WEEKDAYS) {
    for (const range of hours[day]) {
      expect(Number.isInteger(range.open) && range.open >= 0 && range.open < 1440).toBe(true);
      expect(range.close > range.open && range.close - range.open <= 1440).toBe(true);
    }
  }
}

describe("normalizers never throw and always return well-formed values", () => {
  it("normalizeHours", () => {
    fc.assert(
      fc.property(fc.oneof(anyValue, hoursLike), placeType, fc.string(), (raw, type, name) => {
        const { value, issues } = normalizeHours(raw, { placeId: "p", type, name });
        expectWeekWellFormed(value.hours);
        expect(value.hours === null).toBe(value.confidence === "unknown");
        expectIssuesWellFormed(issues);
      }),
      settings,
    );
  });

  it("parseWeeklyHours and parseClock on hours-like text", () => {
    fc.assert(
      fc.property(fc.oneof(hoursLike, fc.string()), (text) => {
        const parsed = parseWeeklyHours(text);
        if (parsed.ok) expectWeekWellFormed(parsed.hours);
        const clock = parseClock(text);
        expect(clock === null || (Number.isInteger(clock) && clock >= 0 && clock <= 1440)).toBe(
          true,
        );
      }),
      settings,
    );
  });

  it("normalizeSeasonalNote and scanDescription", () => {
    fc.assert(
      fc.property(anyValue, (raw) => {
        const note = normalizeSeasonalNote(raw, { placeId: "p", listedHours: null });
        expect(Array.isArray(note.value.dateRules)).toBe(true);
        expectIssuesWellFormed(note.issues);
        const description = scanDescription(raw, { placeId: "p", listedHours: null });
        expectIssuesWellFormed(description.issues);
      }),
      settings,
    );
  });

  it("normalizeDuration keeps every visit inside its bounds and its longest opening", () => {
    const hoursArb = fc.option(
      fc
        .integer({ min: 0, max: 1380 })
        .chain((open) =>
          fc.integer({ min: open + 1, max: open + 1440 }).map((close) => ({ open, close })),
        ),
    );
    fc.assert(
      fc.property(anyValue, placeType, hoursArb, (raw, type, range) => {
        const hours = range
          ? ({ 0: [range], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } as WeeklyHours)
          : null;
        const { value, issues } = normalizeDuration(raw, { placeId: "p", type, hours });
        const bounds = TYPE_DURATIONS[type];
        const longest = hours ? longestOpenRange(hours) : Number.POSITIVE_INFINITY;
        expect(Number.isInteger(value.durationMin)).toBe(true);
        expect(value.durationMin).toBeGreaterThan(0);
        expect(value.durationMin).toBeLessThanOrEqual(Math.min(bounds.max, longest));
        expectIssuesWellFormed(issues);
      }),
      settings,
    );
  });

  it("parseDurationText returns null or a positive whole number", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const minutes = parseDurationText(text);
        expect(minutes === null || (Number.isInteger(minutes) && minutes > 0)).toBe(true);
      }),
      settings,
    );
  });

  it("normalizePrice and normalizeRating stay in range", () => {
    fc.assert(
      fc.property(anyValue, fc.array(fc.string(), { maxLength: 3 }), (raw, tags) => {
        const price = normalizePrice(raw, { placeId: "p", tags });
        expect([null, 1, 2, 3, 4]).toContain(price.value);
        const rating = normalizeRating(raw, { placeId: "p" });
        expect(rating.value === null || (rating.value >= 0 && rating.value <= 5)).toBe(true);
        expectIssuesWellFormed([...price.issues, ...rating.issues]);
      }),
      settings,
    );
  });

  it("normalizePoint returns null or a point inside Italy", () => {
    fc.assert(
      fc.property(
        fc.oneof(anyValue, fc.double({ min: -200, max: 200 })),
        fc.oneof(anyValue, fc.double({ min: -200, max: 200 })),
        (latitude, longitude) => {
          const { value, issues } = normalizePoint({ latitude, longitude }, { placeId: "p" });
          if (value) {
            expect(value.lat >= ITALY_BBOX.minLat && value.lat <= ITALY_BBOX.maxLat).toBe(true);
            expect(value.lng >= ITALY_BBOX.minLng && value.lng <= ITALY_BBOX.maxLng).toBe(true);
          }
          expectIssuesWellFormed(issues);
        },
      ),
      settings,
    );
  });

  it("text, type, tag, booking, and id normalizers", () => {
    fc.assert(
      fc.property(anyValue, anyValue, (raw, other) => {
        const context = { placeId: "p" };
        for (const result of [
          normalizeName(raw, context),
          normalizeCity(raw, context),
          normalizeRegion(raw, context),
          normalizeNeighborhood(raw, context),
        ]) {
          expect(
            result.value === null ||
              (typeof result.value === "string" &&
                result.value.trim() === result.value &&
                result.value.length > 0),
          ).toBe(true);
          expectIssuesWellFormed(result.issues);
        }
        expect(typeof normalizeDescription(raw, context).value).toBe("string");
        expect([null, true, false]).toContain(normalizeBooking(raw, context).value);
        expect(PLACE_TYPES).toContain(normalizeType(raw, context).value);
        const tags = normalizeTags(Array.isArray(other) ? other : [raw, other], context).value;
        expect(new Set(tags).size).toBe(tags.length);
        for (const tag of tags) expect(tag).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(normalizeId(raw, { index: 0, name: other, city: raw }).value).toMatch(
          /^[A-Za-z0-9_-]{1,64}$/,
        );
      }),
      settings,
    );
  });

  it("resolveIdCollisions always returns unique ids", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "a-2", "a-3", "c"), { maxLength: 30 }),
        (ids) => {
          const resolved = resolveIdCollisions(ids);
          expect(resolved.ids).toHaveLength(ids.length);
          expect(new Set(resolved.ids).size).toBe(ids.length);
        },
      ),
      settings,
    );
  });
});
