import { mean, type PlanMeasure, percentile, rate } from "./metrics";

// Per-model totals from measured plans (the numbers in the comparison table).

export interface CaseTotals {
  caseId: string;
  runs: number;
  passedRuns: number; // runs where every expectation that applies held
  failedChecks: string[]; // names of checks that failed in any run, sorted
  skippedChecks: string[]; // names of checks that could not apply in any run, sorted
}

export interface Summary {
  plans: number;
  finalValidRate: number | null; // must be 1: the only blocking number
  answeredPlans: number; // plans where the model returned at least one answer
  firstPassValidRate: number | null; // of answered plans
  validAfterTidyRate: number | null; // of answered plans, the first answer (tidied or not) was kept
  repairRate: number | null; // of answered plans, share that needed a repair turn
  repairSuccessRate: number | null; // of repairs, share that produced the plan
  fallbackRate: number | null; // share of plans the rules-only planner produced instead
  fallbackReasons: Record<string, number>; // count per reason, sorted by reason
  preferenceMatch: number | null; // mean over plans
  mustIncludeRate: number | null; // placed over placeable, all plans together
  visitsPerDay: number | null;
  paceFill: number | null; // visits per day over the pace's cap, mean over plans
  travelMinPerDay: number | null;
  transferMinPerTrip: number | null;
  mealGapRate: number | null; // days missing a lunch or a dinner over all days, all plans together
  days: number; // every day of every plan measured
  mealGapDays: number; // days missing a lunch or a dinner
  noneOpenDays: number; // of those, days no place could have fed (the rest: not planned)
  mealGapBeforeDays: number | null; // days missing a meal before code added any; null for the baseline
  noneOpenBeforeDays: number | null; // of those, days no place could have fed; null for the baseline
  mealsAdded: number; // lunches and dinners code added to the model's answers
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyMaxMs: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  avgCostUsd: number | null;
  stalePlans: number;
  cases: CaseTotals[];
  casesPassed: number;
  casesPassedWithSkips: number; // of casesPassed, those where a check was skipped, not passed
}

function present<T>(values: readonly (T | null)[]): T[] {
  return values.filter((value): value is T => value !== null);
}

function caseTotals(measures: readonly PlanMeasure[]): CaseTotals[] {
  const byCase = new Map<string, PlanMeasure[]>();
  for (const m of measures) byCase.set(m.caseId, [...(byCase.get(m.caseId) ?? []), m]);
  return [...byCase.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([caseId, runs]) => {
      const failed = new Set<string>();
      const skipped = new Set<string>();
      let passedRuns = 0;
      for (const m of runs) {
        const fails: string[] = m.checks.filter((c) => c.status === "fail").map((c) => c.name);
        if (!m.shape?.finalValid) fails.push("finalValid");
        for (const name of fails) failed.add(name);
        for (const c of m.checks) if (c.status === "skip") skipped.add(c.name);
        if (fails.length === 0) passedRuns++;
      }
      return {
        caseId,
        runs: runs.length,
        passedRuns,
        failedChecks: [...failed].sort(),
        skippedChecks: [...skipped].sort(),
      };
    });
}

function fallbackReasons(measures: readonly PlanMeasure[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of measures) {
    if (m.fallbackReason !== null) counts[m.fallbackReason] = (counts[m.fallbackReason] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function summarize(measures: readonly PlanMeasure[]): Summary {
  const answered = measures.filter((m) => m.answered);
  const repairs = answered.filter((m) => m.repairTried);
  const shapes = present(measures.map((m) => m.shape));
  const must = present(measures.map((m) => m.mustInclude));
  const placed = must.reduce((sum, c) => sum + c.placed, 0);
  const placeable = must.reduce((sum, c) => sum + c.placeable, 0);
  const latencies = present(measures.map((m) => m.latencyMs));
  const cases = caseTotals(measures);
  const firstAnswerKept = answered.filter(
    (m) =>
      !m.repairTried &&
      m.fallbackReason === null &&
      (m.source === "ai" || m.source === "ai_repaired"),
  );
  const passedCases = cases.filter((c) => c.passedRuns === c.runs);
  const days = shapes.reduce((sum, s) => sum + s.days, 0);
  const mealGapDays = shapes.reduce((sum, s) => sum + s.daysMissingMeal, 0);
  const before = present(measures.map((m) => m.daysMissingMealBefore));
  const noneOpenBefore = present(measures.map((m) => m.daysNoneOpenBefore));
  return {
    plans: measures.length,
    finalValidRate: rate(measures.filter((m) => m.shape?.finalValid).length, measures.length),
    answeredPlans: answered.length,
    firstPassValidRate: rate(answered.filter((m) => m.firstPassValid).length, answered.length),
    validAfterTidyRate: rate(firstAnswerKept.length, answered.length),
    repairRate: rate(repairs.length, answered.length),
    repairSuccessRate: rate(
      repairs.filter((m) => m.source === "ai_repaired").length,
      repairs.length,
    ),
    fallbackRate: rate(measures.filter((m) => m.fallbackReason !== null).length, measures.length),
    fallbackReasons: fallbackReasons(measures),
    preferenceMatch: mean(present(shapes.map((s) => s.preferenceMatch))),
    mustIncludeRate: rate(placed, placeable),
    visitsPerDay: mean(shapes.map((s) => s.visitsPerDay)),
    paceFill: mean(shapes.map((s) => s.visitsPerDay / s.paceCap)),
    travelMinPerDay: mean(shapes.map((s) => s.travelMinPerDay)),
    transferMinPerTrip: mean(shapes.map((s) => s.transferMinPerTrip)),
    mealGapRate: rate(mealGapDays, days),
    days,
    mealGapDays,
    noneOpenDays: shapes.reduce((sum, s) => sum + s.daysNoneOpen, 0),
    mealGapBeforeDays: before.length === 0 ? null : before.reduce((sum, n) => sum + n, 0),
    noneOpenBeforeDays:
      noneOpenBefore.length === 0 ? null : noneOpenBefore.reduce((sum, n) => sum + n, 0),
    mealsAdded: measures.reduce((sum, m) => sum + m.mealsAdded, 0),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    latencyMaxMs: percentile(latencies, 100),
    avgInputTokens: mean(present(measures.map((m) => m.inputTokens))),
    avgOutputTokens: mean(present(measures.map((m) => m.outputTokens))),
    avgCostUsd: mean(present(measures.map((m) => m.costUsd))),
    stalePlans: measures.filter((m) => m.stale).length,
    cases,
    casesPassed: passedCases.length,
    // Decision: a skipped check is not a pass. The rules-only planner writes no summary, so a
    // case that only its summary could fail would otherwise count as passed for the baseline
    // while every model must earn it. The report shows how many passes rest on a skip.
    casesPassedWithSkips: passedCases.filter((c) => c.skippedChecks.length > 0).length,
  };
}
