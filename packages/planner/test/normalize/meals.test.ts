import { describe, expect, it } from "vitest";
import { EXTRA_MEAL_PLACES } from "../../src/config";
import { mealFits, normalizeMeals } from "../../src/normalize/meals";
import { makeWeek, WEEKDAYS } from "../../src/time";
import type { DateRule, Meal, Place } from "../../src/types";
import { place, realResult } from "../helpers";

// Place.meals is read as a fact by the AI shortlist, the swap list, and the planner. A meal a
// place can never serve would be offered, rejected by the validator, and cost a repair turn or a
// fallback. These tests prove every listed meal fits the place's hours on some open day.

/** True when some open weekday (after weekday rules) can hold the meal. */
function servable(p: Place, meal: Meal): boolean {
  if (p.hours === null) return true;
  const hours = p.hours;
  return WEEKDAYS.some(
    (day) =>
      p.dateRules.every((rule) => rule.kind !== "weekdays" || rule.days.includes(day)) &&
      hours[day].some((range) => mealFits(range, meal, p.durationMin)),
  );
}

describe("meals on the real data", () => {
  it("never lists a meal a place cannot serve on any open day", () => {
    for (const p of realResult().places) {
      for (const meal of p.meals) expect(servable(p, meal), `${p.id} ${meal}`).toBe(true);
    }
  });

  it.each(["place_009", "place_041", "place_043", "place_050"])(
    "never offers the evening-only restaurant %s for lunch",
    (id) => {
      expect(place(id).meals).toEqual(["dinner"]);
      expect(place(id).issues.map((issue) => issue.kind)).toContain("meal_unavailable");
    },
  );

  it("never offers Cantina di Parma, open only at midday, for dinner", () => {
    expect(place("place_092").meals).toEqual(["lunch"]);
  });

  it("keeps mealCapable in step with meals", () => {
    for (const p of realResult().places) expect(p.mealCapable, p.id).toBe(p.meals.length > 0);
  });

  it("counts 14 restaurants for both meals, 4 for dinner only, and 1 for lunch only", () => {
    const restaurants = realResult().places.filter((p) => p.type === "restaurant");
    const count = (meals: string) => restaurants.filter((p) => p.meals.join("+") === meals).length;
    expect([count("lunch+dinner"), count("dinner"), count("lunch")]).toEqual([14, 4, 1]);
  });
});

describe("the meal allowlist", () => {
  const ids = new Set(realResult().places.map((p) => p.id));

  it("names only real places, so a mistyped id cannot be silently ignored", () => {
    for (const id of Object.keys(EXTRA_MEAL_PLACES)) expect(ids.has(id), id).toBe(true);
  });

  it("never lists a restaurant, which is already meal-capable", () => {
    for (const id of Object.keys(EXTRA_MEAL_PLACES)) {
      expect(place(id).type, id).not.toBe("restaurant");
    }
  });

  it("gives every allowlisted place at least one meal its hours allow", () => {
    for (const [id, entry] of Object.entries(EXTRA_MEAL_PLACES)) {
      expect(place(id).meals, id).toEqual(entry.meals);
    }
  });
});

describe("normalizeMeals", () => {
  const base = { placeId: "p", type: "restaurant" as const, durationMin: 90, dateRules: [] };

  it("keeps both meals when the hours are unknown, because the day window decides", () => {
    expect(normalizeMeals({ ...base, hours: null })).toEqual({
      value: ["lunch", "dinner"],
      issues: [],
    });
  });

  it("drops lunch when the only lunch service is shorter than the meal", () => {
    const hours = makeWeek(WEEKDAYS, [
      { open: 750, close: 840 },
      { open: 1200, close: 1320 },
    ]);
    const { value, issues } = normalizeMeals({ ...base, durationMin: 120, hours });
    expect(value).toEqual(["dinner"]);
    expect(issues.map((issue) => issue.kind)).toEqual(["meal_unavailable"]);
  });

  it("drops dinner when the only evening opening is on a day a note closes", () => {
    const hours = makeWeek([1], [{ open: 1140, close: 1380 }]);
    const dateRules: DateRule[] = [{ kind: "weekdays", days: [0, 2, 3, 4, 5, 6], source: "x" }];
    expect(normalizeMeals({ ...base, hours, dateRules }).value).toEqual([]);
  });

  it("allows a lunch that starts at the last allowed minute and fits before closing", () => {
    expect(mealFits({ open: 870, close: 960 }, "lunch", 90)).toBe(true);
    expect(mealFits({ open: 871, close: 1000 }, "lunch", 90)).toBe(false);
    expect(mealFits({ open: 600, close: 809 }, "lunch", 90)).toBe(false);
  });
});
