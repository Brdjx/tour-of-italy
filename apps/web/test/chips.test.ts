import type { Violation } from "@italy/planner";
import { describe, expect, it } from "vitest";
import {
  flaggedStopCount,
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
