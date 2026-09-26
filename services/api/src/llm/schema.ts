import { PACE, REASON_MAX_CHARS, SUMMARY_MAX_CHARS, TRIP_DAYS } from "@italy/planner";
import { z } from "zod";
import type { LlmDayAnswer, LlmSelection } from "./client";

// The shape the model must answer in, twice: as JSON Schema for structured outputs
// (output_config.format) and as Zod for parsing every response. Structured outputs guarantee the
// structure but ignore length limits, so the limits live in the Zod schema only. A test checks
// that the two describe the same structure.

/** Most stops a day can hold: the packed pace's visits plus lunch and dinner. */
export const MAX_STOPS_PER_DAY = PACE.packed.maxVisits + 2;

// Decision: reason and summary lengths are capped loosely here and strictly by the sanitizers.
// A 150-character reason should cost that one reason (replaced by a rule reason), not the whole
// answer (a repair turn or the fallback).
const REASON_HARD_MAX = 1000;
const SUMMARY_HARD_MAX = 2000;
const ID_MAX = 64;

export const SelectionSchema = z.strictObject({
  days: z
    .array(
      z.strictObject({
        anchorId: z.string().min(1).max(ID_MAX),
        placeIds: z.array(z.string().min(1).max(ID_MAX)).min(1).max(MAX_STOPS_PER_DAY),
        reasons: z
          .array(
            z.strictObject({
              placeId: z.string().min(1).max(ID_MAX),
              reason: z.string().max(REASON_HARD_MAX),
            }),
          )
          .max(MAX_STOPS_PER_DAY),
      }),
    )
    .length(TRIP_DAYS),
  summary: z.string().max(SUMMARY_HARD_MAX),
});

// Compile-time check: the Zod output is exactly the LlmSelection type.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const selectionTypeCheck: Same<z.output<typeof SelectionSchema>, LlmSelection> = true;

/** JSON Schema sent as output_config.format.schema. Every object is closed. */
export const SELECTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["days", "summary"],
  properties: {
    days: {
      type: "array",
      description: `Exactly ${TRIP_DAYS} days, in trip order.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["anchorId", "placeIds", "reasons"],
        properties: {
          anchorId: { type: "string", description: "The base id for this day." },
          placeIds: {
            type: "array",
            description: `Stops in visiting order, meals included, 1 to ${MAX_STOPS_PER_DAY} ids.`,
            items: { type: "string" },
          },
          reasons: {
            type: "array",
            description: "One reason per stop.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["placeId", "reason"],
              properties: {
                placeId: { type: "string" },
                reason: {
                  type: "string",
                  description: `One sentence under ${REASON_MAX_CHARS} characters.`,
                },
              },
            },
          },
        },
      },
    },
    summary: {
      type: "string",
      description: `At most two short sentences, under ${SUMMARY_MAX_CHARS} characters.`,
    },
  },
} as const;

/** The one-day answer (POST /api/plan/day): the day's stops and a reason per stop. */
export const DayAnswerSchema = z.strictObject({
  placeIds: z.array(z.string().min(1).max(ID_MAX)).min(1).max(MAX_STOPS_PER_DAY),
  reasons: z
    .array(
      z.strictObject({
        placeId: z.string().min(1).max(ID_MAX),
        reason: z.string().max(REASON_HARD_MAX),
      }),
    )
    .max(MAX_STOPS_PER_DAY),
});

export const dayAnswerTypeCheck: Same<z.output<typeof DayAnswerSchema>, LlmDayAnswer> = true;

/** JSON Schema for the one-day answer. No base (code keeps it) and no summary (the trip has one). */
export const DAY_ANSWER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["placeIds", "reasons"],
  properties: {
    placeIds: SELECTION_JSON_SCHEMA.properties.days.items.properties.placeIds,
    reasons: SELECTION_JSON_SCHEMA.properties.days.items.properties.reasons,
  },
} as const;

export type ParsedSelection =
  | { ok: true; selection: LlmSelection }
  | { ok: false; issues: string[] };

/** Parses the model's text: JSON first, then the Zod schema. Never throws. */
export function parseSelectionText(text: string): ParsedSelection {
  const parsed = parseWith(SelectionSchema, text);
  return parsed.ok ? { ok: true, selection: parsed.value } : parsed;
}

export type ParsedDayAnswer = { ok: true; answer: LlmDayAnswer } | { ok: false; issues: string[] };

/** Parses a one-day answer like parseSelectionText. Never throws. */
export function parseDayAnswerText(text: string): ParsedDayAnswer {
  const parsed = parseWith(DayAnswerSchema, text);
  return parsed.ok ? { ok: true, answer: parsed.value } : parsed;
}

function parseWith<T>(
  schema: z.ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; issues: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, issues: ["The answer is not valid JSON."] };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.slice(0, 10).map((issue) => {
    const path = issue.path.map(String).join(".") || "(root)";
    return `${path}: ${issue.message}`.slice(0, 200);
  });
  return { ok: false, issues };
}
