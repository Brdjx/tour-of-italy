import { describe, expect, it } from "vitest";
import { planRoute } from "../../src/dayRoute";
import { planDeterministic } from "../../src/plan";
import { type DaySelection, scheduleTrip } from "../../src/trip";
import type { Itinerary, TripRequest } from "../../src/types";
import { validateItinerary } from "../../src/validate";
import { ctx } from "./fixtures";

// The validator on routes the traveler sets by hand, with two changes of base: away for a day and
// back (Rome, Florence, Rome), and a city a day (Rome, Florence, Venice). The transfers are
// recomputed day by day, a must-include of a base the route has is judged on that base's own days
// with their real windows, and one whose base the route does not have stays a warning.

const request: TripRequest = {
  startDate: "2026-10-19", // a Monday: the Borghese Gallery is closed on day 1
  pace: "balanced",
  interests: ["historic"],
  maxPriceLevel: null,
  anchors: ["rome"],
  mustInclude: [],
  exclude: [],
};
const rome = planDeterministic(request, ctx()).days.map((day) => ({
  anchorId: day.anchorId,
  placeIds: day.stops.map((stop) => stop.placeId),
}));

/** The route's rules-only days as a timed plan, for the request given. */
function routePlan(route: string[], req: TripRequest = request): Itinerary {
  const days = planRoute(request, rome, route, ctx()).rulesDays as DaySelection[];
  return {
    request: req,
    days: scheduleTrip(req, days, ctx()).days,
    source: "deterministic",
    warnings: [],
    meta: { attempts: 0, latencyMs: 0, generatedAt: "2026-09-26T00:00:00.000Z" },
  };
}

const errors = (plan: Itinerary) =>
  validateItinerary(plan, ctx()).filter((v) => v.severity === "error");

describe("a route away for a day and back", () => {
  const aba = routePlan(["rome", "florence", "rome"]);

  it("passes with a transfer each way, and catches a transfer claimed wrong on the way back", () => {
    expect(aba.days.map((day) => day.transferMin)).toEqual([0, 130, 130]);
    expect(errors(aba)).toEqual([]);
    const wrong = structuredClone(aba);
    (wrong.days[2] as Itinerary["days"][number]).transferMin = 0;
    expect(errors(wrong)).toMatchObject([
      {
        code: "WRONG_TRAVEL",
        day: 2,
        detail:
          "Day 3 lists 0 min to move from Florence to Rome, but the move takes 2 h 10 min by high-speed train.",
      },
    ]);
  });

  it("judges a missing must-include of the first base on its days, day 3 after its travel", () => {
    const plan = routePlan(["rome", "florence", "rome"], {
      ...request,
      mustInclude: ["place_007"],
    });
    expect(plan.days.flatMap((day) => day.stops.map((stop) => stop.placeId))).not.toContain(
      "place_007",
    );

    expect(errors(plan)).toEqual([
      expect.objectContaining({
        code: "MUST_INCLUDE_MISSING",
        day: 2,
        placeId: "place_007",
        detail: "You asked for Borghese Gallery, and it fits on day 3, but it is not in the plan.",
      }),
    ]);
  });

  it("keeps a must-include of a base the route does not have a warning", () => {
    // Rialto Bridge, Venice.
    const plan = routePlan(["rome", "florence", "rome"], {
      ...request,
      anchors: "auto",
      mustInclude: ["place_066"],
    });
    const found = validateItinerary(plan, ctx()).filter((v) => v.placeId === "place_066");

    expect(found).toEqual([
      expect.objectContaining({
        code: "MUST_INCLUDE_UNPLACEABLE",
        severity: "warning",
        detail:
          "Rialto Bridge could not be included: its base, Venice, is not in this trip, which already has 2 bases.",
      }),
    ]);
  });
});

describe("a route with a city a day", () => {
  it("passes Rome, Florence, Venice, and keeps a must-include of Bologna a warning", () => {
    const plan = routePlan(["rome", "florence", "venice"], {
      ...request,
      anchors: "auto",
      mustInclude: ["place_045"],
    });

    expect(plan.days.map((day) => day.transferMin)).toEqual([0, 130, 120]);
    expect(errors(plan)).toEqual([]);
    const found = validateItinerary(plan, ctx()).find((v) => v.placeId === "place_045");
    expect(found?.detail).toBe(
      "Ferrari Museum, Maranello could not be included: its base, Bologna, is not in this trip, which already has 3 bases.",
    );
  });
});
