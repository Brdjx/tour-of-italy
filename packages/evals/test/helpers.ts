import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shippedData } from "@italy/api/data";
import { type Itinerary, planDeterministic, TripRequestSchema } from "@italy/planner";
import { afterEach } from "vitest";
import { type EvalCase, loadCases } from "../src/cases";
import type { PlanMeasure } from "../src/metrics";

// Shared test fixtures: the shipped data, the committed cases, temporary folders that are always
// removed, and hand-built plans and measures.

export const { ctx, known } = shippedData();
export const CASES: EvalCase[] = loadCases();

export function caseById(id: string): EvalCase {
  const found = CASES.find((c) => c.id === id);
  if (!found) throw new Error(`No case ${id}`);
  return found;
}

const made: string[] = [];

/** A fresh temporary folder, deleted after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "italy-evals-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every file under `dir` with its text, for scanning what reached disk. */
export function filesUnder(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

/** A real, valid rules-only plan for a request. */
export function plan(overrides: Record<string, unknown> = {}): Itinerary {
  const request = TripRequestSchema.parse({
    startDate: "2026-10-13",
    pace: "balanced",
    ...overrides,
  });
  return planDeterministic(request, ctx);
}

/** A measured plan with neutral values; tests override what they are about. */
export function measure(overrides: Partial<PlanMeasure> = {}): PlanMeasure {
  return {
    caseId: "case-a",
    run: 1,
    source: "ai",
    fallbackReason: null,
    answered: true,
    firstPassValid: true,
    repairTried: false,
    calls: 1,
    shape: {
      finalValid: true,
      preferenceMatch: 0.5,
      visitsPerDay: 4,
      paceCap: 5,
      travelMinPerDay: 60,
      transferMinPerTrip: 0,
      anchors: 1,
      days: 3,
      daysMissingMeal: 0,
      daysNoneOpen: 0,
    },
    mustInclude: { placed: 0, placeable: 0 },
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    stale: false,
    checks: [],
    mealsAdded: 0,
    daysMissingMealBefore: 0,
    ...overrides,
  };
}
