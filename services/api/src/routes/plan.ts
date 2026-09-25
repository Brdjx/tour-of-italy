import {
  type Itinerary,
  NoFeasiblePlanError,
  REQUEST_LIMITS,
  type TripRequest,
} from "@italy/planner";
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
import { type PlanTiming, planTrip } from "../plan/planTrip";
import { planRequestSchema } from "../plan/requestSchema";

// POST /api/plan: rate limit, read and validate the body, then plan (from the cache when the
// same AI plan was made recently on this instance). Every failure maps to a JSON error; model
// failures never surface at all, they become rules-only plans.

export interface PlanRouteDeps {
  config: Config;
  data: AppData;
  llm: LlmProvider;
  now: () => number;
  rateLimiter: RateLimiter;
  cache: LruCache<Itinerary>;
  timing?: PlanTiming;
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
      : planCacheKey({ promptVersion: PROMPT_VERSION, model: client.model, request });
  const cached = key === null ? undefined : deps.cache.get(key);
  if (cached !== undefined) {
    Object.assign(fields, { cache: "hit", source: cached.source, model: cached.meta.model });
    return c.json(cached);
  }
  if (key !== null) fields.cache = "miss";
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
  const source = outcome.itinerary.source;
  if (key !== null && (source === "ai" || source === "ai_repaired")) {
    deps.cache.set(key, outcome.itinerary);
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
