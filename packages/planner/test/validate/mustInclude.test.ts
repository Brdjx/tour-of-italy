import { describe, expect, it } from "vitest";
import type { Itinerary } from "../../src/types";
import { mustIncludePlaceability, validateItinerary } from "../../src/validate";
import { ctx, dayOf, key, miniTrip, withCode } from "./fixtures";
import { tripRome, tripTuscany } from "./trips";

// Failure vector F1 (drop a must-include) and the fallback guarantee: a missing must-include is
// an error only when it was placeable, so the AI path repairs it; when it could never fit, the
// traveler gets a warning with the reason, and the rules-only plan can still ship.

/** Trip A without one of its stops. */
function romeWithout(placeId: string, overrides: Partial<Itinerary["request"]> = {}): Itinerary {
  const plan = tripRome();
  Object.assign(plan.request, overrides);
  for (const day of plan.days) day.stops = day.stops.filter((s) => s.placeId !== placeId);
  return plan;
}

function verdict(plan: Itinerary, placeId: string) {
  return mustIncludePlaceability(plan, ctx(), placeId);
}

describe("MUST_INCLUDE_MISSING (error)", () => {
  it("rejects a plan that drops a placeable must-include, naming the day it fits", () => {
    const plan = romeWithout("place_007"); // Borghese Gallery
    expect(withCode(plan, "MUST_INCLUDE_MISSING")).toEqual([
      {
        code: "MUST_INCLUDE_MISSING",
        severity: "error",
        day: 0,
        placeId: "place_007",
        detail: "You asked for Borghese Gallery, and it fits on day 1, but it is not in the plan.",
      },
    ]);
  });

  it("counts a must-include that fits a day at another base only if the trip can add that base", () => {
    const plan = tripRome();
    plan.request.mustInclude = ["place_007", "place_010", "place_026"]; // plus the Uffizi
    expect(verdict(plan, "place_026")).toEqual({ placeable: true, day: 2 }); // day 3 has no must
    plan.request.anchors = ["rome"];
    expect(verdict(plan, "place_026")).toEqual({
      placeable: false,
      reason: "its base, Florence, is not one of the bases you chose",
    });
  });

  it("ignores other stops when looking for room, since a plan may drop them", () => {
    const plan = romeWithout("place_010"); // Vatican Museums gone; day 1 is still full of others
    expect(verdict(plan, "place_010")).toEqual({ placeable: true, day: 0 });
  });

  it("still finds room for a must-include restaurant as dinner on a day full of must-sees", () => {
    const plan = tripRome();
    plan.days = [dayOf(plan, 0)];
    const visits = ["place_001", "place_004", "place_005", "place_007", "place_077"];
    plan.request.mustInclude = [...visits, "place_020"]; // Il Sorpasso, lunch and dinner
    expect(verdict(plan, "place_020")).toEqual({ placeable: true, day: 0 });
  });

  it("reports a must-include listed twice only once", () => {
    const plan = romeWithout("place_007", { mustInclude: ["place_007", "place_007"] });
    expect(withCode(plan, "MUST_INCLUDE_MISSING")).toHaveLength(1);
  });

  it("says nothing about must-includes that are in the plan", () => {
    const plan = tripRome();
    const found = validateItinerary(plan, ctx()).filter((v) => v.code.startsWith("MUST_INCLUDE"));
    expect(found).toEqual([]);
  });
});

describe("MUST_INCLUDE_UNPLACEABLE (warning with the reason)", () => {
  it.each([
    ["an id not in the data", "place_999", "it is not in our data"],
    ["a place the traveler also excluded", "place_025", "you also asked to leave it out"],
  ])("explains %s instead of blocking the plan", (_label, id, reason) => {
    const plan = tripRome();
    plan.request.mustInclude = [...plan.request.mustInclude, id];
    expect(verdict(plan, id)).toEqual({ placeable: false, reason });
    expect(withCode(plan, "MUST_INCLUDE_UNPLACEABLE").map(key)).toEqual([
      `MUST_INCLUDE_UNPLACEABLE - ${id}`,
    ]);
  });

  it("does not demand both halves of a same-spot pair the traveler asked for", () => {
    const plan = tripRome(); // day 1 ends with Trevi Fountain by Night
    plan.request.mustInclude = [...plan.request.mustInclude, "place_077", "place_018"];
    expect(verdict(plan, "place_018")).toEqual({
      placeable: false,
      reason: "it is at the same spot as Trevi Fountain by Night, already in your plan",
    });
  });

  it("still demands a must-include whose same-spot twin is in the plan but was never asked for", () => {
    const plan = tripRome();
    plan.request.mustInclude = [...plan.request.mustInclude, "place_018"];
    expect(verdict(plan, "place_018").placeable).toBe(true);
  });

  it("explains a place closed for the season on every day at its base", () => {
    const plan = miniTrip({ startDate: "2026-11-03", mustInclude: ["place_035"] });
    ["2026-11-03", "2026-11-04", "2026-11-05"].forEach((date, i) => {
      dayOf(plan, i).date = date;
    });
    expect(withCode(plan, "MUST_INCLUDE_UNPLACEABLE")[0]).toEqual({
      code: "MUST_INCLUDE_UNPLACEABLE",
      severity: "warning",
      placeId: "place_035",
      detail:
        "Chianti Day Trip by Bike could not be included: it is closed on Thu 5 Nov 2026 (Open April-October only).",
    });
  });

  it("explains a dawn-only place that no relaxed day reaches in time", () => {
    const plan = miniTrip({ pace: "relaxed", mustInclude: ["place_023"] }); // Popolo at Dawn
    expect(verdict(plan, "place_023")).toEqual({
      placeable: false,
      reason: "its opening hours on Tue 20 Oct 2026 and Wed 21 Oct 2026 do not fit a relaxed day",
    });
  });

  it("explains a place whose base is not in a trip that already has two bases", () => {
    const plan = tripTuscany();
    plan.request.anchors = "auto";
    plan.request.mustInclude = [...plan.request.mustInclude, "place_067"]; // Doge's Palace
    expect(verdict(plan, "place_067")).toEqual({
      placeable: false,
      reason: "its base, Venice, is not in this trip, which already has 2 bases",
    });
  });

  it("explains a place when every day already holds other must-sees, so no day can move", () => {
    const plan = tripRome();
    plan.request.mustInclude = ["place_007", "place_010", "place_002", "place_026"];
    expect(verdict(plan, "place_026")).toEqual({
      placeable: false,
      reason: "no day of this trip is free to move to Florence",
    });
  });

  it("explains a place when its days are already full of other must-sees", () => {
    const plan = tripRome();
    plan.days = [dayOf(plan, 0)];
    plan.request.mustInclude = [
      "place_001",
      "place_004",
      "place_005",
      "place_007",
      "place_077",
      "place_017",
    ];
    expect(verdict(plan, "place_017")).toEqual({
      placeable: false,
      reason: "the time on Tue 20 Oct 2026 is already taken by other places you asked for",
    });
  });

  it("never turns an unplaceable must-include into an error", () => {
    const plan = miniTrip({ pace: "relaxed", mustInclude: ["place_023"] });
    const found = validateItinerary(plan, ctx()).filter((v) => v.code.startsWith("MUST_INCLUDE"));
    expect(found.map((v) => v.severity)).toEqual(["warning"]);
  });
});

describe("placeability on weekly closures", () => {
  it("explains a museum closed on the only day the trip spends at its base", () => {
    const plan = miniTrip({ startDate: "2026-10-19", mustInclude: ["place_007"] });
    ["2026-10-19", "2026-10-20", "2026-10-21"].forEach((date, i) => {
      dayOf(plan, i).date = date;
    });
    dayOf(plan, 1).anchorId = "florence"; // Rome only on Monday, when the Borghese is shut
    dayOf(plan, 1).transferMin = 130;
    dayOf(plan, 1).stops = [];
    dayOf(plan, 2).transferMin = 0;
    expect(verdict(plan, "place_007")).toEqual({
      placeable: false,
      reason: "it is closed on Mon 19 Oct 2026",
    });
  });
});
