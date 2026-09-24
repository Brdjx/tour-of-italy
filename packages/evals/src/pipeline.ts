import { createHash } from "node:crypto";
import { loadConfig } from "@italy/api/config";
import type { LlmClient } from "@italy/api/llm/client";
import type { Effort } from "@italy/api/llm/models";
import { candidateLine } from "@italy/api/llm/promptUser";
import { buildShortlist, type Shortlist } from "@italy/api/plan/candidates";
import type { PlanOutcome } from "@italy/api/plan/outcome";
import { type PlanDeps, planTrip } from "@italy/api/plan/planTrip";
import {
  compareText,
  NoFeasiblePlanError,
  type PlannerContext,
  planDeterministic,
  type TripRequest,
} from "@italy/planner";

// Runs the production plan pipeline (planTrip) for one eval request, and works out the shortlist
// the model is shown for it, the same way planTrip does, so a recording can be checked against it.

export type PlanConfig = PlanDeps["config"];

export interface PipelineSettings {
  config: PlanConfig; // per-call timeout, total deadline, attempts
  effort: Effort; // output_config.effort for models that accept it
}

const PIPELINE_ENV = ["LLM_TIMEOUT_MS", "PLAN_DEADLINE_MS", "LLM_MAX_ATTEMPTS", "LLM_EFFORT"];

/**
 * The pipeline limits, parsed by the API's own config loader. With an empty environment these are
 * the API defaults, which are also what production sets (infra/sam/template.yaml).
 */
// Decision: only the four pipeline variables are passed in. The loader would otherwise also read
// ANTHROPIC_API_KEY and NODE_ENV, which the eval handles itself.
export function pipelineSettings(env: Record<string, string | undefined> = {}): PipelineSettings {
  const picked: Record<string, string> = {};
  for (const name of PIPELINE_ENV) {
    const value = env[name];
    if (value !== undefined) picked[name] = value;
  }
  const config = loadConfig(picked);
  return {
    config: {
      timeoutMs: config.llmTimeoutMs,
      deadlineMs: config.planDeadlineMs,
      maxAttempts: config.llmMaxAttempts,
    },
    effort: config.llmEffort,
  };
}

/** The shortlist planTrip builds: the bases the rules-only plan would use are offered too. */
export function shortlistFor(request: TripRequest, ctx: PlannerContext): Shortlist {
  let bases: string[] = [];
  try {
    bases = planDeterministic(request, ctx).days.map((day) => day.anchorId);
  } catch (error) {
    if (!(error instanceof NoFeasiblePlanError)) throw error;
  }
  return buildShortlist(request, ctx, bases);
}

/**
 * A hash of what the model was offered: the trip dates, the bases, and every candidate row as the
 * prompt prints it (id, name, tags, price, meal role, and open or closed on each day).
 */
// Decision: rows are sorted before hashing, so a re-ranking that offers the same places does not
// mark recordings stale; a change in what is offered, or when it is open, does.
export function candidateHash(shortlist: Shortlist, ctx: PlannerContext): string {
  const bases = shortlist.options
    .map((option) => ({
      base: option.anchor.id,
      rows: option.candidates.map((c) => candidateLine(c, ctx)).sort(compareText),
    }))
    .sort((a, b) => compareText(a.base, b.base));
  const text = JSON.stringify({
    dates: shortlist.dates,
    bases,
    mustInclude: [...shortlist.mustInclude].sort(compareText),
    unplaceable: [...shortlist.unplaceable].sort(compareText),
  });
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** A pipeline run's outcome, or the name of what it threw (never expected, always reported). */
export type PlanAttempt = { ok: true; outcome: PlanOutcome } | { ok: false; error: string };

/** One plan through the production pipeline with the given model client and clock. */
export async function runPlan(
  request: TripRequest,
  llm: LlmClient,
  ctx: PlannerContext,
  options: { now: () => number; config: PlanConfig },
): Promise<PlanAttempt> {
  try {
    const outcome = await planTrip(request, { llm, ctx, now: options.now, config: options.config });
    return { ok: true, outcome };
  } catch (error) {
    // Decision: a throw (NoFeasiblePlanError or PlanGuardError reach the route as 4xx or 503) is
    // counted as a plan that is not valid, never allowed to stop the whole eval.
    const name = error instanceof Error ? error.name : typeof error;
    return { ok: false, error: name };
  }
}
