import { checkDayBase, REQUEST_LIMITS } from "@italy/planner";
import type { Hono } from "hono";
import { type AppEnv, platformSourceIp } from "../lib/appEnv";
import { readJsonBody } from "../lib/body";
import type { LruCache } from "../lib/cache";
import { clientIp, rateLimitKey } from "../lib/clientIp";
import { sendError, zodDetails } from "../lib/httpErrors";
import { notesForLog } from "../lib/logger";
import { DAY_PROMPT_VERSION } from "../llm/dayPrompt";
import { type CachedDay, cacheDay, dayCacheKey, readCachedDay } from "../plan/dayCache";
import { dayInputOf, planDayBodySchema } from "../plan/dayInput";
import { PlanGuardError } from "../plan/outcome";
import { replanDay } from "../plan/replanDay";
import { type PlanRouteDeps, parseMode, sessionFor, traceFields } from "./plan";

// POST /api/plan/day: one day of a trip the page already has, planned again at a base the
// traveler picked (another city, or the day's own for a new version of it). Registered like
// POST /api/plan: the same origin check and rate limit (one budget per client for both, since
// both spend model calls), JSON only, the same body cap, a strict body checked against the data,
// the request checked with the plan route's schema. A base the day cannot take is refused (422)
// with the reason the page shows beside it (dayBaseOptions); anything else answers with a day,
// from the AI day cache, the model, or the rules. Model failures never surface.

export interface PlanDayRouteDeps extends Omit<PlanRouteDeps, "cache"> {
  dayCache: LruCache<CachedDay>; // the day cache's memory layer; its shared layer is `store`
}

export function registerPlanDayRoute(app: Hono<AppEnv>, deps: PlanDayRouteDeps): void {
  app.post("/plan/day", async (c) => {
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
    const { ctx, known } = deps.data;
    const parsed = planDayBodySchema(known, ctx).safeParse(body.value);
    if (!parsed.success) {
      const message = "The day request is not valid";
      return sendError(c, 400, "bad_request", message, zodDetails(parsed.error));
    }
    const input = dayInputOf(parsed.data);
    Object.assign(fields, { notes: notesForLog(input.request.notes), day: input.day });
    const check = checkDayBase(input.request, input.days, input.day, input.anchorId, ctx, {
      avoid: input.avoid,
    });
    if (check.day === null) {
      fields.dayRefused = true;
      const reason = check.option.reason ?? "This day cannot move to that city.";
      return sendError(c, 422, "day_not_allowed", reason);
    }
    const found = await sessionFor(c, deps, mode);
    if (!found.ok) {
      return sendError(c, 400, "unknown_fixture_scenario", "Unknown fixture scenario");
    }
    const { client, offReason } = found.session;
    // Decision: only AI days are cached, as only AI plans are: the rules-only day takes a few
    // milliseconds, and caching a fallback would pin a passing outage's answer.
    const key =
      client === null
        ? null
        : dayCacheKey({
            promptVersion: DAY_PROMPT_VERSION,
            model: client.model,
            codeVersion: deps.config.gitSha,
            dataVersion: deps.dataVersion,
            input,
          });
    const cacheDeps = { memory: deps.dayCache, store: deps.store, now: deps.now, ctx };
    const cached = key === null ? undefined : await readCachedDay(key, input, cacheDeps, fields);
    if (cached !== undefined) {
      Object.assign(fields, { source: cached.source, model: cached.meta.model });
      return c.json(cached);
    }
    const { config } = deps;
    try {
      const outcome = await replanDay(
        input,
        check.day,
        {
          llm: client,
          offReason,
          ctx,
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
      if (outcome.trace.llmErrors.includes("auth")) deps.llm.reportAuthFailure();
      if (key !== null && outcome.result.source !== "deterministic") {
        await cacheDay(key, input, outcome.result, cacheDeps, fields);
      }
      return c.json(outcome.result);
    } catch (error) {
      if (error instanceof PlanGuardError) {
        fields.error = error;
        return sendError(c, 503, "plan_unavailable", "A plan could not be made. Please try again.");
      }
      throw error;
    }
  });
}
