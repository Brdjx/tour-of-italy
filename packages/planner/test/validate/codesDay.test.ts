import { describe, expect, it } from "vitest";
import { TRIP_DAYS } from "../../src/config";
import { validateItinerary } from "../../src/validate";
import { countVisits } from "../../src/validate/days";
import { ctx, dayOf, errorCodes, key, miniTrip, stopOf, withCode } from "./fixtures";
import { extraDay, paddingMealDetails, paddingWarnings } from "./tripLength";
import { itinerary, stop, tripRome } from "./trips";

// One test per trip- and day-level code, each on a small hand-made trip with real place ids.
// Each starts from the mini trip (no errors) and makes one change, then asserts the exact list of
// errors, so a check that fires for the wrong reason, or drags in noise, fails too.

describe("trip shape", () => {
  it("rejects a plan one day short of the trip (WRONG_DAY_COUNT)", () => {
    const plan = miniTrip();
    plan.days.pop();
    const short = TRIP_DAYS - 1;
    expect(errorCodes(plan)).toEqual(["WRONG_DAY_COUNT"]);
    expect(withCode(plan, "WRONG_DAY_COUNT")[0]?.detail).toBe(
      `This plan has ${short} ${short === 1 ? "day" : "days"}, but a trip has ${TRIP_DAYS}.`,
    );
  });

  it("rejects a plan one day too long, and a plan with no days (WRONG_DAY_COUNT)", () => {
    const plan = miniTrip();
    plan.days.push(extraDay(plan.request, plan.days));
    expect(errorCodes(plan)).toEqual(["WRONG_DAY_COUNT"]);
    plan.days = [];
    expect(errorCodes(plan)).toEqual(["WRONG_DAY_COUNT"]);
  });

  it("rejects three bases in one trip (TOO_MANY_ANCHORS)", () => {
    const plan = miniTrip();
    const day = dayOf(plan, 1);
    day.anchorId = "venice";
    day.transferMin = 185;
    day.stops = [stop("place_066", 760, 820, 5, "visit")]; // Rialto Bridge 12:40
    dayOf(plan, 2).transferMin = 120; // Venice to Florence
    expect(errorCodes(plan)).toEqual(["TOO_MANY_ANCHORS"]);
    expect(withCode(plan, "TOO_MANY_ANCHORS")[0]?.detail).toContain(
      "3 bases (Rome, Venice and Florence)",
    );
  });

  it("rejects a base id that does not exist (UNKNOWN_ANCHOR)", () => {
    const plan = miniTrip();
    // Every Florence day (the last base) moves to a base that does not exist.
    const moved = plan.days.filter((day) => day.anchorId === "florence");
    for (const day of moved) day.anchorId = "atlantis";
    const found = withCode(plan, "UNKNOWN_ANCHOR");
    expect(errorCodes(plan)).toEqual(moved.map(() => "UNKNOWN_ANCHOR"));
    expect(found[0]).toMatchObject({ severity: "error", day: 2 });
    expect(found[0]?.detail).not.toContain("atlantis"); // never echo unknown input back
  });
});

describe("day checks", () => {
  it("rejects a day whose date is not the start date plus its index (WRONG_DATE)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).date = "2026-10-23";
    expect(errorCodes(plan)).toEqual(["WRONG_DATE"]);
    expect(withCode(plan, "WRONG_DATE")[0]?.detail).toBe(
      "Day 2 is dated Fri 23 Oct 2026, but a trip starting Tue 20 Oct 2026 has Wed 21 Oct 2026 as day 2.",
    );
  });

  it("rejects an impossible date without crashing on it (WRONG_DATE)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).date = "2026-02-30";
    expect(errorCodes(plan)).toEqual(["WRONG_DATE"]);
  });

  it("rejects every day when the trip start date itself is not real (WRONG_DATE)", () => {
    const plan = miniTrip({ startDate: "2026-13-01" });
    expect(errorCodes(plan)).toEqual(Array(TRIP_DAYS).fill("WRONG_DATE"));
  });

  it("rejects a day with no stops (EMPTY_DAY)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).stops = [];
    expect(errorCodes(plan)).toEqual(["EMPTY_DAY"]);
    expect(withCode(plan, "EMPTY_DAY")[0]).toMatchObject({ day: 1, detail: "Day 2 has no stops." });
  });

  it("rejects a transfer shorter than the move between bases (WRONG_TRAVEL)", () => {
    const plan = miniTrip();
    dayOf(plan, 2).transferMin = 30;
    expect(errorCodes(plan)).toEqual(["WRONG_TRAVEL"]);
    expect(withCode(plan, "WRONG_TRAVEL")[0]?.detail).toBe(
      "Day 3 lists 30 min to move from Rome to Florence, but the move takes 2 h 10 min by high-speed train.",
    );
  });

  it("still uses the real transfer for the day window when the claim is too short", () => {
    const plan = miniTrip();
    const day = dayOf(plan, 2);
    day.transferMin = 0;
    day.stops = [stop("place_093", 580, 610, 10, "visit")]; // 09:40, before the train arrives
    expect(errorCodes(plan)).toEqual(["WRONG_TRAVEL", "OUTSIDE_DAY_WINDOW"]);
  });

  it.each([
    [0, 15, "Day 1 starts the trip, so it has no transfer, but it lists 15 min."],
    [
      1,
      20,
      "Day 2 stays in the same base as the day before, so it has no transfer, but it lists 20 min.",
    ],
    [2, -5, "Day 3 has a transfer time that is not a valid number of minutes."],
    [2, Number.NaN, "Day 3 has a transfer time that is not a valid number of minutes."],
  ])("rejects a made-up transfer on day index %i (%s min) (WRONG_TRAVEL)", (index, value, text) => {
    const plan = miniTrip();
    dayOf(plan, index).transferMin = value;
    expect(errorCodes(plan)).toEqual(["WRONG_TRAVEL"]);
    expect(withCode(plan, "WRONG_TRAVEL")[0]?.detail).toBe(text);
  });

  it("warns about a transfer over 3 hours but lets the plan through (LONG_TRANSFER)", () => {
    const mini = miniTrip();
    const venice = {
      date: dayOf(mini, 2).date,
      anchorId: "venice",
      transferMin: 185,
      stops: [stop("place_066", 760, 820, 5, "visit")], // Rialto Bridge
    };
    const plan = itinerary(mini.request, [dayOf(mini, 0), dayOf(mini, 1), venice]);
    expect(errorCodes(plan)).toEqual([]);
    expect(withCode(plan, "LONG_TRANSFER")).toEqual([
      {
        code: "LONG_TRANSFER",
        severity: "warning",
        day: 2,
        detail:
          "Day 3 starts with 3 h 5 min by high-speed train from Rome to Venice, so there is less time to visit.",
      },
    ]);
  });

  it("does not warn about a transfer under 3 hours (Rome to Florence is 2 h 10 min)", () => {
    expect(withCode(miniTrip(), "LONG_TRANSFER")).toEqual([]);
  });

  it("rejects more visits than the pace allows (TOO_MANY_VISITS)", () => {
    const plan = tripRome(); // day 1 holds exactly 5 visits, the balanced cap
    stopOf(plan, 0, 5).role = "visit"; // the dinner at Da Enzo becomes a sixth visit
    expect(errorCodes(plan)).toEqual(["TOO_MANY_VISITS"]);
    expect(withCode(plan, "TOO_MANY_VISITS")[0]?.detail).toBe(
      "Day 1 has 6 visits, but a balanced day has at most 5.",
    );
  });

  it("counts a second lunch or dinner as a visit, so meal labels cannot dodge the cap", () => {
    expect(countVisits([{ role: "visit" }, { role: "lunch" }, { role: "dinner" }])).toBe(1);
    expect(countVisits([{ role: "lunch" }, { role: "lunch" }, { role: "dinner" }])).toBe(1);
    expect(countVisits([{ role: "dinner" }, { role: "dinner" }, { role: "dinner" }])).toBe(2);
  });

  it("warns once for each missing lunch and dinner, and never on an empty day (MEAL_MISSING)", () => {
    const plan = miniTrip();
    dayOf(plan, 1).stops = [];
    const meals = validateItinerary(plan, ctx()).filter((v) => v.code === "MEAL_MISSING");
    expect(meals.map(key)).toEqual([
      "MEAL_MISSING 0 -",
      "MEAL_MISSING 2 -",
      "MEAL_MISSING 2 -",
      ...paddingWarnings(),
    ]);
    expect(meals.map((v) => v.detail)).toEqual([
      "Day 1 has no dinner stop.",
      "Day 3 has no lunch stop.",
      "Day 3 has no dinner stop.",
      ...paddingMealDetails(),
    ]);
    expect(meals.every((v) => v.severity === "warning")).toBe(true);
  });
});
