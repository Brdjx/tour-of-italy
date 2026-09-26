import {
  type FallbackReason,
  type Itinerary,
  NoFeasiblePlanError,
  type PlannerContext,
  planDeterministic,
  type TripRequest,
} from "@italy/planner";
import type { LlmOffReason } from "../config";
import type { LlmClient, LlmResult, RepairViolation } from "../llm/client";
import {
  buildRepairMessage,
  NO_REPAIR_NOTES,
  PROMPT_VERSION,
  type RepairNotes,
  SYSTEM_PROMPT,
} from "../llm/prompt";
import { buildUserMessage } from "../llm/promptUser";
import { callWithin } from "./callWithin";
import { buildShortlist, type Shortlist } from "./candidates";
import { materializeSelection } from "./materialize";
import { DEFAULT_TIMING, giveUpReason, type PlanTiming, runTurn } from "./modelTurn";
import {
  finishPlan,
  newTrace,
  PlanGuardError,
  type PlanOutcome,
  type PlanTrace,
  planWithoutAi,
  recordFailure,
  recordResult,
} from "./outcome";
import { repairNotes } from "./repairNotes";
import { tidySelection } from "./tidy";

export { DEFAULT_TIMING, type PlanTiming } from "./modelTurn";

// The plan pipeline (POST /api/plan): shortlist, ask the model, tidy its answer (tidy.ts), time
// and validate it, one repair turn with the exact violations and what tidying removed
// (repairNotes.ts) if time allows, and the rules-only planner for every other outcome. A brief
// failure (dropped connection, 5xx) gets one retry when time allows. Whatever happens, the
// result has zero validator errors (see outcome.ts).

export interface PlanDeps {
  llm: LlmClient | null; // null when the AI layer is off
  offReason?: LlmOffReason; // why llm is null
  ctx: PlannerContext;
  now: () => number;
  config: { timeoutMs: number; deadlineMs: number; maxAttempts: number };
  timing?: PlanTiming;
}

export interface PlanRunOptions {
  mode?: "auto" | "deterministic"; // "deterministic" skips the model (?mode=deterministic)
  startedAt?: number; // when the request arrived, so the deadline covers time spent before
}

/** The rules-only plan for this request, or null when the planner cannot make one. */
function rulesOnlyPlan(request: TripRequest, ctx: PlannerContext): Itinerary | null {
  try {
    return planDeterministic(request, ctx);
  } catch (error) {
    if (error instanceof NoFeasiblePlanError) return null;
    throw error;
  }
}

type Problem = {
  kind: "schema" | "invalid";
  text: string;
  violations: RepairViolation[];
  notes: RepairNotes; // what the tidy step removed and moved, for the repair turn
};

interface Run {
  request: TripRequest;
  deps: PlanDeps;
  llm: LlmClient;
  startedAt: number;
  trace: PlanTrace;
  shortlist: Shortlist;
  user: string;
  witness: Itinerary | undefined; // the rules-only plan, made once and reused by any fallback
}

export async function planTrip(
  request: TripRequest,
  deps: PlanDeps,
  options: PlanRunOptions = {},
): Promise<PlanOutcome> {
  const startedAt = options.startedAt ?? deps.now();
  const trace = newTrace();
  if (options.mode === "deterministic") {
    return planWithoutAi(request, deps, startedAt, trace, "requested");
  }
  if (deps.llm === null) {
    return planWithoutAi(request, deps, startedAt, trace, deps.offReason ?? "disabled");
  }
  trace.model = deps.llm.model;
  trace.promptVersion = PROMPT_VERSION;
  let witness: Itinerary | undefined;
  try {
    witness = rulesOnlyPlan(request, deps.ctx) ?? undefined;
    const bases = witness?.days.map((day) => day.anchorId) ?? [];
    const shortlist = buildShortlist(request, deps.ctx, bases);
    const user = buildUserMessage(request, shortlist, deps.ctx);
    const llm = deps.llm;
    return await runModel({ request, deps, llm, startedAt, trace, shortlist, user, witness });
  } catch (error) {
    // The rules-only planner's own failures are not model problems; the route maps them.
    if (error instanceof NoFeasiblePlanError || error instanceof PlanGuardError) throw error;
    // Decision: anything unexpected on the AI path (a bug, a client that throws oddly) still ends
    // in the rules-only plan, so no model problem can ever become a 500.
    recordFailure(trace, error);
    return planWithoutAi(request, deps, startedAt, trace, "llm_error", witness);
  }
}

/** One model call (first answer or repair), bounded by `timeoutMs`. */
function askModel(run: Run, previous: Problem | null, timeoutMs: number): Promise<LlmResult> {
  return callWithin((signal) => {
    const input = {
      request: run.request,
      system: SYSTEM_PROMPT,
      user: run.user,
      timeoutMs,
      signal,
    };
    if (previous === null) return run.llm.select(input);
    return run.llm.repair({
      ...input,
      previousText: previous.text,
      violations: previous.violations,
      repairMessage: buildRepairMessage(previous.violations, previous.notes),
    });
  }, timeoutMs);
}

async function runModel(run: Run): Promise<PlanOutcome> {
  const { request, deps, trace, startedAt } = run;
  const timing = deps.timing ?? DEFAULT_TIMING;
  const fallback = (reason: FallbackReason) =>
    planWithoutAi(request, deps, startedAt, trace, reason, run.witness);
  const state = { retried: false };
  let problem: Problem | null = null;

  for (let turn = 1; turn <= deps.config.maxAttempts; turn++) {
    // Decision: the minimums never exceed the configured per-call timeout, so a short
    // LLM_TIMEOUT_MS (E2E runs use one) still makes the call instead of silently skipping it.
    const floor: number = problem === null ? timing.minCallMs : timing.minRepairMs;
    const previous: Problem | null = problem;
    const ask = (timeoutMs: number): Promise<LlmResult> => askModel(run, previous, timeoutMs);
    const result = await runTurn(run, Math.min(floor, deps.config.timeoutMs), state, ask);
    if ("giveUp" in result) {
      if (result.giveUp !== "no_time") return fallback(result.giveUp);
      return fallback(problem === null ? "timeout" : giveUpReason(problem.kind, turn > 2, true));
    }
    recordResult(trace, result);
    // Decision: no repair after a refusal (asking again is pointless) or a cut-off answer (a
    // repair would need even more output room than the call that just ran out).
    if (result.stopReason === "refusal") return fallback("refusal");
    if (result.stopReason === "max_tokens") return fallback("max_tokens");
    if (result.selection === null) {
      trace.violationCodes.push("SCHEMA_INVALID");
      const detail = result.schemaIssues.length > 0 ? result.schemaIssues : ["Off-schema answer."];
      const violations = detail.map((text) => ({ code: "SCHEMA_INVALID", detail: text }));
      problem = { kind: "schema", text: result.rawText, violations, notes: NO_REPAIR_NOTES };
      continue;
    }
    const meta = {
      model: run.llm.model,
      promptVersion: PROMPT_VERSION,
      attempts: trace.attempts,
      latencyMs: 0,
      generatedAt: new Date(deps.now()).toISOString(),
    };
    const tidied = tidySelection(result.selection, request, run.shortlist, deps.ctx);
    for (const change of tidied.changes) trace.tidied.push({ ...change, answer: turn });
    const made = materializeSelection(tidied.selection, request, run.shortlist, deps.ctx, meta);
    if (made.errors.length === 0) {
      // Decision: a plan code had to tidy is not a first-try AI plan. Only an answer that passed
      // the check exactly as the model wrote it is "ai"; any other is "ai_repaired" (fixed after
      // a check), and the trace says what was tidied.
      const untouched = turn === 1 && tidied.changes.length === 0;
      const source = untouched ? "ai" : "ai_repaired";
      return finishPlan(made, source, request, deps, startedAt, trace, run.witness);
    }
    for (const violation of made.errors) trace.violationCodes.push(violation.code);
    const violations = made.errors.map((v) => ({
      code: v.code,
      day: v.day,
      placeId: v.placeId,
      detail: v.detail,
    }));
    const notes = repairNotes(tidied, request, run.shortlist, deps.ctx);
    problem = { kind: "invalid", text: result.rawText, violations, notes };
  }
  // Every turn ran and the last answer still had a problem (maxAttempts is at least 1).
  const repaired = deps.config.maxAttempts > 1;
  return fallback(problem === null ? "llm_error" : giveUpReason(problem.kind, repaired, false));
}
