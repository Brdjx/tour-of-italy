import { describe, expect, it } from "vitest";
import {
  defaultFormValues,
  hasErrors,
  localIsoDate,
  type TripFormValues,
  toggleValue,
  toTripRequest,
  validateTripForm,
  valuesFromRequest,
} from "../lib/tripForm";
import { LIMITS } from "../lib/tripOptions";
import { baseRequest } from "./fixtures";

// The form must never send a request the API would reject, and must say which field to fix.

const valid = (overrides: Partial<TripFormValues> = {}): TripFormValues => ({
  ...defaultFormValues(new Date(2026, 8, 23)),
  ...overrides,
});

describe("defaults", () => {
  it("starts two weeks out in the traveler's own calendar, across a month end", () => {
    expect(valid().startDate).toBe("2026-10-07");
    expect(defaultFormValues(new Date(2026, 11, 25)).startDate).toBe("2027-01-08");
    expect(localIsoDate(new Date(2028, 1, 29))).toBe("2028-02-29");
  });

  it("produces a request the shared schema accepts without any input", () => {
    const request = toTripRequest(valid());
    expect(request).toMatchObject({ pace: "balanced", anchors: "auto", maxPriceLevel: null });
    expect(request).not.toHaveProperty("notes");
  });
});

describe("validateTripForm", () => {
  it("accepts the defaults", () => {
    expect(validateTripForm(valid(), LIMITS)).toEqual({});
  });

  it("names a missing, impossible, or out-of-range start date", () => {
    expect(validateTripForm(valid({ startDate: "" }), LIMITS).startDate).toBe("Pick a start date.");
    expect(validateTripForm(valid({ startDate: "2026-02-30" }), LIMITS).startDate).toBe(
      "Enter a real date, for example 2026-10-06.",
    );
    expect(validateTripForm(valid({ startDate: "1999-12-31" }), LIMITS).startDate).toBe(
      "Pick a date between 2000 and 2100.",
    );
  });

  it("asks for a base when the traveler chose to pick bases but picked none", () => {
    const errors = validateTripForm(valid({ anchorMode: "choose", anchors: [] }), LIMITS);
    expect(errors.anchors).toBe("Pick at least one base, or let the planner choose.");
    const three = validateTripForm(
      valid({ anchorMode: "choose", anchors: ["rome", "florence", "milan"] }),
      LIMITS,
    );
    expect(three.anchors).toBe("Pick at most 2 bases.");
  });

  it("enforces the API's list limits before sending", () => {
    const many = Array.from({ length: 11 }, (_, index) => `place_${index}`);
    const errors = validateTripForm(
      valid({
        interests: many.slice(0, 9),
        mustInclude: many,
        exclude: many.map((id) => `${id}x`),
      }),
      LIMITS,
    );
    expect(errors.interests).toBe("Pick at most 8 interests.");
    expect(errors.mustInclude).toBe("Pick at most 10 places.");
    expect(errors.exclude).toBe("Pick at most 10 places.");
  });

  it("refuses a place that is both a must-see and skipped", () => {
    const errors = validateTripForm(
      valid({ mustInclude: ["place_001"], exclude: ["place_001"] }),
      LIMITS,
    );
    expect(errors.exclude).toBe("A place cannot be both a must-see and skipped.");
    expect(hasErrors(errors)).toBe(true);
  });

  it("counts notes after trimming, like the API", () => {
    const padded = `  ${"a".repeat(500)}  `;
    expect(validateTripForm(valid({ notes: padded }), LIMITS).notes).toBeUndefined();
    expect(validateTripForm(valid({ notes: "a".repeat(501) }), LIMITS).notes).toBe(
      "Keep notes to 500 characters or fewer.",
    );
  });
});

describe("toTripRequest", () => {
  it("trims notes and keeps them as plain text, markup included", () => {
    const request = toTripRequest(valid({ notes: "  <script>alert(1)</script>  " }));
    expect(request?.notes).toBe("<script>alert(1)</script>");
  });

  it("returns null when the shared schema refuses the values", () => {
    expect(toTripRequest(valid({ startDate: "tomorrow" }))).toBeNull();
    expect(toTripRequest(valid({ interests: ["food", "food"] }))).toBeNull();
  });

  it("round-trips a request through the form values", () => {
    const request = { ...baseRequest, anchors: ["rome"], notes: "Slow mornings" };
    expect(toTripRequest(valuesFromRequest(request))).toEqual(request);
    expect(toTripRequest(valuesFromRequest(baseRequest))).toEqual(baseRequest);
  });
});

describe("toggleValue", () => {
  it("adds, removes, and stops at the cap", () => {
    expect(toggleValue(["a"], "b", 2)).toEqual(["a", "b"]);
    expect(toggleValue(["a", "b"], "a", 2)).toEqual(["b"]);
    expect(toggleValue(["a", "b"], "c", 2)).toEqual(["a", "b"]);
  });
});
