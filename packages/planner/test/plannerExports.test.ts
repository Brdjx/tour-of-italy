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
  "compareText",
  // context.ts
  "buildPlannerContext",
  "placesOfAnchor",
  "anchorOfPlace",
  // constraints.ts
  "isOpenDuring",
  "earliestOpenStart",
  "earliestMealStart",
  "dayWindow",
  "withinDayWindow",
  "mealWindowAllows",
  "mealRoleFor",
  "belongsToAnchor",
  "withinBudget",
  "isMealPlace",
  "servesMeal",
  "isSuggestable",
  "isExcluded",
  "sharesLocation",
  "isCandidate",
  // score.ts
  "interestShare",
  "scoreParts",
  "scorePlace",
  "compareScored",
  "rankPlaces",
  // reasons.ts
  "ruleReason",
  // schedule.ts and validate.ts
  "scheduleDay",
  "planDeterministic",
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

  it("exports the shared constants the scheduler reads", () => {
    expect(planner.SAME_SPOT_LABEL).toBe("Same spot, no travel");
    expect(planner.DEFAULT_RATING).toBe(3.5);
  });
});
