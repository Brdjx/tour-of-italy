import { NoFeasiblePlanError, REQUEST_LIMITS, type TripRequest } from "@italy/planner";
import type { Context, Hono } from "hono";
import type { Config } from "../config";
import type { AppData } from "../data";
import { type AppEnv, platformSourceIp } from "../lib/appEnv";
import { readJsonBody } from "../lib/body";
import { type LruCache, planCacheKey } from "../lib/cache";
import { clientIp, rateLimitKey } from "../lib/clientIp";
import { sendError, zodDetails } from "../lib/httpErrors";
import type { LogFields } from "../lib/logger";
import { notesForLog } from "../lib/logger";
import type { RateLimiter } from "../lib/rateLimit";
import { PROMPT_VERSION } from "../llm/prompt";
import { FIXTURE_HEADER, type LlmProvider, type LlmSession } from "../llm/provider";
import type { PlanTrace } from "../plan/outcome";
import { PlanGuardError } from "../plan/outcome";
import { type CachedPlan, cachePlan, readCachedPlan } from "../plan/planCache";
import { type PlanTiming, planTrip } from "../plan/planTrip";
import { planRequestSchema } from "../plan/requestSchema";
import type { RandomSource } from "../trips/ids";
import { keepAiPlan } from "../trips/keepPlan";
import { isAiItinerary } from "../trips/records";
import type { TripStore } from "../trips/store";

// POST /api/plan: rate limit, read and validate the body, then plan, from the AI plan cache when
// the same options were planned recently (plan/planCache.ts: this instance's memory, then the
// shared table). An AI plan's content is kept under a planId so the trip can be saved with it
// later (trips/keepPlan.ts). Every failure maps to a JSON error; model failures never surface at
// all, they become rules-only plans.

export interface PlanRouteDeps {
  config: Config;
  data: AppData;
  llm: LlmProvider;
  now: () => number;
  rateLimiter: RateLimiter;
  cache: LruCache<CachedPlan>; // the cache's memory layer; its shared layer is `store`
  dataVersion: string; // the fingerprint of the places this API serves, part of the cache key
  timing?: PlanTiming;
  store: TripStore | null; // AI plan records (trips/keepPlan.ts) and the shared plan cache
  random?: RandomSource;
}

type Mode = "auto" | "deterministic";

function parseMode(value: string | undefined): Mode | null {
  if (value === undefined || value === "auto") return "auto";
  return value === "deterministic" ? "deterministic" : null;
}

/** The plan's fields for the request log line: never the key, never full notes. */
function traceFields(fields: LogFields, trace: PlanTrace): void {
  Object.assign(fields, {
    source: trace.source,
    fallbackReason: trace.fallbackReason,
    model: trace.model,
    promptVersion: trace.promptVersion,
    attempts: trace.attempts,
    violationCodes: trace.violationCodes,
    tidied: trace.tidied,
    llmErrors: trace.llmErrors,
    llmFailures: trace.llmFailures.length > 0 ? trace.llmFailures : undefined,
    stopReasons: trace.stopReasons,
    usage: trace.usage,
    llmLatencyMs: trace.llmLatencyMs,
    reasonsKept: trace.reasonsKept,
    reasonRejections: trace.reasonRejections,
    guardFailed: trace.guardFailed || undefined,
  });
}

async function sessionFor(c: Context<AppEnv>, deps: PlanRouteDeps, mode: Mode) {
  if (mode === "deterministic") {
    return { ok: true as const, session: { client: null } satisfies LlmSession };
  }
  return deps.llm.session(c.req.header(FIXTURE_HEADER));
}

async function plan(
  c: Context<AppEnv>,
  deps: PlanRouteDeps,
  request: TripRequest,
  mode: Mode,
  startedAt: number,
) {
  const fields = c.get("logFields");
  const found = await sessionFor(c, deps, mode);
  if (!found.ok) {
    return sendError(c, 400, "unknown_fixture_scenario", "Unknown fixture scenario");
  }
  const { client, offReason } = found.session;
  // Decision: only AI plans are cached. Rules-only plans take about 10 ms, and caching a
  // fallback caused by a passing outage would pin the degraded plan for this request.
  const key =
    client === null
      ? null
      : planCacheKey({
          promptVersion: PROMPT_VERSION,
          model: client.model,
          codeVersion: deps.config.gitSha,
          dataVersion: deps.dataVersion,
          request,
        });
  const cacheDeps = { memory: deps.cache, store: deps.store, now: deps.now };
  const cached = key === null ? undefined : await readCachedPlan(key, request, cacheDeps, fields);
  if (cached !== undefined) {
    Object.assign(fields, { source: cached.source, model: cached.meta.model });
    // Decision: the plan answers with this request, not the one it was made for. The key treats
    // the two as the same trip (interests and places in another order), so the plan meets every
    // rule for it, and the page shows the options the traveler just sent.
    return c.json({ ...cached, request });
  }
  const { config } = deps;
  const outcome = await planTrip(
    request,
    {
      llm: client,
      offReason,
      ctx: deps.data.ctx,
      now: deps.now,
      config: {
        timeoutMs: config.llmTimeoutMs,
        deadlineMs: config.planDeadlineMs,
        maxAttempts: config.llmMaxAttempts,
      },
      ...(deps.timing === undefined ? {} : { timing: deps.timing }),
    },
    { mode, startedAt },
  );
  traceFields(fields, outcome.trace);
  // A rejected key is re-read from SSM at once (rate-limited there), so a rotated key takes
  // effect on the next plan instead of after the cache TTL.
  if (outcome.trace.llmErrors.includes("auth")) deps.llm.reportAuthFailure();
  // An AI plan's content is kept first, so the cached copy carries its planId too.
  if (key !== null && isAiItinerary(outcome.itinerary)) {
    await keepAiPlan(outcome.itinerary, deps, fields);
    await cachePlan(key, outcome.itinerary, cacheDeps, fields);
  }
  return c.json(outcome.itinerary);
}

export function registerPlanRoute(app: Hono<AppEnv>, deps: PlanRouteDeps): void {
  app.post("/plan", async (c) => {
    // Decision: the plan deadline counts from arrival (set by the first middleware), so time
    // spent in the origin check's SSM read is inside PLAN_DEADLINE_MS and meta.latencyMs.
    const startedAt = c.get("arrivedAt") ?? deps.now();
    const fields = c.get("logFields");
    const ip = clientIp((name) => c.req.header(name), platformSourceIp(c.env));
    const decision = deps.rateLimiter.take(rateLimitKey(ip));
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSec));
      return sendError(c, 429, "rate_limited", "Too many plan requests. Try again in a minute.");
    }
    const mode = parseMode(c.req.query("mode"));
    if (mode === null) {
      const details = [{ path: "mode", message: "Expected deterministic or auto" }];
      return sendError(c, 400, "bad_request", "The query string is not valid", details);
    }
    const body = await readJsonBody(c.req.raw, REQUEST_LIMITS.maxBodyBytes);
    if (!body.ok) return sendError(c, body.status, body.code, body.message);
    const parsed = planRequestSchema(deps.data.known).safeParse(body.value);
    if (!parsed.success) {
      const message = "The trip request is not valid";
      return sendError(c, 400, "bad_request", message, zodDetails(parsed.error));
    }
    fields.notes = notesForLog(parsed.data.notes);
    try {
      return await plan(c, deps, parsed.data, mode, startedAt);
    } catch (error) {
      if (error instanceof NoFeasiblePlanError) {
        const message = "No plan fits these settings. Try fewer exclusions or other bases.";
        return sendError(c, 422, "no_feasible_plan", message);
      }
      if (error instanceof PlanGuardError) {
        fields.error = error;
        return sendError(c, 503, "plan_unavailable", "A plan could not be made. Please try again.");
      }
      throw error;
    }
  });
}
