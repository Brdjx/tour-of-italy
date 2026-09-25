import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  IdSchema,
  MAX_ANCHORS_PER_TRIP,
  TripRequestSchema,
  VIOLATION_CODES,
  VIOLATION_SEVERITY,
} from "@italy/planner";
import { z } from "zod";
import { PATHS } from "./paths";

// The eval cases (cases/*.json). Each is one trip request and what a good plan for it looks like.
// Every file is validated here before anything runs, so a typo in a case fails loudly instead of
// quietly checking nothing.

const CodeSchema = z.enum(VIOLATION_CODES);

const WarningCodeSchema = CodeSchema.refine((code) => VIOLATION_SEVERITY[code] === "warning", {
  message: "Only warning codes can be expected; errors never reach a plan",
});

/** What a good plan for the case does. Every field but the first two defaults to "no check". */
export const ExpectSchema = z.strictObject({
  maxAnchors: z.number().int().min(1).max(MAX_ANCHORS_PER_TRIP), // distinct bases in the plan
  minPreferenceMatch: z.number().min(0).max(1), // share of visits matching an interest
  // Codes that must not appear in the final plan or in any model answer the pipeline rejected.
  forbidViolationCodes: z.array(CodeSchema).default([]),
  // Forbidden warnings a lunch or dinner stop may carry (an extension, for the meal places one
  // price level over a low budget that both planners may seat, marked OVER_BUDGET).
  allowOnMealStops: z.array(WarningCodeSchema).default([]),
  expectWarningCodes: z.array(WarningCodeSchema).default([]), // warnings the plan must carry
  forbidPlaceIds: z.array(IdSchema).default([]), // places that must not be in the plan
  // At least one of these places must be in the plan (an extension of the plan's case format).
  expectAnyPlaceIds: z.array(IdSchema).default([]),
  summaryMentions: z.array(z.string().min(1)).default([]), // words the AI summary must contain
  // Text the summary and reasons must never contain (an extension, for the injection case).
  summaryExcludes: z.array(z.string().min(1)).default([]),
});

export const EvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Expected a kebab-case id"),
  description: z.string().min(1).max(300),
  request: TripRequestSchema,
  expect: ExpectSchema,
});

export type EvalCase = z.output<typeof EvalCaseSchema>;
export type Expect = EvalCase["expect"];

/** Reads and validates one case file; the file name must be the case id. */
export function readCase(path: string): EvalCase {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${(error as Error).message})`);
  }
  const parsed = EvalCaseSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`${path}: invalid case\n  ${issues.join("\n  ")}`);
  }
  if (basename(path) !== `${parsed.data.id}.json`) {
    throw new Error(`${path}: the file name must be ${parsed.data.id}.json`);
  }
  return parsed.data;
}

/** Every case in the folder, sorted by id. */
export function loadCases(dir: string = PATHS.cases): EvalCase[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  return files.map((name) => readCase(join(dir, name)));
}

/**
 * The cases whose id contains any of the filters (comma-separated in `--case`). No filter means
 * every case. A filter that matches nothing is an error, so a typo never runs zero cases quietly.
 */
export function selectCases(cases: readonly EvalCase[], filters: readonly string[]): EvalCase[] {
  if (filters.length === 0) return [...cases];
  const unmatched = filters.filter((f) => !cases.some((c) => c.id.includes(f)));
  if (unmatched.length > 0) {
    throw new Error(`No case matches: ${unmatched.join(", ")}`);
  }
  return cases.filter((c) => filters.some((f) => c.id.includes(f)));
}
