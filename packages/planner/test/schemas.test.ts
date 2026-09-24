import { describe, expect, it } from "vitest";
import { buildDataset } from "../src/data";
import { DataSummarySchema } from "../src/dataSchemas";
import { ItinerarySchema, TripRequestSchema, tripRequestSchemaFor } from "../src/schemas";
import type { Itinerary } from "../src/types";
import { rawData } from "./helpers";

// The API validates requests with these schemas and the web app parses every response with them
// (failure vector F8). A schema that is too loose lets garbage reach the planner or the screen;
// one that is too strict rejects real plans.

const validRequest = {
  startDate: "2026-10-06",
  pace: "balanced",
  interests: ["food", "art"],
  maxPriceLevel: 3,
  anchors: "auto",
  mustInclude: ["place_001"],
  exclude: ["place_025"],
  notes: "  We love long lunches.  ",
};

const validItinerary: Itinerary = {
  request: {
    startDate: "2026-10-06",
    pace: "balanced",
    interests: [],
    maxPriceLevel: null,
    anchors: "auto",
    mustInclude: [],
    exclude: [],
  },
  days: ["2026-10-06", "2026-10-07", "2026-10-08"].map((date) => ({
    date,
    anchorId: "rome",
    transferMin: 0,
    stops: [
      {
        placeId: "place_001",
        start: 570,
        end: 690,
        travelFromPrevMin: 0,
        role: "visit" as const,
        reason: "Rome's best-known site.",
        reasonSource: "rule" as const,
      },
    ],
  })),
  source: "deterministic",
  warnings: [
    {
      code: "HOURS_UNKNOWN",
      severity: "warning",
      day: 1,
      placeId: "place_021",
      detail: "Hours not confirmed",
    },
  ],
  meta: {
    attempts: 0,
    latencyMs: 12,
    fallbackReason: "no_key",
    generatedAt: "2026-09-23T12:00:00.000Z",
  },
};

describe("TripRequestSchema", () => {
  it("accepts a full valid request and trims the notes", () => {
    const parsed = TripRequestSchema.parse(validRequest);
    expect(parsed.notes).toBe("We love long lunches.");
  });

  it("fills defaults for a minimal request so the planner never sees undefined lists", () => {
    expect(TripRequestSchema.parse({ startDate: "2026-10-06", pace: "relaxed" })).toEqual({
      startDate: "2026-10-06",
      pace: "relaxed",
      interests: [],
      maxPriceLevel: null,
      anchors: "auto",
      mustInclude: [],
      exclude: [],
    });
  });

  it.each([
    ["an unknown field", { ...validRequest, admin: true }],
    ["an impossible date", { ...validRequest, startDate: "2027-02-29" }],
    ["a date with a time", { ...validRequest, startDate: "2026-10-06T00:00:00Z" }],
    ["a year outside 2000 to 2100", { ...validRequest, startDate: "1999-12-31" }],
    ["an unknown pace", { ...validRequest, pace: "leisurely" }],
    [
      "nine interests",
      { ...validRequest, interests: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
    ],
    ["price level 5", { ...validRequest, maxPriceLevel: 5 }],
    ["three anchors", { ...validRequest, anchors: ["rome", "florence", "milan"] }],
    ["an empty anchor list", { ...validRequest, anchors: [] }],
    [
      "eleven must-include ids",
      { ...validRequest, mustInclude: Array.from({ length: 11 }, (_, i) => `place_${i}`) },
    ],
    ["an id with markup", { ...validRequest, exclude: ["<img onerror=alert(1)>"] }],
    ["a place both required and excluded", { ...validRequest, exclude: ["place_001"] }],
    ["a repeated interest", { ...validRequest, interests: ["food", "food"] }],
    ["the same base twice", { ...validRequest, anchors: ["rome", "rome"] }],
    ["notes over 500 characters", { ...validRequest, notes: "x".repeat(501) }],
    ["a string instead of an object", "plan me a trip"],
  ])("rejects %s", (_label, body) => {
    expect(TripRequestSchema.safeParse(body).success).toBe(false);
  });

  it("allows 500 characters of notes after trimming surrounding space", () => {
    expect(
      TripRequestSchema.safeParse({ ...validRequest, notes: ` ${"x".repeat(500)} ` }).success,
    ).toBe(true);
  });
});

describe("tripRequestSchemaFor", () => {
  const dataset = buildDataset(rawData());
  const schema = tripRequestSchemaFor({
    tags: new Set(["food", "art"]),
    placeIds: new Set(dataset.byId.keys()),
    anchorIds: new Set(["rome", "florence"]),
  });

  it("accepts known interests, places, and bases", () => {
    expect(schema.safeParse({ ...validRequest, anchors: ["rome"] }).success).toBe(true);
  });

  it.each([
    ["an unknown interest", { interests: ["skiing"] }, ["interests", 0]],
    ["an invented place id", { mustInclude: ["place_999"] }, ["mustInclude", 0]],
    ["an unknown base", { anchors: ["naples"] }, ["anchors", 0]],
  ])("rejects %s at the right path without echoing the input", (_label, change, path) => {
    const result = schema.safeParse({ ...validRequest, ...change });
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(path);
    expect(JSON.stringify(result.error?.issues)).not.toContain("skiing");
  });
});

describe("ItinerarySchema", () => {
  it("accepts a well-formed plan", () => {
    expect(ItinerarySchema.safeParse(validItinerary).success).toBe(true);
  });

  it.each<[string, (plan: Itinerary) => unknown]>([
    ["two days instead of three", (plan) => ({ ...plan, days: plan.days.slice(0, 2) })],
    [
      "an error-severity violation",
      (plan) => ({ ...plan, warnings: [{ ...plan.warnings[0], severity: "error" }] }),
    ],
    [
      "a stop that ends before it starts",
      (plan) => ({
        ...plan,
        days: plan.days.map((day) => ({ ...day, stops: [{ ...day.stops[0], end: 500 }] })),
      }),
    ],
    [
      "a fractional start minute",
      (plan) => ({
        ...plan,
        days: plan.days.map((day) => ({ ...day, stops: [{ ...day.stops[0], start: 570.5 }] })),
      }),
    ],
    [
      "a reason over 140 characters",
      (plan) => ({
        ...plan,
        days: plan.days.map((day) => ({
          ...day,
          stops: [{ ...day.stops[0], reason: "x".repeat(141) }],
        })),
      }),
    ],
    ["an unknown source", (plan) => ({ ...plan, source: "magic" })],
    [
      "an unknown violation code",
      (plan) => ({ ...plan, warnings: [{ ...plan.warnings[0], code: "OUTSIDE_ANCHOR_RADIUS" }] }),
    ],
    ["a summary over 300 characters", (plan) => ({ ...plan, summary: "x".repeat(301) })],
    ["a missing generatedAt", (plan) => ({ ...plan, meta: { attempts: 0, latencyMs: 1 } })],
    ["an extra top-level field", (plan) => ({ ...plan, debug: "prompt text" })],
  ])("rejects %s so the web app never renders it", (_label, corrupt) => {
    expect(ItinerarySchema.safeParse(corrupt(structuredClone(validItinerary))).success).toBe(false);
  });
});

describe("DataSummarySchema", () => {
  it("accepts the summary built from the real data", () => {
    expect(DataSummarySchema.safeParse(buildDataset(rawData()).summary).success).toBe(true);
  });
});
