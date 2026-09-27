import type { MealGap, MealGapPlace, Violation } from "@italy/planner";
import { describe, expect, it } from "vitest";
import {
  dayChips,
  flaggedStopCount,
  mealChip,
  missingMeal,
  stopChips,
  tripViolations,
  violationChip,
  violationLabel,
  violationsForDay,
  WARNING_NEXT_STEP,
} from "../lib/chips";
import { ctx, must, place } from "./fixtures";

// Chips carry every caveat on a stop or a day. Errors come first, nothing is said twice, and
// each explanation says what is wrong and what to do about it.

describe("chips", () => {
  it("puts errors before warnings before data notes, and never says 'Hours not confirmed' twice", () => {
    const unknownHours = must(
      ctx.places.find((candidate) => candidate.hoursConfidence === "unknown"),
    );
    const warning: Violation = {
      code: "HOURS_UNKNOWN",
      severity: "warning",
      day: 0,
      stopIndex: 0,
      detail: "No hours for this date.",
    };
    const error: Violation = {
      ...warning,
      code: "OVERLAP",
      severity: "error",
      detail: "Too tight.",
    };
    const chips = stopChips(unknownHours, [warning, error]);
    expect(chips.map((chip) => chip.tone).slice(0, 2)).toEqual(["error", "warning"]);
    expect(chips.filter((chip) => chip.label === "Hours not confirmed")).toHaveLength(1);
    expect(chips[0]?.explanation).toBe(
      "Too tight. Undo the last change, or swap or remove this stop.",
    );
    expect(stopChips(unknownHours, []).some((chip) => chip.label === "Hours not confirmed")).toBe(
      true,
    );
  });

  it("explains the repaired Brera location as approximate", () => {
    const chips = stopChips(place("place_059"), []);
    expect(chips.map((chip) => chip.label)).toContain("Approximate location");
    expect(stopChips(undefined, [])).toEqual([]);
  });

  it("tells the traveler what to do about each warning, not only what is wrong", () => {
    const missing: Violation = {
      code: "MEAL_MISSING",
      severity: "warning",
      day: 0,
      detail: "Day 1 has no dinner stop.",
    };
    expect(violationChip(missing).explanation).toBe(
      `Day 1 has no dinner stop. ${WARNING_NEXT_STEP.MEAL_MISSING}`,
    );
    for (const [code, step] of Object.entries(WARNING_NEXT_STEP)) {
      const chip = violationChip({
        code,
        severity: "warning",
        day: 0,
        detail: "What is wrong.",
      } as Violation);
      expect(chip.explanation).toBe(`What is wrong. ${step}`);
      expect(step).not.toContain(String.fromCharCode(0x2014));
    }
    // "check before you go" is already the next step in this detail.
    const hours = violationChip({ code: "HOURS_UNKNOWN", severity: "warning", detail: "Check." });
    expect(hours.explanation).toBe("Check.");
  });

  it("calls the pace limit a visit limit, the unit it counts", () => {
    expect(violationLabel("TOO_MANY_VISITS")).toBe("Too many visits for your pace");
  });

  it("sorts violations into stop, day and trip levels", () => {
    const list: Violation[] = [
      { code: "MUST_INCLUDE_UNPLACEABLE", severity: "warning", placeId: "place_001", detail: "x" },
      { code: "MEAL_MISSING", severity: "warning", day: 1, detail: "y" },
      { code: "OVER_BUDGET", severity: "warning", day: 1, stopIndex: 0, detail: "z" },
    ];
    expect(tripViolations(list)).toHaveLength(1);
    expect(violationsForDay(list, 1)).toHaveLength(1);
    expect(violationChip(must(list[2])).label).toBe("Above your budget");
  });
});

describe("flaggedStopCount", () => {
  it("counts each stop with an error once, and no day, trip or warning", () => {
    const on = (day: number | undefined, stopIndex: number | undefined): Violation => ({
      code: "OVERLAP",
      severity: "error",
      ...(day === undefined ? {} : { day }),
      ...(stopIndex === undefined ? {} : { stopIndex }),
      detail: "x",
    });
    expect(flaggedStopCount([])).toBe(0);
    expect(flaggedStopCount([on(0, 1), { ...on(0, 1), code: "CLOSED_AT_TIME" }])).toBe(1);
    expect(flaggedStopCount([on(0, 1), on(1, 1), on(0, undefined), on(undefined, undefined)])).toBe(
      2,
    );
    expect(flaggedStopCount([{ ...on(0, 2), severity: "warning" }])).toBe(0);
  });
});

// A day with no lunch or dinner (decision 17): the chip names the meal and its cause, and offers
// only a way out that can work. The owner's Monday in Bologna said "Meal missing" and to swap a
// stop near that meal time, when no place of Bologna serves dinner on Mondays.
describe("a missing meal's chip", () => {
  const dinner: Violation = {
    code: "MEAL_MISSING",
    severity: "warning",
    day: 2,
    detail: "Day 3 has no dinner stop.",
  };
  const lunch: Violation = { ...dinner, detail: "Day 3 has no lunch stop." };

  function spot(overrides: Partial<MealGapPlace>): MealGapPlace {
    return {
      placeId: "place_x",
      name: "A place",
      town: null,
      block: null,
      why: "",
      overBudget: false,
      day: null,
      ...overrides,
    };
  }

  function gap(overrides: Partial<MealGap>): MealGap {
    return {
      day: 2,
      meal: "dinner",
      cause: "not_planned",
      text: "A place could take dinner that day.",
      places: [],
      ...overrides,
    };
  }

  const closed = (name: string) =>
    spot({ name, block: "closed_weekday", why: "closed on Mondays" });

  it("reads the meal from the validator's words and the scheduler's", () => {
    expect(missingMeal(dinner)).toBe("dinner");
    expect(missingMeal({ detail: "No lunch stop on this day." })).toBe("lunch");
    expect(missingMeal({ detail: "No lunch." })).toBeNull();
  });

  it("says none is open, names the places with a town outside the city, and offers another city, never a swap", () => {
    const places = [
      { ...closed("Osteria Francescana"), town: "Modena" },
      ...["Trattoria Anna Maria", "Enoteca Italiana, Bologna"].map(closed),
    ];
    const text = "The three dinner places listed for Bologna are all closed on Mondays.";
    const chip = mealChip(dinner, gap({ cause: "none_open", text, places }), 3, true);
    expect(chip).toEqual({
      key: "MEAL_MISSING--3",
      label: "No dinner open",
      tone: "warning",
      explanation: text,
      // The sentence says why for them all, so each name stands alone.
      places: [
        { name: "Osteria Francescana, Modena", why: null },
        { name: "Trattoria Anna Maria", why: null },
        { name: "Enoteca Italiana, Bologna", why: null },
      ],
      wayOut: "Choose another city for this day to have dinner in the plan.",
      action: "city",
    });
    expect(`${chip.explanation} ${chip.wayOut}`).not.toMatch(/swap/i);
  });

  it("gives each place its own reason when the reasons differ", () => {
    const places = [
      spot({
        name: "Via Drapperie, Bologna",
        block: "out_of_reach",
        why: "not reachable in time that day",
      }),
      closed("Trattoria Anna Maria"),
    ];
    const chip = mealChip(lunch, gap({ meal: "lunch", cause: "none_open", places }));
    expect(chip.label).toBe("No lunch open");
    expect(chip.places).toEqual([
      { name: "Via Drapperie, Bologna", why: "not reachable in time that day" },
      { name: "Trattoria Anna Maria", why: "closed on Mondays" },
    ]);
  });

  it("offers the swap when a place off the trip and within the budget could take the meal", () => {
    const chip = mealChip(
      dinner,
      gap({ text: "Enoteca Italiana, Bologna could take dinner that day.", places: [spot({})] }),
    );
    expect(chip).toEqual({
      key: "MEAL_MISSING--0",
      label: "No dinner planned",
      tone: "warning",
      explanation:
        "Enoteca Italiana, Bologna could take dinner that day. Swap a stop near dinner time for it.",
    });
  });

  it("names Undo only when the Undo on screen gives the day its meal back", () => {
    // A new plan has nothing to undo (design review, 2026-09-26: it told the traveler to undo a
    // change they never made); after taking the dinner off, Undo brings it back.
    const one = gap({
      text: "Enoteca Italiana, Bologna could take dinner that day.",
      places: [spot({})],
    });
    expect(mealChip(dinner, one, 0, true).explanation).toBe(
      "Enoteca Italiana, Bologna could take dinner that day. Swap a stop near dinner time for it, or undo your last change.",
    );
    const two = gap({ places: [spot({ name: "A" }), spot({ name: "B" })] });
    expect(mealChip(dinner, two).wayOut).toBe("Swap a stop near dinner time for one of them.");
    expect(mealChip(dinner, two, 0, true).wayOut).toBe(
      "Swap a stop near dinner time for one of them, or undo your last change.",
    );
    const held = gap({ places: [spot({ day: 0 })] });
    expect(mealChip(dinner, held).wayOut).toBe("Choose another city for this day.");
    expect(mealChip(dinner, held, 0, true).wayOut).toBe(
      "Choose another city for this day, or undo your last change.",
    );
    for (const chip of [mealChip(dinner, one), mealChip(dinner, two), mealChip(dinner, held)]) {
      expect(`${chip.explanation} ${chip.wayOut ?? ""}`).not.toMatch(/undo/i);
    }
    // The meals Undo gives back, from dayChips, per meal.
    const both = dayChips(
      [lunch, dinner],
      [gap({ meal: "lunch", places: [spot({ day: 0 })] }), held],
      (meal) => meal === "dinner",
    );
    expect(both.map((chip) => chip.wayOut)).toEqual([
      "Choose another city for this day.",
      "Choose another city for this day, or undo your last change.",
    ]);
  });

  it("names the places a swap could bring in when the sentence only counts them", () => {
    const text = "Three places listed for Venice could take dinner that day.";
    const places = ["Antiche Carampane", "Osteria alle Testiere", "Al Covo"].map((name) =>
      spot({ name }),
    );
    const held = spot({ name: "Harry's Bar", day: 0 });
    const away = spot({ name: "Da Romano", town: "Burano" });
    const chip = mealChip(dinner, gap({ text, places: [...places, away, held] }));
    expect(chip).toMatchObject({
      label: "No dinner planned",
      explanation: text,
      places: [
        ...places.map((place) => ({ name: place.name, why: null })),
        { name: "Da Romano, Burano", why: null },
      ],
      wayOut: "Swap a stop near dinner time for one of them.",
    });
    expect(chip.action).toBeUndefined();
  });

  it("offers another city, with the day that has each place, when every one is in the trip", () => {
    const places = [
      spot({ name: "Da Vittorio", day: 0 }),
      spot({ name: "Luini", day: 1 }),
      closed("Trattoria Milanese"),
    ];
    const text =
      "Every place listed for Milan that could take dinner that day is already in the trip.";
    const chip = mealChip(dinner, gap({ text, places }));
    expect(chip).toMatchObject({
      label: "No dinner planned",
      explanation: text,
      places: [
        { name: "Da Vittorio", why: "on day 1" },
        { name: "Luini", why: "on day 2" },
      ],
      wayOut: "Choose another city for this day.",
      action: "city",
    });
  });

  it("says a place is over the budget only beside places on a day, since the sentence says it otherwise", () => {
    const over = spot({ name: "Al Quadri, Venice", overBudget: true });
    const alone = mealChip(dinner, gap({ places: [over] }));
    expect(alone.places).toEqual([{ name: "Al Quadri, Venice", why: null }]);
    expect(alone.action).toBe("city");
    const mixed = mealChip(dinner, gap({ places: [over, spot({ name: "Harry's Bar", day: 0 })] }));
    expect(mixed.places).toEqual([
      { name: "Al Quadri, Venice", why: "over your budget" },
      { name: "Harry's Bar", why: "on day 1" },
    ]);
  });

  it("keeps the validator's words when the planner cannot say why", () => {
    const unread = mealChip(dinner, gap({ text: "" }));
    expect(unread.label).toBe("No dinner planned");
    expect(unread.explanation).toBe(`Day 3 has no dinner stop. ${WARNING_NEXT_STEP.MEAL_MISSING}`);
    expect(mealChip(dinner, undefined).label).toBe("Meal missing");
  });

  it("pairs each of a day's missing meals with its own cause", () => {
    const transfer: Violation = { ...dinner, code: "LONG_TRANSFER", detail: "A long way." };
    const chips = dayChips(
      [lunch, dinner, transfer],
      [
        gap({ meal: "lunch", cause: "none_open", text: "No lunch.", places: [closed("A")] }),
        gap({ cause: "none_open", text: "No dinner.", places: [closed("B")] }),
      ],
    );
    expect(chips.map((chip) => chip.label)).toEqual([
      "No lunch open",
      "No dinner open",
      "Long transfer",
    ]);
    expect(chips.map((chip) => chip.key)).toEqual([
      "MEAL_MISSING--0",
      "MEAL_MISSING--1",
      "LONG_TRANSFER--2",
    ]);
  });
});
