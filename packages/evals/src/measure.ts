import { parseSelectionText } from "@italy/api/llm/schema";
import type { Shortlist } from "@italy/api/plan/candidates";
import { materializeSelection } from "@italy/api/plan/materialize";
import { type PlannerContext, planDeterministic, type TripRequest } from "@italy/planner";
import type { EvalCase } from "./cases";
import { type CheckResult, checkExpectations } from "./expectations";
import {
  daysMissingMeal,
  daysNoneOpen,
  firstAnswerMustInclude,
  type PlanMeasure,
  planBeforeMeals,
  planMustInclude,
  planShape,
} from "./metrics";
import type { PlanAttempt } from "./pipeline";
import { estimateCostUsd } from "./pricing";
import type { CallRecord } from "./recording";

// Turns one pipeline run (live or replayed) or one rules-only plan into a PlanMeasure.

/** Latency, tokens, and cost for plans a real model answered; absent for everything else. */
export interface Usage {
  model: string; // for the price table
  latencyMs: number;
  calls: readonly CallRecord[]; // the calls whose tokens count
}

export interface PipelineMeasureInput {
  caseId: string;
  caseDef: EvalCase | undefined; // undefined when the case file no longer exists: no checks
  run: number;
  attempt: PlanAttempt;
  calls: readonly CallRecord[]; // the calls this pipeline run made
  shortlist: Shortlist;
  usage: Usage | null;
  stale: boolean;
}

function usageNumbers(usage: Usage | null) {
  if (usage === null)
    return { latencyMs: null, inputTokens: null, outputTokens: null, costUsd: null };
  let inputTokens = 0;
  let outputTokens = 0;
  for (const call of usage.calls) {
    inputTokens += call.response?.usage.inputTokens ?? 0;
    outputTokens += call.response?.usage.outputTokens ?? 0;
  }
  const costUsd = estimateCostUsd(usage.model, { inputTokens, outputTokens });
  return { latencyMs: usage.latencyMs, inputTokens, outputTokens, costUsd };
}

const CHECK_META = { attempts: 1, latencyMs: 0, generatedAt: "2026-01-01T00:00:00.000Z" };

/**
 * The error codes of each answer as the model wrote it, before the pipeline's tidy step
 * (services/api/src/plan/tidy.ts). The trace lists only what was still wrong after tidying.
 */
// Decision: the eval asks whether the model made the mistake, so a place the model put on its
// closed day still counts when code dropped it before the check and the plan passed.
function writtenCodes(
  calls: readonly CallRecord[],
  request: TripRequest,
  shortlist: Shortlist,
  ctx: PlannerContext,
): string[] {
  const codes: string[] = [];
  for (const call of calls) {
    const parsed = call.response ? parseSelectionText(call.response.rawText) : null;
    if (!parsed?.ok) continue;
    const { errors } = materializeSelection(parsed.selection, request, shortlist, ctx, CHECK_META);
    codes.push(...errors.map((violation) => violation.code));
  }
  return codes;
}

export function measurePipelinePlan(input: PipelineMeasureInput, ctx: PlannerContext): PlanMeasure {
  const { caseId, caseDef, run, attempt, calls, shortlist } = input;
  const base = {
    caseId,
    run,
    answered: calls.some((call) => call.response !== undefined),
    repairTried: calls.some((call) => call.turn === "repair"),
    calls: calls.length,
    mustInclude: firstAnswerMustInclude(calls, shortlist),
    stale: input.stale,
    ...usageNumbers(input.usage),
  };
  if (!attempt.ok) {
    const checks: CheckResult[] = [];
    const fallbackReason = attempt.error;
    const none = { mealsAdded: 0, daysMissingMealBefore: null, daysNoneOpenBefore: null };
    return {
      ...base,
      ...none,
      source: "error",
      fallbackReason,
      firstPassValid: false,
      shape: null,
      checks,
    };
  }
  const { itinerary, trace } = attempt.outcome;
  const shape = planShape(itinerary, ctx);
  // A rules-only plan never keeps what code added to an answer, even when the trace has it.
  const ai = itinerary.source === "ai" || itinerary.source === "ai_repaired";
  const added = ai ? trace.tidied.filter((change) => change.rule === "meal_added") : [];
  const before = planBeforeMeals(itinerary, added, ctx);
  const written = writtenCodes(calls, itinerary.request, shortlist, ctx);
  const checks =
    caseDef === undefined
      ? []
      : checkExpectations(
          caseDef.expect,
          {
            itinerary,
            rejectedCodes: [...trace.violationCodes, ...written],
            preferenceMatch: shape.preferenceMatch,
            textChecks: true,
          },
          ctx,
        );
  return {
    ...base,
    source: itinerary.source,
    fallbackReason: itinerary.meta.fallbackReason ?? null,
    firstPassValid: itinerary.source === "ai",
    shape,
    checks,
    mealsAdded: added.length,
    daysMissingMealBefore: daysMissingMeal(before, ctx),
    daysNoneOpenBefore: daysNoneOpen(before, ctx),
  };
}

/** The rules-only planner on a case: the baseline every model is compared with. */
export function measureBaseline(
  caseDef: EvalCase,
  shortlist: Shortlist,
  ctx: PlannerContext,
): PlanMeasure {
  const request: TripRequest = caseDef.request;
  const itinerary = planDeterministic(request, ctx);
  const shape = planShape(itinerary, ctx);
  const checks = checkExpectations(
    caseDef.expect,
    { itinerary, rejectedCodes: [], preferenceMatch: shape.preferenceMatch, textChecks: false },
    ctx,
  );
  return {
    caseId: caseDef.id,
    run: 1,
    source: "deterministic",
    fallbackReason: null,
    answered: false,
    firstPassValid: false,
    repairTried: false,
    calls: 0,
    shape,
    mustInclude: planMustInclude(itinerary, shortlist),
    // Decision: the baseline's latency is not reported. It is local CPU time (milliseconds) and
    // would change latest.md on every run without saying anything useful.
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: 0,
    stale: false,
    checks,
    mealsAdded: 0,
    daysMissingMealBefore: null,
    daysNoneOpenBefore: null,
  };
}
