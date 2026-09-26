import {
  type DaySelection,
  type FallbackReason,
  newTripErrors,
  type PlanSource,
  scheduleTrip,
  withDay,
} from "@italy/planner";
import { type PlanDayResponse, PlanDayResponseSchema } from "../contract";
import type { LlmClient, LlmDayResult, RepairViolation } from "../llm/client";
import {
  buildDayRepairMessage,
  buildDayUserMessage,
  DAY_PROMPT_VERSION,
  DAY_SYSTEM_PROMPT,
} from "../llm/dayPrompt";
import { NO_REPAIR_NOTES, type RepairNotes } from "../llm/prompt";
import { callWithin } from "./callWithin";
import type { Shortlist } from "./candidates";
import type { DayInput } from "./dayInput";
import { buildDayShortlist } from "./dayShortlist";
import { materializeDay, tidyDay } from "./dayTidy";
import { DEFAULT_TIMING, giveUpReason, type ProblemKind, runTurn } from "./modelTurn";
import {
  buildMeta,
  newTrace,
  PlanGuardError,
  type PlanTrace,
  recordFailure,
  recordResult,
} from "./outcome";
import type { PlanDeps, PlanRunOptions } from "./planTrip";
import { repairNotes } from "./repairNotes";

// The one-day pipeline (POST /api/plan/day), the whole-trip pipeline (planTrip.ts) for one day:
// the day's shortlist (dayShortlist.ts), the model's day answer, tidied (dayTidy.ts), timed in
// its trip and checked, one repair turn with the exact violations and what tidying removed, and
// the rules-only day (planDay, which the route has already checked) for every other outcome.
// Whatever happens, the day it returns adds no error to the trip.

/** The day answer and the trace for the log line. */
export interface DayOutcome {
  result: PlanDayResponse;
  trace: PlanTrace;
}

type Problem = {
  kind: ProblemKind;
  text: string;
  violations: RepairViolation[];
  notes: RepairNotes;
};

/** A client that can plan one day, or null. */
type DayClient = Required<Pick<LlmClient, "model" | "selectDay" | "repairDay">>;

function dayClientOf(client: LlmClient): DayClient | null {
  const { selectDay, repairDay } = client;
  if (!selectDay || !repairDay) return null;
  return {
    model: client.model,
    selectDay: selectDay.bind(client),
    repairDay: repairDay.bind(client),
  };
}

interface Run {
  input: DayInput;
  deps: PlanDeps;
  llm: DayClient;
  startedAt: number;
  trace: PlanTrace;
  shortlist: Shortlist;
  user: string;
  witness: DaySelection;
}

/**
 * One day planned again. `witness` is the rules-only day at this base (checkDayBase), already
 * known to add no error to the trip; it is the answer whenever the AI path does not give one.
 */
export async function replanDay(
  input: DayInput,
  witness: DaySelection,
  deps: PlanDeps,
  options: PlanRunOptions = {},
): Promise<DayOutcome> {
  const startedAt = options.startedAt ?? deps.now();
  const trace = newTrace();
  const fallback = (reason: FallbackReason) =>
    rulesDay(input, witness, deps, startedAt, trace, reason);
  if (options.mode === "deterministic") return fallback("requested");
  if (deps.llm === null) return fallback(deps.offReason ?? "disabled");
  // Decision: a client that cannot plan a day (a whole-trip client from the eval harness) is the
  // AI layer switched off for this route, not a model failure.
  const llm = dayClientOf(deps.llm);
  if (llm === null) return fallback("disabled");
  trace.model = llm.model;
  trace.promptVersion = DAY_PROMPT_VERSION;
  try {
    const shortlist = buildDayShortlist(input, deps.ctx);
    const user = buildDayUserMessage(input, shortlist, deps.ctx);
    return await runModel({ input, deps, llm, startedAt, trace, shortlist, user, witness });
  } catch (error) {
    if (error instanceof PlanGuardError) throw error;
    // Decision: anything unexpected on the AI path still ends in the rules-only day, as for a
    // whole trip, so no model problem can become a 500.
    recordFailure(trace, error);
    return fallback("llm_error");
  }
}

/** One model call (first answer or repair), bounded by `timeoutMs`. */
function askModel(run: Run, previous: Problem | null, timeoutMs: number): Promise<LlmDayResult> {
  return callWithin((signal) => {
    const system = DAY_SYSTEM_PROMPT;
    const input = { request: run.input.request, system, user: run.user, timeoutMs, signal };
    if (previous === null) return run.llm.selectDay(input);
    return run.llm.repairDay({
      ...input,
      previousText: previous.text,
      violations: previous.violations,
      repairMessage: buildDayRepairMessage(previous.violations, previous.notes),
    });
  }, timeoutMs);
}

async function runModel(run: Run): Promise<DayOutcome> {
  const { input, deps, trace, startedAt } = run;
  const timing = deps.timing ?? DEFAULT_TIMING;
  const fallback = (reason: FallbackReason) =>
    rulesDay(input, run.witness, deps, startedAt, trace, reason);
  const state = { retried: false };
  let problem: Problem | null = null;
  for (let turn = 1; turn <= deps.config.maxAttempts; turn++) {
    const floor: number = problem === null ? timing.minCallMs : timing.minRepairMs;
    const previous: Problem | null = problem;
    const ask = (timeoutMs: number): Promise<LlmDayResult> => askModel(run, previous, timeoutMs);
    const result = await runTurn(run, Math.min(floor, deps.config.timeoutMs), state, ask);
    if ("giveUp" in result) {
      if (result.giveUp !== "no_time") return fallback(result.giveUp);
      return fallback(problem === null ? "timeout" : giveUpReason(problem.kind, turn > 2, true));
    }
    recordResult(trace, result);
    if (result.stopReason === "refusal") return fallback("refusal");
    if (result.stopReason === "max_tokens") return fallback("max_tokens");
    if (result.answer === null) {
      trace.violationCodes.push("SCHEMA_INVALID");
      const detail = result.schemaIssues.length > 0 ? result.schemaIssues : ["Off-schema answer."];
      const violations = detail.map((text) => ({ code: "SCHEMA_INVALID", detail: text }));
      problem = { kind: "schema", text: result.rawText, violations, notes: NO_REPAIR_NOTES };
      continue;
    }
    const tidied = tidyDay(result.answer, input, run.shortlist, deps.ctx);
    for (const change of tidied.changes) trace.tidied.push({ ...change, answer: turn });
    const made = materializeDay(tidied, input, run.shortlist, deps.ctx);
    if (made.errors.length === 0) {
      // As for a whole trip: only an answer that passed exactly as the model wrote it is "ai".
      const source = turn === 1 && tidied.changes.length === 0 ? "ai" : "ai_repaired";
      trace.reasonsKept = made.reasonStats.kept;
      trace.reasonRejections = made.reasonStats.rejections;
      const result = answer(input, made.dayPlan, source, deps, startedAt, trace);
      if (PlanDayResponseSchema.safeParse(result).success) return { result, trace };
      // Decision: the day had no error before its reasons were applied, so this is a bug; the
      // traveler still gets a valid day and the log line says what happened.
      trace.guardFailed = true;
      return fallback("llm_error");
    }
    for (const violation of made.errors) trace.violationCodes.push(violation.code);
    const violations = made.errors.map((v) => ({
      code: v.code,
      day: v.day,
      placeId: v.placeId,
      detail: v.detail,
    }));
    const notes = repairNotes(tidied.trip, input.request, run.shortlist, deps.ctx);
    problem = { kind: "invalid", text: result.rawText, violations, notes };
  }
  const repaired = deps.config.maxAttempts > 1;
  return fallback(problem === null ? "llm_error" : giveUpReason(problem.kind, repaired, false));
}

/** The response for a day, with the trace's meta. */
function answer(
  input: DayInput,
  dayPlan: PlanDayResponse["dayPlan"],
  source: PlanSource,
  deps: Pick<PlanDeps, "now">,
  startedAt: number,
  trace: PlanTrace,
): PlanDayResponse {
  trace.source = source;
  const generatedAt = new Date(deps.now()).toISOString();
  const meta = buildMeta(trace, Math.max(0, deps.now() - startedAt), generatedAt);
  return { day: input.day, dayPlan, source, meta };
}

/**
 * The rules-only day (the witness), timed in its trip with rule reasons and labelled with why it
 * was used. Throws PlanGuardError when it adds an error to the trip or fails the response schema,
 * which the route's check (checkDayBase) makes impossible.
 */
function rulesDay(
  input: DayInput,
  witness: DaySelection,
  deps: PlanDeps,
  startedAt: number,
  trace: PlanTrace,
  reason: FallbackReason,
): DayOutcome {
  trace.fallbackReason = reason;
  const days = withDay(input.days, input.day, witness);
  const dayPlan = scheduleTrip(input.request, days, deps.ctx).days[input.day];
  const errors = newTripErrors(input.request, input.days, input.day, witness, deps.ctx);
  if (dayPlan === undefined || errors.length > 0) {
    throw new PlanGuardError("The rules-only day failed validation");
  }
  const result = answer(input, dayPlan, "deterministic", deps, startedAt, trace);
  if (!PlanDayResponseSchema.safeParse(result).success) {
    throw new PlanGuardError("The rules-only day failed the response schema");
  }
  return { result, trace };
}
