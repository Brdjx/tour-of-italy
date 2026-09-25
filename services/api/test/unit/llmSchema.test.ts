import { TRIP_DAYS } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { settingsFor } from "../../src/llm/models";
import {
  MAX_STOPS_PER_DAY,
  parseSelectionText,
  SELECTION_JSON_SCHEMA,
  SelectionSchema,
} from "../../src/llm/schema";

// The model's answer shape. If the JSON schema sent to the API and the Zod schema used to parse
// the answer drift, valid answers are rejected or invalid ones accepted; these tests pin both.

const UNSUPPORTED = [
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
];

/** A JSON schema with length limits and descriptions removed, to compare structure only. */
function structure(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(structure);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema" || key === "description" || UNSUPPORTED.includes(key)) continue;
    out[key] = structure(value);
  }
  return out;
}

function everyObject(node: unknown, visit: (object: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) everyObject(item, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "object") visit(record);
  for (const value of Object.values(record)) everyObject(value, visit);
}

function validAnswer(days = TRIP_DAYS) {
  return {
    days: Array.from({ length: days }, () => ({
      anchorId: "rome",
      placeIds: ["place_001"],
      reasons: [{ placeId: "place_001", reason: "Iconic." }],
    })),
    summary: "A short trip.",
  };
}

describe("selection schema", () => {
  it("sends the same structure the Zod parser enforces", () => {
    expect(structure(SELECTION_JSON_SCHEMA)).toEqual(structure(z.toJSONSchema(SelectionSchema)));
  });

  it("closes every object and requires every property, as structured outputs demand", () => {
    everyObject(SELECTION_JSON_SCHEMA, (object) => {
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(Object.keys(object.properties as object));
    });
  });

  it("sends no constraint keywords structured outputs would reject or ignore", () => {
    const text = JSON.stringify(SELECTION_JSON_SCHEMA);
    for (const keyword of UNSUPPORTED) expect(text).not.toContain(`"${keyword}"`);
  });

  it("accepts a well-formed answer", () => {
    expect(parseSelectionText(JSON.stringify(validAnswer()))).toMatchObject({ ok: true });
  });

  it("enforces the day count in code, since the API does not", () => {
    const result = parseSelectionText(JSON.stringify(validAnswer(TRIP_DAYS + 1)));

    expect(result.ok).toBe(false);
  });

  it("rejects a day with too many stops or none", () => {
    const answer = validAnswer();
    const first = answer.days[0];
    if (!first) throw new Error("no day");
    first.placeIds = Array.from({ length: MAX_STOPS_PER_DAY + 1 }, (_, i) => `place_${i}`);
    expect(parseSelectionText(JSON.stringify(answer)).ok).toBe(false);
    first.placeIds = [];
    expect(parseSelectionText(JSON.stringify(answer)).ok).toBe(false);
  });

  it("rejects extra fields, such as a model trying to send times or prices", () => {
    const answer = { ...validAnswer(), times: ["09:00"] };

    expect(parseSelectionText(JSON.stringify(answer)).ok).toBe(false);
  });

  it("reports non-JSON text as a schema problem instead of throwing", () => {
    const result = parseSelectionText("Sure! Here is your itinerary:");

    expect(result).toEqual({ ok: false, issues: ["The answer is not valid JSON."] });
  });

  it("lists at most ten short issues for the repair turn", () => {
    const result = parseSelectionText(JSON.stringify({ days: "x".repeat(5000), summary: 1, a: 1 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeLessThanOrEqual(10);
      for (const issue of result.issues) expect(issue.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("per-model settings", () => {
  it("sends effort and no temperature to Sonnet 5, which rejects temperature", () => {
    const settings = settingsFor("claude-sonnet-5", "low");

    expect(settings).toMatchObject({ family: "sonnet-5", effort: "low", thinkingDisabled: true });
    expect(settings.temperature).toBeUndefined();
  });

  it("sends temperature 0.2 and no effort to Haiku 4.5, which rejects effort", () => {
    for (const id of ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
      const settings = settingsFor(id, "high");
      expect(settings).toMatchObject({ family: "haiku-4-5", temperature: 0.2 });
      expect(settings.effort).toBeUndefined();
      expect(settings.thinkingDisabled).toBeUndefined();
    }
  });

  it("sends neither knob to an unknown model, since every model accepts that", () => {
    const settings = settingsFor("claude-future-9", "high");

    expect(settings.family).toBe("unknown");
    expect(settings.effort).toBeUndefined();
    expect(settings.temperature).toBeUndefined();
  });

  it("leaves room for thinking plus the JSON answer", () => {
    expect(settingsFor("claude-sonnet-5", "low").maxTokens).toBeGreaterThanOrEqual(4000);
  });
});
