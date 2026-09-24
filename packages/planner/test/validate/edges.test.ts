import { describe, expect, it } from "vitest";
import { LONG_TRANSFER_MIN } from "../../src/config";
import { buildPlannerContext } from "../../src/context";
import { travelMinutesForKm } from "../../src/travel";
import type { Itinerary } from "../../src/types";
import { mustIncludePlaceability, validateItinerary } from "../../src/validate";
import { makePlace, makeRequest, northOf } from "../plannerFixtures";
import { ctx, dayOf, errorCodes, miniTrip } from "./fixtures";
import { stop } from "./trips";

// Edges a one-character bug would move: the long-transfer threshold, the visit cap inside the
// placeability rule, and meals a place serves versus meals it does not.

/** Two synthetic bases `km` apart, five places each, and a two-day plan moving between them. */
function twoBaseTrip(km: number): {
  plan: Itinerary;
  context: ReturnType<typeof buildPlannerContext>;
} {
  const south = { lat: 38, lng: 15 };
  const north = northOf(south, km);
  const places = [0, 1, 2, 3, 4].flatMap((i) => [
    makePlace({ id: `alpha_${i}`, city: "Alpha", lat: south.lat + i * 1e-4, lng: south.lng }),
    makePlace({ id: `beta_${i}`, city: "Beta", lat: north.lat + i * 1e-4, lng: north.lng }),
  ]);
  const context = buildPlannerContext(places);
  const alpha = context.anchorById.get("alpha");
  const beta = context.anchorById.get("beta");
  if (!alpha || !beta) throw new Error("synthetic bases missing");
  const transfer = travelMinutesForKm(km);
  const plan: Itinerary = {
    request: makeRequest({ startDate: "2026-10-20" }),
    days: [
      { date: "2026-10-20", anchorId: "alpha", transferMin: 0, stops: [] },
      { date: "2026-10-21", anchorId: "beta", transferMin: transfer, stops: [] },
    ],
    source: "deterministic",
    warnings: [],
    meta: { attempts: 0, latencyMs: 0, generatedAt: "2026-09-23T00:00:00.000Z" },
  };
  return { plan, context };
}

describe("long transfer threshold", () => {
  it("does not warn at exactly LONG_TRANSFER_MIN, only above it", () => {
    const atLimit = twoBaseTrip(375); // rounds to 180 min by high-speed train
    const over = twoBaseTrip(390); // rounds to 185 min
    expect(dayOf(atLimit.plan, 1).transferMin).toBe(LONG_TRANSFER_MIN);
    expect(dayOf(over.plan, 1).transferMin).toBe(LONG_TRANSFER_MIN + 5);
    const codes = (t: ReturnType<typeof twoBaseTrip>) =>
      validateItinerary(t.plan, t.context).map((v) => v.code);
    expect(codes(atLimit)).not.toContain("LONG_TRANSFER");
    expect(codes(atLimit)).not.toContain("WRONG_TRAVEL");
    expect(codes(over)).toContain("LONG_TRANSFER");
  });
});

describe("visit cap inside the placeability rule", () => {
  /** A relaxed trip spending only day 1 in Rome, with three short must-see visits on it. */
  function relaxedRomeDay(): Itinerary {
    const plan = miniTrip({
      pace: "relaxed",
      mustInclude: ["place_005", "place_018", "place_019", "place_008"],
    });
    dayOf(plan, 0).stops = [
      stop("place_005", 605, 650, 5, "visit"), // Pantheon
      stop("place_018", 670, 700, 10, "visit"), // Trevi Fountain
      stop("place_019", 720, 740, 10, "visit"), // Spanish Steps
    ];
    Object.assign(dayOf(plan, 1), { anchorId: "florence", transferMin: 130, stops: [] });
    dayOf(plan, 2).transferMin = 0;
    return plan;
  }

  it("treats a day with exactly maxVisits must-see visits as full, even with hours to spare", () => {
    expect(mustIncludePlaceability(relaxedRomeDay(), ctx(), "place_008")).toEqual({
      placeable: false,
      reason: "the time on Tue 20 Oct 2026 is already taken by other places you asked for",
    });
  });

  it("finds room again once one must-see on that day is only a meal", () => {
    const plan = relaxedRomeDay();
    plan.request.mustInclude = ["place_005", "place_018", "place_008"];
    expect(mustIncludePlaceability(plan, ctx(), "place_008")).toEqual({ placeable: true, day: 0 });
  });
});

describe("meals a place serves", () => {
  it("rejects dinner at a market that only serves lunch (NOT_A_MEAL_PLACE)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).stops.push(stop("place_015", 1140, 1200, 15, "dinner")); // Mercato Testaccio
    expect(errorCodes(plan)).toContain("NOT_A_MEAL_PLACE");
  });

  it("accepts lunch at a market on the reviewed meal list", () => {
    const plan = miniTrip();
    dayOf(plan, 1).stops.push(stop("place_015", 750, 810, 15, "lunch")); // Mercato Testaccio
    expect(errorCodes(plan)).toEqual([]);
  });
});

describe("room around fixed must-see stops", () => {
  it("counts travel from the base: Piazza del Popolo at Dawn is out of reach on a balanced day", () => {
    const plan = miniTrip({ mustInclude: ["place_023"] }); // 06:00 to 10:00, 15 min from the base
    expect(mustIncludePlaceability(plan, ctx(), "place_023")).toEqual({
      placeable: false,
      reason: "its opening hours on Tue 20 Oct 2026 and Wed 21 Oct 2026 do not fit a balanced day",
    });
  });

  it("leaves travel and buffer before the next must-see, not just clock time", () => {
    const plan = miniTrip({ mustInclude: ["place_010", "place_006"] });
    dayOf(plan, 0).stops = [stop("place_010", 660, 900, 20, "visit")]; // Vatican 11:00 to 15:00
    Object.assign(dayOf(plan, 1), { anchorId: "florence", transferMin: 130, stops: [] });
    dayOf(plan, 2).transferMin = 0;
    // Campo de' Fiori (until 13:00) could run 09:40 to 10:40, but the Vatican is 15 min away plus
    // a 10 min buffer, so it would have to end by 10:35.
    expect(mustIncludePlaceability(plan, ctx(), "place_006")).toEqual({
      placeable: false,
      reason: "the time on Tue 20 Oct 2026 is already taken by other places you asked for",
    });
  });
});
