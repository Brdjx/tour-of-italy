import { describe, expect, it } from "vitest";
import * as planner from "../src/index";

// The API, the web app, and the scheduler and validator engineers import the planner core from
// the package entry point. Two `export *` lines that export the same name make that name vanish
// silently at runtime, so this test pins every public function of the planner core.

const PLANNER_CORE_FUNCTIONS = [
  // travel.ts
  "haversineKm",
  "travelModeForKm",
  "travelMinutesForKm",
  "travelMinutes",
  "travelMode",
  "travelLabel",
  "travelLabelFor",
  "travelLeg",
  "formatDuration",
  // anchors.ts
  "anchorSlug",
  "buildAnchors",
  "transferMinutes",
  "dayOrigin",
  "compareText",
  // context.ts
  "buildPlannerContext",
  "placesOfAnchor",
  "anchorOfPlace",
  "twinIds",
  // constraints.ts
  "isOpenDuring",
  "earliestOpenStart",
  "earliestMealStart",
  "dayWindow",
  "withinDayWindow",
  "mealWindowAllows",
  "belongsToAnchor",
  "withinBudget",
  "isMealPlace",
  "servesMeal",
  "isSuggestable",
  "isExcluded",
  "sharesLocation",
  "isCandidate",
  "isOuting",
  "coversMeal",
  // score.ts
  "interestShare",
  "scoreParts",
  "scorePlace",
  "compareScored",
  // reasons.ts
  "ruleReason",
  "isHighestRated",
  // orderDay.ts
  "orderDay",
  // schedule.ts, plan.ts, and validate.ts
  "scheduleDay",
  "planDeterministic",
  "planWarnings",
  "validateItinerary",
] as const;

// Decision: read the namespace through Object.entries, the static way to list what it exports.
const exported = new Map<string, unknown>(Object.entries(planner));

describe("planner entry point", () => {
  it.each(PLANNER_CORE_FUNCTIONS)(
    "exports %s as a function, so no caller gets undefined",
    (name) => {
      expect(typeof exported.get(name)).toBe("function");
    },
  );

  it("never drops the shared constants the scheduler reads", () => {
    expect(planner.SAME_SPOT_LABEL).toBe("Same spot, no travel");
    expect(planner.DEFAULT_RATING).toBe(3.5);
    expect(planner.OUTING_MIN_MINUTES).toBe(240);
    expect(planner.MAX_TRAVEL_MINUTES).toBe(1440);
    expect(planner.ID_MAX_CHARS).toBe(64);
    expect(planner.DETAIL_MAX_CHARS).toBe(500);
  });
});
