import { describe, expect, it } from "vitest";
import { PACE, REQUEST_LIMITS, TRIP_DAYS } from "../src/config";
import { buildPlannerContext } from "../src/context";
import { NoFeasiblePlanError, planDeterministic } from "../src/plan";
import { EPOCH_ISO } from "../src/planPolicy";
import { makeWeek } from "../src/time";
import type { Itinerary, TripRequest, Weekday } from "../src/types";
import { validateItinerary } from "../src/validate";
import { invariantProblems } from "./itineraryInvariants";
import { makePlace, makeRequest, realContext } from "./plannerFixtures";

// planDeterministic is the plan when the AI is off and the fallback for every AI failure. These
// tests pin the requests the lead called out as dangerous (January, Mondays, budget 1, all
// interests, 10 exclusions, a relaxed day with an 8-hour must-include), the options contract,
// base choice, and what happens when a base cannot fill a day.

const ctx = realContext();
const tags = [...new Set(ctx.places.flatMap((place) => place.tags))].sort();

function plan(overrides: Partial<TripRequest> = {}): Itinerary {
  return planDeterministic(makeRequest(overrides), ctx);
}

function expectValid(itinerary: Itinerary): void {
  expect(invariantProblems(itinerary, ctx)).toEqual([]);
  expect(validateItinerary(itinerary, ctx).filter((v) => v.severity === "error")).toEqual([]);
}

const placeIds = (itinerary: Itinerary) =>
  itinerary.days.flatMap((day) => day.stops.map((stop) => stop.placeId));

describe("requests that used to break planners", () => {
  it.each<[string, Partial<TripRequest>]>([
    ["a January start (seasonal closures)", { startDate: "2027-01-11" }],
    ["a Monday start (museum closures)", { startDate: "2026-10-19", interests: ["art"] }],
    ["budget 1", { maxPriceLevel: 1, pace: "packed" }],
    [
      "the most interests a request allows",
      { interests: tags.slice(0, REQUEST_LIMITS.maxInterests) },
    ],
    ["no interests at all", { interests: [] }],
    ["a peak summer Saturday", { startDate: "2026-08-15", pace: "packed" }],
  ])("returns %s as a full valid trip", (_label, overrides) => {
    const itinerary = plan(overrides);
    expect(itinerary.days).toHaveLength(TRIP_DAYS);
    expectValid(itinerary);
  });

  it("never throws or breaks a hard rule even with every tag in the data as an interest", () => {
    const itinerary = plan({ interests: tags });
    expect(tags.length).toBeGreaterThan(REQUEST_LIMITS.maxInterests);
    const problems = invariantProblems(itinerary, ctx);
    // The request itself is over the API's interest limit, so only the schema check may fail.
    expect(problems.filter((problem) => problem !== "fails ItinerarySchema")).toEqual([]);
  });

  it("returns a full valid trip when the 10 best places of the favorite base are excluded", () => {
    const rome = plan({ anchors: ["rome"] });
    const exclude = placeIds(rome).slice(0, 10);
    const itinerary = plan({ exclude });
    expectValid(itinerary);
    expect(placeIds(itinerary).some((id) => exclude.includes(id))).toBe(false);
  });

  it("places an 8-hour day trip on a relaxed day and still returns a valid trip", () => {
    const itinerary = plan({
      startDate: "2026-06-10",
      pace: "relaxed",
      mustInclude: ["place_035"],
    });
    expect(placeIds(itinerary)).toContain("place_035");
    expectValid(itinerary);
  });

  it("explains an 8-hour day trip that is closed for the season instead of dropping it silently", () => {
    const itinerary = plan({
      startDate: "2027-01-11",
      pace: "relaxed",
      mustInclude: ["place_035"],
    });
    expect(placeIds(itinerary)).not.toContain("place_035");
    const warning = itinerary.warnings.find((w) => w.code === "MUST_INCLUDE_UNPLACEABLE");
    expect(warning).toMatchObject({ placeId: "place_035", severity: "warning" });
    expectValid(itinerary);
  });

  it("puts an evening-only must-include in the evening next to the day's dinner, never at 10:00", () => {
    // Since a dinner that ends the day may leave the walk home past the window, the walk may see
    // Trevi by night at 20:15 and dine at 21:15; before, dinner had to come first.
    const itinerary = plan({ mustInclude: ["place_077"] });
    const day = itinerary.days.find((d) => d.stops.some((s) => s.placeId === "place_077"));
    const stops = day?.stops ?? [];
    const night = stops.findIndex((s) => s.placeId === "place_077");
    const dinner = stops.findIndex((s) => s.role === "dinner");
    expect(stops[night]?.start).toBeGreaterThanOrEqual(1200);
    expect(dinner).toBeGreaterThanOrEqual(0);
    expect(Math.abs(night - dinner)).toBe(1);
    expectValid(itinerary);
  });

  it("never plans Trevi Fountain by day when the traveler asked for it by night (same spot)", () => {
    const likesTrevi = {
      interests: ["iconic", "photogenic"],
      anchors: ["rome"],
      pace: "packed" as const,
    };
    expect(placeIds(plan(likesTrevi))).toContain("place_018");
    const ids = placeIds(plan({ ...likesTrevi, mustInclude: ["place_077"] }));
    expect(ids).toContain("place_077");
    expect(ids).not.toContain("place_018");
  });

  it("never plans both Trevi Fountain listings, even when both are asked for, and says why", () => {
    // The brief: two listings of one spot never share a trip. The review found both planned
    // back to back with only a SAME_LOCATION note.
    const itinerary = plan({ mustInclude: ["place_018", "place_077"], anchors: ["rome"] });
    const ids = placeIds(itinerary);
    expect(ids.filter((id) => id === "place_018" || id === "place_077")).toHaveLength(1);
    const missing = ids.includes("place_018") ? "place_077" : "place_018";
    const warning = itinerary.warnings.find((w) => w.placeId === missing);
    expect(warning?.code).toBe("MUST_INCLUDE_UNPLACEABLE");
    expect(warning?.detail).toMatch(/same spot as Trevi Fountain/);
    expect(itinerary.warnings.some((w) => w.code === "SAME_LOCATION")).toBe(false);
    expectValid(itinerary);
  });
});

describe("bases", () => {
  it("keeps every day at a single chosen base", () => {
    const itinerary = plan({ anchors: ["venice"] });
    expect(itinerary.days.map((day) => day.anchorId)).toEqual(Array(TRIP_DAYS).fill("venice"));
  });

  it("uses both chosen bases, in the chosen order, with one transfer", () => {
    const bases = plan({ anchors: ["milan", "bologna"] }).days.map((day) => day.anchorId);
    expect(bases[0]).toBe("milan");
    expect(bases.at(-1)).toBe("bologna");
    expect(new Set(bases).size).toBe(2);
  });

  it("ignores an unknown base id instead of throwing, and plans automatically", () => {
    const itinerary = plan({ anchors: ["atlantis"] });
    expectValid(itinerary);
  });

  it("never moves a day off a thin chosen base that fewer visits a day can still fill", () => {
    // Ten exclusions leave Bologna six places. The greedy walk alone used them up by day 2 and
    // moved day 3 to another base; with fewer visits a day, Bologna holds all three days.
    const bologna = ctx.anchorById.get("bologna")?.placeIds ?? [];
    const keep = ["place_047", "place_092", "place_087"];
    const exclude = bologna.filter((id) => !keep.includes(id)).slice(0, 10);
    const itinerary = plan({ anchors: ["bologna"], exclude });
    expectValid(itinerary);
    expect(itinerary.days.map((day) => day.anchorId)).toEqual(Array(TRIP_DAYS).fill("bologna"));
    expect(itinerary.warnings.some((w) => w.code === "ANCHOR_NOT_CHOSEN")).toBe(false);
  });
});

describe("options and output contract", () => {
  it("returns byte-identical JSON for the same request, so the browser and Lambda agree", () => {
    const request = makeRequest({ interests: ["food"], mustInclude: ["place_026"] });
    expect(JSON.stringify(planDeterministic(request, ctx))).toBe(
      JSON.stringify(planDeterministic(request, ctx)),
    );
  });

  it("never reads the wall clock: the default generatedAt is the fixed epoch", () => {
    expect(plan().meta).toEqual({ attempts: 0, latencyMs: 0, generatedAt: EPOCH_ISO });
  });

  it("takes generatedAt and latency from an injected clock, and lets generatedAt override it", () => {
    let now = Date.UTC(2026, 8, 23, 12, 0, 0);
    const clock = () => (now += 7);
    const timed = planDeterministic(makeRequest(), ctx, { now: clock, fallbackReason: "timeout" });
    expect(timed.meta).toMatchObject({ attempts: 0, latencyMs: 7, fallbackReason: "timeout" });
    expect(timed.meta.generatedAt).toBe("2026-09-23T12:00:00.007Z");
    const fixed = planDeterministic(makeRequest(), ctx, {
      now: clock,
      generatedAt: "2026-01-01T00:00:00Z",
    });
    expect(fixed.meta.generatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("copies the request, so a caller editing its object later cannot change the plan", () => {
    const request = makeRequest({ interests: ["food"], exclude: ["place_001"] });
    const itinerary = planDeterministic(request, ctx);
    request.interests.push("art");
    request.exclude.length = 0;
    expect(itinerary.request.interests).toEqual(["food"]);
    expect(itinerary.request.exclude).toEqual(["place_001"]);
  });

  it("marks the plan deterministic with rule reasons on every stop", () => {
    const itinerary = plan();
    expect(itinerary.source).toBe("deterministic");
    const stops = itinerary.days.flatMap((day) => day.stops);
    expect(stops.every((stop) => stop.reasonSource === "rule" && (stop.reason ?? "") !== "")).toBe(
      true,
    );
  });
});

describe("contexts that cannot fill a day", () => {
  const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
  const openAccess = { open: 420, close: 1380 };

  function place(n: number, overrides: Parameters<typeof makePlace>[0]) {
    return makePlace({ id: `place_t${n}`, lat: 41.89 + n * 0.002, lng: 12.49, ...overrides });
  }

  it("rescues each over-budget day with exactly one open-access public space", () => {
    const spaces = Array.from({ length: TRIP_DAYS }, (_, i) => i + 3);
    const places = [
      place(1, { priceLevel: 4 }),
      place(2, { priceLevel: 4 }),
      ...spaces.map((n) =>
        place(n, {
          type: "viewpoint",
          priceLevel: 4,
          hoursConfidence: "open_access",
          hours: makeWeek(EVERY_DAY, [openAccess]),
        }),
      ),
    ];
    const itinerary = planDeterministic(
      makeRequest({ maxPriceLevel: 1 }),
      buildPlannerContext(places),
    );
    const days = itinerary.days.map((day) => day.stops.map((stop) => stop.placeId));
    expect(days.every((ids) => ids.length === 1)).toBe(true);
    expect(days.flat().sort()).toEqual(spaces.map((n) => `place_t${n}`));
    expect(itinerary.warnings.filter((w) => w.code === "OVER_BUDGET")).toHaveLength(TRIP_DAYS);
  });

  it("throws NoFeasiblePlanError rather than return a plan with an empty day", () => {
    const closed = [1, 2, 3, 4, 5].map((n) => place(n, { hours: makeWeek([], []) }));
    expect(() => planDeterministic(makeRequest(), buildPlannerContext(closed))).toThrow(
      NoFeasiblePlanError,
    );
    expect(new NoFeasiblePlanError().code).toBe("NO_FEASIBLE_PLAN");
  });

  it("fits every relaxed stop inside 10:00 to 22:00", () => {
    const itinerary = plan({ pace: "relaxed" });
    const stops = itinerary.days.flatMap((day) => day.stops);
    expect(
      stops.every((s) => s.start >= PACE.relaxed.dayStart && s.end <= PACE.relaxed.dayEnd),
    ).toBe(true);
  });
});
