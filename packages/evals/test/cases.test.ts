import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Shortlist } from "@italy/api/plan/candidates";
import { openStatusOn, tripDates, tripRequestSchemaFor, weekdayOf } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { EvalCaseSchema, readCase, selectCases } from "../src/cases";
import { shortlistFor } from "../src/pipeline";
import { CASES, caseById, ctx, known, tempDir } from "./helpers";

// A case that no longer means what it says checks nothing and still passes. These tests pin the
// case files to the real data: every id exists, and every calendar trap a case relies on (a
// Monday closure, a season, a third-weekend market) is still a trap in the data.

const PLANNED = [
  "adversarial-injection",
  "adversarial-outside-data",
  "adversarial-three-cities-one-day",
  "budget-traveler",
  "everything",
  "family-quiet",
  "florence-art-monday",
  "lake-como-january",
  "lake-como-july",
  "must-include-closed",
  "must-include-two-cities",
  "rome-food-balanced",
  "rome-sunday-balanced",
  "sparse-interest",
  "splurge",
  "tuscany-wine-relaxed",
];

function states(placeId: string, startDate: string): string[] {
  const place = ctx.placesById.get(placeId);
  if (!place) throw new Error(`No place ${placeId}`);
  return tripDates(startDate).map((date) => openStatusOn(place, date).state);
}

describe("eval case files", () => {
  it("has exactly the sixteen planned cases, each file named by its id", () => {
    expect(CASES.map((c) => c.id)).toEqual(PLANNED);
  });

  it("never names an interest, place, or base the data does not have", () => {
    const schema = tripRequestSchemaFor(known);
    for (const c of CASES) {
      expect(schema.safeParse(c.request).success, c.id).toBe(true);
      for (const id of [...c.expect.forbidPlaceIds, ...c.expect.expectAnyPlaceIds]) {
        expect(known.placeIds.has(id), `${c.id}: ${id}`).toBe(true);
      }
    }
  });

  it("still starts florence-art-monday on a Monday when the Uffizi is closed", () => {
    const { request } = caseById("florence-art-monday");
    expect(weekdayOf(request.startDate)).toBe(1);
    expect(states("place_026", request.startDate)[0]).toBe("closed");
  });

  it("keeps the must-include-closed market closed on every trip date (second weekend, not third)", () => {
    const c = caseById("must-include-closed");
    expect(c.request.mustInclude).toEqual(["place_059"]);
    expect(states("place_059", c.request.startDate)).toEqual(["closed", "closed", "closed"]);
  });

  it("forbids only places that are closed for the season on the January lake trip", () => {
    const c = caseById("lake-como-january");
    for (const id of c.expect.forbidPlaceIds) {
      expect(states(id, c.request.startDate), id).toEqual(["closed", "closed", "closed"]);
    }
  });

  it("expects lake places on the July trip that are open then, with Balbianello shut on the Wednesday", () => {
    const c = caseById("lake-como-july");
    for (const id of c.expect.expectAnyPlaceIds) {
      expect(states(id, c.request.startDate), id).not.toEqual(["closed", "closed", "closed"]);
    }
    expect(states("place_064", c.request.startDate)).toEqual(["open", "closed", "open"]);
  });

  it("gives sparse-interest an interest exactly one place carries, across the leap day", () => {
    const c = caseById("sparse-interest");
    const carriers = ctx.places.filter((p) => c.request.interests.some((t) => p.tags.includes(t)));
    expect(carriers.map((p) => p.id)).toEqual(["place_039"]);
    expect(tripDates(c.request.startDate)).toContain("2028-02-29");
  });

  it("keeps the Vatican Museums closed on the Sunday of rome-sunday-balanced, its day 3", () => {
    const { request } = caseById("rome-sunday-balanced");
    expect(weekdayOf(request.startDate)).toBe(5);
    expect(states("place_010", request.startDate)).toEqual(["open", "open", "closed"]);
  });

  it("runs the injection case across the new year", () => {
    expect(tripDates(caseById("adversarial-injection").request.startDate)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
    ]);
  });
});

/**
 * Whether some split of the trip's days over at most `maxAnchors` offered bases gives every day a
 * lunch and a dinner from its own base's meal places, each used once. Counts only, so it is an
 * upper bound: opening hours can still make the meals impossible, never possible.
 */
function mealsFillable(shortlist: Shortlist, maxAnchors: number): boolean {
  const days = shortlist.dates.length;
  const meals = shortlist.options.map((o) => o.candidates.filter((c) => c.meal).length);
  if (meals.some((count) => count >= 2 * days)) return true;
  if (maxAnchors < 2) return false;
  for (const [i, first] of meals.entries()) {
    for (const [j, second] of meals.entries()) {
      if (i === j) continue;
      for (let d = 1; d < days; d++) if (first >= 2 * d && second >= 2 * (days - d)) return true;
    }
  }
  return false;
}

// An expectation the offered shortlist cannot meet fails every model on every run, and the
// comparison then counts the harness's mistake against the model.
describe("eval cases a model can pass", () => {
  it("never forbids a missing meal where the shortlist has too few meal places for every lunch and dinner", () => {
    for (const c of CASES) {
      if (!c.expect.forbidViolationCodes.includes("MEAL_MISSING")) continue;
      const shortlist = shortlistFor(c.request, ctx);
      expect(mealsFillable(shortlist, c.expect.maxAnchors), c.id).toBe(true);
    }
  });

  it("lets rome-food-balanced forbid a missing meal: seven meal places offered for six meals", () => {
    // The shortlist offered five until it was sized for a whole trip at one base (candidates.ts).
    const c = caseById("rome-food-balanced");
    const shortlist = shortlistFor(c.request, ctx);
    expect(shortlist.options.map((o) => o.candidates.filter((x) => x.meal).length)).toEqual([7]);
    expect(mealsFillable(shortlist, c.expect.maxAnchors)).toBe(true);
    expect(c.expect.forbidViolationCodes).toContain("MEAL_MISSING");
  });

  it("lets budget-traveler seat a meal one level over, the only places over budget it is offered", () => {
    const c = caseById("budget-traveler");
    const offered = shortlistFor(c.request, ctx).options.flatMap((o) => o.candidates);
    const over = offered.filter((x) => x.overBudget);

    expect(c.expect.forbidViolationCodes).toContain("OVER_BUDGET");
    expect(c.expect.allowOnMealStops).toEqual(["OVER_BUDGET"]);
    expect(over.length).toBeGreaterThan(0);
    expect(over.every((x) => x.meal && x.place.priceLevel === 2)).toBe(true);
  });

  it("never expects a place the model is not offered", () => {
    for (const c of CASES) {
      if (c.expect.expectAnyPlaceIds.length === 0) continue;
      const offered = shortlistFor(c.request, ctx).placeIds;
      expect(
        c.expect.expectAnyPlaceIds.some((id) => offered.has(id)),
        c.id,
      ).toBe(true);
    }
  });
});

describe("eval case schema", () => {
  const valid = {
    id: "a-case",
    description: "A case.",
    request: { startDate: "2026-10-13", pace: "balanced" },
    expect: { maxAnchors: 2, minPreferenceMatch: 0.5 },
  };

  it("accepts a minimal case and fills every optional check with no check", () => {
    const parsed = EvalCaseSchema.parse(valid);
    expect(parsed.expect.forbidViolationCodes).toEqual([]);
    expect(parsed.request.anchors).toBe("auto");
  });

  it.each([
    ["an unknown field", { ...valid, extra: true }],
    [
      "an error code as an expected warning",
      { ...valid, expect: { ...valid.expect, expectWarningCodes: ["CLOSED_AT_TIME"] } },
    ],
    [
      "an error code allowed on meal stops",
      { ...valid, expect: { ...valid.expect, allowOnMealStops: ["UNKNOWN_PLACE"] } },
    ],
    [
      "a code that does not exist",
      { ...valid, expect: { ...valid.expect, forbidViolationCodes: ["NOPE"] } },
    ],
    ["more bases than a trip allows", { ...valid, expect: { ...valid.expect, maxAnchors: 3 } }],
    [
      "a preference share above 1",
      { ...valid, expect: { ...valid.expect, minPreferenceMatch: 1.2 } },
    ],
    ["an id that is not kebab-case", { ...valid, id: "A Case" }],
    [
      "a request the API would refuse",
      { ...valid, request: { startDate: "2026-02-30", pace: "balanced" } },
    ],
  ])("rejects a case with %s", (_label, input) => {
    expect(EvalCaseSchema.safeParse(input).success).toBe(false);
  });

  it("refuses a file whose name is not its case id", () => {
    const path = join(tempDir(), "other-name.json");
    writeFileSync(path, JSON.stringify(valid));
    expect(() => readCase(path)).toThrow(/file name must be a-case.json/);
  });

  it("refuses a file that is not JSON, naming the file", () => {
    const path = join(tempDir(), "a-case.json");
    writeFileSync(path, "{ not json");
    expect(() => readCase(path)).toThrow(/a-case.json: not valid JSON/);
  });
});

describe("--case filter", () => {
  it("selects every case whose id contains a filter", () => {
    expect(selectCases(CASES, ["lake"]).map((c) => c.id)).toEqual([
      "lake-como-january",
      "lake-como-july",
    ]);
    expect(selectCases(CASES, [])).toHaveLength(16);
  });

  it("fails loudly on a filter that matches nothing, instead of running zero cases", () => {
    expect(() => selectCases(CASES, ["rome", "amalfi"])).toThrow(/No case matches: amalfi/);
  });
});
