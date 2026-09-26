import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDayBase } from "../src/dayBases";
import { planRoute } from "../src/dayRoute";
import { planDeterministic } from "../src/plan";
import * as planDayModule from "../src/planDay";
import type { TripRequest } from "../src/types";
import { realContext } from "./plannerFixtures";

// The last guard of a route and of a one-day check: a day the rules plan that would give the trip
// a new error is refused with the validator's words, never planned. The rules never make such a
// day (the property tests over random routes find none), so this file makes planDay return one.

vi.mock("../src/planDay", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/planDay")>();
  return { ...real, planDay: vi.fn(real.planDay) };
});

const ctx = realContext();
const req: TripRequest = {
  startDate: "2026-10-19",
  pace: "balanced",
  interests: ["historic"],
  maxPriceLevel: null,
  anchors: ["rome"],
  mustInclude: [],
  exclude: [],
};
const days = planDeterministic(req, ctx).days.map((day) => ({
  anchorId: day.anchorId,
  placeIds: day.stops.map((stop) => stop.placeId),
}));
const repeated = days[0]?.placeIds[0] as string;

/** planDay answers once with a Florence day that repeats a place of day 1. */
function repeatOnce() {
  vi.mocked(planDayModule.planDay).mockImplementationOnce(() => ({
    anchorId: "florence",
    placeIds: ["place_093", repeated],
  }));
}

afterEach(() => {
  vi.mocked(planDayModule.planDay).mockClear();
});

describe("a day that would add an error", () => {
  it("refuses the route with the validator's detail and the day to change", () => {
    repeatOnce();
    const plan = planRoute(req, days, ["rome", "rome", "florence"], ctx);

    expect(plan.allowed).toBe(false);
    expect(plan.rulesDays).toBeNull();
    expect(plan.refusal).toMatchObject({
      day: 2,
      code: "new_error",
      fix: "Choose another city for day 3.",
    });
    expect(plan.refusal?.reason.length).toBeGreaterThan(0);
  });

  it("refuses the one-day check the same way", () => {
    repeatOnce();
    const option = checkDayBase(req, days, 2, "florence", ctx).option;

    expect(option).toMatchObject({
      allowed: false,
      refusal: "new_error",
      fix: "Choose another city for day 3.",
    });
  });
});
