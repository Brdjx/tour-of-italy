import {
  type FallbackReason,
  type Itinerary,
  type ItineraryMeta,
  ItinerarySchema,
  MAX_ANCHORS_PER_TRIP,
  type PlannerContext,
  type PlanSource,
  planDeterministic,
  type TripRequest,
  validationErrors,
} from "@italy/planner";
import type { LlmResult, LlmUsage } from "../llm/client";
import { describeLlmFailure, errorKindOf } from "../llm/errors";
import type { Materialized } from "./materialize";
import type { ReasonRejection } from "./reasons";
import type { TidyChange } from "./tidy";

// How a plan leaves the pipeline: the trace for the log line, the meta block, and the final
// guard. Every itinerary passes the guard (zero validator errors, and the response schema) or it
// is not returned: an AI plan that fails it is replaced by the rules-only plan, and a rules-only
// plan that fails it becomes a PlanGuardError (503), never an invalid plan.

export interface PlanTrace {
  source: PlanSource;
  fallbackReason?: FallbackReason;
  attempts: number; // model calls made, retries included
  model?: string;
  promptVersion?: string;
  violationCodes: string[]; // error codes from rejected answers, in order
  tidied: TracedTidy[]; // what code changed in each answer before the check (tidy.ts), in order
  llmErrors: string[]; // LlmError kinds of failed calls
  llmFailures: Record<string, unknown>[]; // per failed call: kind, status, API type, id, message
  stopReasons: string[]; // stop_reason of each answer
  usage: LlmUsage; // summed over all calls
  llmLatencyMs: number; // summed model call time
  reasonsKept: number; // AI reasons shown
  reasonRejections: ReasonRejection[]; // why other AI reasons were replaced
  guardFailed: boolean; // an AI plan failed the final guard (a bug; see the log)
}

/** One change the tidy step made, and which answer it was made to (1 is the first answer). */
export type TracedTidy = TidyChange & { answer: number };

export interface PlanOutcome {
  itinerary: Itinerary;
  trace: PlanTrace;
}

export function newTrace(): PlanTrace {
  return {
    source: "deterministic",
    attempts: 0,
    violationCodes: [],
    tidied: [],
    llmErrors: [],
    llmFailures: [],
    stopReasons: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    llmLatencyMs: 0,
    reasonsKept: 0,
    reasonRejections: [],
    guardFailed: false,
  };
}

/** Adds one model answer's usage, latency, and stop reason to the trace. */
export function recordResult(
  trace: PlanTrace,
  result: Pick<LlmResult, "usage" | "latencyMs" | "stopReason">,
): void {
  trace.usage.inputTokens += result.usage.inputTokens;
  trace.usage.outputTokens += result.usage.outputTokens;
  trace.llmLatencyMs += result.latencyMs;
  if (result.stopReason !== null) trace.stopReasons.push(result.stopReason);
}

/** Adds one failed model call (its kind and the API's details) to the trace. */
export function recordFailure(trace: PlanTrace, error: unknown): void {
  trace.llmErrors.push(errorKindOf(error));
  trace.llmFailures.push(describeLlmFailure(error));
}

/** Thrown when even the rules-only plan fails the guard. The route answers 503. */
export class PlanGuardError extends Error {
  override name = "PlanGuardError";
}

/**
 * Zero validator errors and a valid response shape, for a whole trip: at most
 * MAX_ANCHORS_PER_TRIP bases, as the whole-trip planners make them (materialize.ts).
 */
export function passesGuard(itinerary: Itinerary, ctx: PlannerContext): boolean {
  const errors = validationErrors(itinerary, ctx, { maxBases: MAX_ANCHORS_PER_TRIP });
  return errors.length === 0 && ItinerarySchema.safeParse(itinerary).success;
}

interface GuardDeps {
  ctx: PlannerContext;
  now: () => number;
}

/** Meta with keys in a fixed order, so equal plans serialize identically. */
export function buildMeta(trace: PlanTrace, latencyMs: number, generatedAt: string): ItineraryMeta {
  return {
    ...(trace.model === undefined ? {} : { model: trace.model }),
    ...(trace.promptVersion === undefined ? {} : { promptVersion: trace.promptVersion }),
    attempts: trace.attempts,
    latencyMs,
    ...(trace.fallbackReason === undefined ? {} : { fallbackReason: trace.fallbackReason }),
    generatedAt,
  };
}

/**
 * The rules-only plan, labelled with why it was used. `precomputed` is the same plan made earlier
 * for this request (planTrip makes one to choose the bases it offers the model).
 */
// Decision: reuse that plan instead of planning again. The planner is deterministic and only
// meta depends on its options, so the copy is identical, and a fallback costs no second run.
export function planWithoutAi(
  request: TripRequest,
  deps: GuardDeps,
  startedAt: number,
  trace: PlanTrace,
  reason: FallbackReason,
  precomputed?: Itinerary,
): PlanOutcome {
  trace.source = "deterministic";
  trace.fallbackReason = reason;
  const generatedAt = new Date(deps.now()).toISOString();
  const itinerary = precomputed
    ? structuredClone(precomputed)
    : planDeterministic(request, deps.ctx, { fallbackReason: reason, generatedAt });
  const latencyMs = Math.max(0, deps.now() - startedAt);
  itinerary.meta = buildMeta(trace, latencyMs, generatedAt);
  if (!passesGuard(itinerary, deps.ctx)) {
    throw new PlanGuardError("The rules-only plan failed validation");
  }
  return { itinerary, trace };
}

/** An AI plan that passed validation, after the final guard. */
export function finishPlan(
  made: Materialized,
  source: "ai" | "ai_repaired",
  request: TripRequest,
  deps: GuardDeps,
  startedAt: number,
  trace: PlanTrace,
  precomputed?: Itinerary,
): PlanOutcome {
  trace.source = source;
  trace.reasonsKept = made.reasonStats.kept;
  trace.reasonRejections = made.reasonStats.rejections;
  const itinerary: Itinerary = { ...made.itinerary, source };
  itinerary.meta = buildMeta(
    trace,
    Math.max(0, deps.now() - startedAt),
    made.itinerary.meta.generatedAt,
  );
  if (passesGuard(itinerary, deps.ctx)) return { itinerary, trace };
  // Decision: the plan already had zero errors before reasons and the summary were applied, so a
  // failure here is a bug. The traveler still gets a valid plan; the log line says what happened.
  trace.guardFailed = true;
  return planWithoutAi(request, deps, startedAt, trace, "llm_error", precomputed);
}
