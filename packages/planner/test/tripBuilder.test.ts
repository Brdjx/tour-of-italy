import { describe, expect, it } from "vitest";
import { planDeterministic } from "../src/plan";
import { arrangementTiers } from "../src/planAnchors";
import { tripDates } from "../src/time";
import { buildTrip, PoolCache } from "../src/tripBuilder";
import type { TripRequest } from "../src/types";
import { invariantProblems } from "./itineraryInvariants";
import { makeRequest, realContext } from "./plannerFixtures";

// chooseTrip builds up to dozens of trips per plan and reuses day results between them. A day's
// result depends on every earlier day and on the must-includes' later chances, so a memo key
// that forgets either hands one trip another trip's day: a place twice, or a place in the wrong
// base. These requests once produced exactly that.

const ctx = realContext();

const REGRESSIONS: Partial<TripRequest>[] = [
  {
    startDate: "2027-09-11",
    pace: "packed",
    interests: ["active", "iconic", "splurge", "quiet", "scenic"],
    maxPriceLevel: 4,
    mustInclude: ["place_094", "place_064", "place_083", "place_060"],
    exclude: ["place_011", "place_046"],
  },
  {
    startDate: "2026-01-04",
    interests: ["art"],
    maxPriceLevel: 3,
    mustInclude: ["place_055", "place_073", "place_067", "place_029", "place_069", "place_013"],
    exclude: ["place_051", "place_064", "place_100", "place_011", "place_004"],
  },
];

describe("trip memo", () => {
  it.each(REGRESSIONS.map((overrides, n) => [n, makeRequest(overrides)] as const))(
    "request %i: a shared memo gives every arrangement the same trip as a fresh one",
    (_n, request) => {
      const dates = tripDates(request.startDate);
      const memo = new Map();
      const pools = new PoolCache(request, ctx);
      for (const tier of arrangementTiers(request, ctx, dates)) {
        for (const arrangement of tier) {
          const shared = buildTrip(arrangement, request, ctx, dates, memo, pools);
          expect(shared).toEqual(buildTrip(arrangement, request, ctx, dates));
        }
      }
    },
  );

  it.each(REGRESSIONS.map((overrides, n) => [n, makeRequest(overrides)] as const))(
    "request %i: the chosen plan never repeats a place",
    (_n, request) => {
      expect(invariantProblems(planDeterministic(request, ctx), ctx)).toEqual([]);
    },
  );
});
