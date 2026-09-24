import { compareViolations, type Violation, validateItinerary } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { PlanResponseSchema } from "../../src/contract";
import { shippedData } from "../../src/data";
import { makeApp, postPlan, tripBody } from "../helpers/app";
import { expectValidItinerary } from "../helpers/validPlan";

// Failure vector F10: the browser re-validates every plan with @italy/planner. If the warnings
// the server sends differ from what the planner package computes for the same JSON, the UI and
// the server disagree about the same plan. These run the real JSON round trip.

const { ctx } = shippedData();

function sorted(violations: readonly Violation[]): Violation[] {
  return [...violations].sort(compareViolations);
}

const REQUESTS: [string, Record<string, unknown>][] = [
  ["balanced, history and food", {}],
  ["relaxed in Venice", { pace: "relaxed", anchors: ["venice"], interests: ["romantic"] }],
  ["packed, two bases", { pace: "packed", anchors: ["rome", "florence"], interests: ["art"] }],
  ["budget only", { maxPriceLevel: 1, interests: ["local-favorite"] }],
  ["must-include in Bologna", { mustInclude: ["place_043"], anchors: ["bologna"] }],
  ["winter dates", { startDate: "2026-12-30", interests: ["views"] }],
];

describe("server warnings match the planner package run on the same JSON", () => {
  for (const scenario of ["valid", "unknown-id-then-valid", "always-invalid"]) {
    for (const [name, overrides] of REQUESTS) {
      it(`gives identical violations for "${name}" (${scenario})`, async () => {
        const { app } = makeApp();

        const res = await postPlan(app, tripBody(overrides), { scenario });
        const json = await res.json();

        const itinerary = PlanResponseSchema.parse(json);
        expectValidItinerary(itinerary, ctx);
        const inBrowser = validateItinerary(itinerary, ctx);
        expect(inBrowser.filter((v) => v.severity === "error")).toEqual([]);
        expect(sorted(itinerary.warnings)).toEqual(sorted(inBrowser));
      });
    }
  }

  it("survives a second JSON round trip unchanged, so shared links validate the same", async () => {
    const { app } = makeApp();
    const json = await (await postPlan(app, tripBody(), { scenario: "valid" })).json();

    const first = PlanResponseSchema.parse(json);
    const again = PlanResponseSchema.parse(JSON.parse(JSON.stringify(first)));

    expect(again).toEqual(json);
    expect(validateItinerary(again, ctx)).toEqual(validateItinerary(first, ctx));
  });
});
