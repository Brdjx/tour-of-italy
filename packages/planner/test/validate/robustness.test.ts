import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ViolationSchema } from "../../src/schemas";
import { type Itinerary, PACES, VIOLATION_CODES } from "../../src/types";
import { VIOLATION_SEVERITY, validateItinerary } from "../../src/validate";
import { makeViolation } from "../../src/violations";
import { FC_SETTINGS } from "../plannerFixtures";
import { ctx, miniTrip } from "./fixtures";

// Failure vectors F1 and F9: a tampered share link or a broken model answer can put any value the
// Itinerary type allows into the validator (NaN times, impossible dates, invented ids, negative
// transfers). The validator must never throw (a throw here is a 500 or a blank page), and every
// violation it returns must fit the API schema and read as plain text.

const EM_DASH = String.fromCharCode(0x2014); // built from its code so this file has none
const realIds = ["place_001", "place_005", "place_022", "place_026", "place_035", "place_064"];

const idArb = fc.oneof(
  fc.constantFrom(...realIds),
  fc.string({ maxLength: 80 }),
  fc.constant("place_999"),
);
const minuteArb = fc.oneof(
  fc.integer({ min: -100, max: 3000 }),
  fc.double({ noDefaultInfinity: false }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -0, 1439.5),
);
const dateArb = fc.oneof(
  fc.constantFrom("2026-10-20", "2026-10-21", "2028-02-29", "2026-12-31", "2027-01-01"),
  fc.constantFrom("2026-02-30", "not a date", "", "2026-13-01", "0001-01-01"),
  fc.string({ maxLength: 12 }),
);
const stopArb = fc.record({
  placeId: idArb,
  start: minuteArb,
  end: minuteArb,
  travelFromPrevMin: minuteArb,
  role: fc.constantFrom("visit" as const, "lunch" as const, "dinner" as const),
});
const dayArb = fc.record({
  date: dateArb,
  anchorId: fc.oneof(fc.constantFrom("rome", "florence", "milan", "venice", "bologna"), idArb),
  transferMin: minuteArb,
  stops: fc.array(stopArb, { maxLength: 8 }),
});
const itineraryArb: fc.Arbitrary<Itinerary> = fc.record({
  request: fc.record({
    startDate: dateArb,
    pace: fc.constantFrom(...PACES),
    interests: fc.array(fc.string({ maxLength: 10 }), { maxLength: 3 }),
    maxPriceLevel: fc.constantFrom(1 as const, 2 as const, 3 as const, 4 as const, null),
    anchors: fc.oneof(fc.constant("auto" as const), fc.array(idArb, { maxLength: 3 })),
    mustInclude: fc.array(idArb, { maxLength: 4 }),
    exclude: fc.array(idArb, { maxLength: 4 }),
  }),
  days: fc.array(dayArb, { maxLength: 5 }),
  source: fc.constant("deterministic" as const),
  warnings: fc.constant([]),
  meta: fc.constant({ attempts: 0, latencyMs: 0, generatedAt: "2026-09-23T00:00:00.000Z" }),
});

// The two properties take about a second alone and ran past Vitest's default 5 s on a loaded
// machine, so they carry their own limit, as the planner's other sweeps do.
describe("validator robustness", () => {
  it("never throws on arbitrary itineraries, and every violation is well formed", () => {
    fc.assert(
      fc.property(itineraryArb, (plan) => {
        const violations = validateItinerary(plan, ctx());
        for (const item of violations) {
          expect(VIOLATION_CODES).toContain(item.code);
          expect(item.severity).toBe(VIOLATION_SEVERITY[item.code]);
          expect(item.detail.length).toBeGreaterThan(0);
          expect(item.detail).not.toContain(EM_DASH);
          expect(ViolationSchema.safeParse(item).success).toBe(true);
          if (item.day !== undefined) expect(item.day).toBeLessThan(Math.max(plan.days.length, 1));
        }
      }),
      FC_SETTINGS,
    );
  }, 60_000);

  it("flags every random itinerary that has stops, so a blind validator cannot pass", () => {
    // A random plan is almost never valid; if one validates clean, the checks have gone blind.
    fc.assert(
      fc.property(itineraryArb, (plan) => {
        const stops = plan.days.reduce((sum, day) => sum + day.stops.length, 0);
        fc.pre(stops > 0);
        const errors = validateItinerary(plan, ctx()).filter((v) => v.severity === "error");
        expect(errors.length).toBeGreaterThan(0);
      }),
      FC_SETTINGS,
    );
  }, 60_000);

  it("does not echo a long invented place id into the violation", () => {
    const plan = miniTrip();
    const long = `x${"y".repeat(300)}`;
    const first = plan.days[0]?.stops[0];
    if (first) first.placeId = long;
    const found = validateItinerary(plan, ctx()).find((v) => v.code === "UNKNOWN_PLACE");
    expect(found?.placeId).toHaveLength(64);
    expect(found?.detail).not.toContain("yyy");
  });

  it("cuts a detail longer than the schema allows instead of breaking the API response", () => {
    const long = makeViolation("EMPTY_DAY", "a".repeat(600), { placeId: "p".repeat(90) });
    expect(long.detail).toHaveLength(500);
    expect(long.detail.endsWith("...")).toBe(true);
    expect(ViolationSchema.safeParse(long).success).toBe(true);
  });
});
