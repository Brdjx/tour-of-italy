import { randomUUID } from "node:crypto";
import type { Itinerary } from "@italy/planner";
import { Hono } from "hono";
import { cors } from "hono/cors";
import packageJson from "../package.json" with { type: "json" };
import type { Config } from "./config";
import type { HealthResponse } from "./contract";
import { type AppData, shippedData } from "./data";
import type { AppEnv } from "./lib/appEnv";
import { LruCache, PLAN_CACHE_ENTRIES } from "./lib/cache";
import { CACHE_CONTROL, prepareJson, sendPreparedJson } from "./lib/httpCache";
import { sendError } from "./lib/httpErrors";
import { createLogger, type Logger } from "./lib/logger";
import { embeddedMetrics } from "./lib/metrics";
import { originVerify } from "./lib/originVerify";
import { createTokenBucket, PLAN_RATE_LIMIT, type RateLimiter } from "./lib/rateLimit";
import { REQUEST_ID_HEADER, resolveRequestId, safeRequestId } from "./lib/requestId";
import { type SecretSource, staticSecret } from "./lib/secrets";
import { createLlmProvider, type LlmProvider } from "./llm/provider";
import type { PlanTiming } from "./plan/planTrip";
import { registerPlanRoute } from "./routes/plan";
import { buildDataIssuesPayload, buildMeta, buildPlacesPayload } from "./routes/readPayloads";

// The Hono app and its routes. No platform code lives here: local.ts serves it with Node and
// lambda.ts wraps it for AWS Lambda, so tests call app.request() with fakes for every dependency.

export interface AppDeps {
  config: Config;
  data?: AppData; // the dataset; the shipped one by default
  llm?: LlmProvider; // model client per request; built from config by default
  logger?: Logger; // one JSON line per request; stdout by default
  now?: () => number; // clock for dates, deadlines, and latencies
  originSecret?: SecretSource | null; // production: the CloudFront origin secret
  rateLimiter?: RateLimiter;
  planCache?: LruCache<Itinerary>;
  timing?: PlanTiming; // plan deadline tuning, for tests
  emitMetrics?: boolean; // CloudWatch metrics on the request log line; on in production
}

const WEB_DEV_ORIGIN = "http://localhost:3000";

/** Routes and the methods they answer; any other method gets 405 with an Allow header. */
const ROUTE_METHODS: Record<string, string> = {
  "/health": "GET, HEAD",
  "/meta": "GET, HEAD",
  "/places": "GET, HEAD",
  "/data-issues": "GET, HEAD",
  "/plan": "POST",
};

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const data = deps.data ?? shippedData();
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? createLogger({ level: config.logLevel, now });
  logger.addSecret(config.anthropicApiKey); // a key from the environment is never logged
  const llm =
    deps.llm ??
    createLlmProvider({ config, ctx: data.ctx, apiKey: staticSecret(config.anthropicApiKey) });
  const app = new Hono<AppEnv>().basePath("/api");

  const emitMetrics = deps.emitMetrics ?? config.isProduction;

  // Request id and one log line per request, around everything else (403s and 404s included).
  app.use("*", async (c, next) => {
    const startedAt = now();
    c.set("arrivedAt", startedAt);
    const incoming = c.req.header(REQUEST_ID_HEADER);
    // Decision: in production the id is always generated here. A client-chosen id could repeat
    // another request's id and confuse log correlation; what it sent is logged beside ours, with
    // CloudFront's own id for matching edge logs.
    const requestId = config.isProduction ? randomUUID() : resolveRequestId(incoming);
    c.set("requestId", requestId);
    c.set(
      "logFields",
      config.isProduction
        ? {
            clientRequestId: safeRequestId(incoming),
            cloudfrontId: safeRequestId(c.req.header("x-amz-cf-id")),
          }
        : {},
    );
    await next();
    c.header(REQUEST_ID_HEADER, requestId);
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", CACHE_CONTROL.never);
    const { method, path } = c.req;
    const status = c.res.status;
    const fields = {
      requestId,
      method,
      path: path.slice(0, 200),
      status,
      latencyMs: now() - startedAt,
    };
    const extra = c.get("logFields");
    const metrics = emitMetrics ? embeddedMetrics(status, extra, now()) : {};
    const level = status >= 500 ? "error" : "info";
    logger[level]("request", { ...fields, ...extra, ...metrics });
  });

  // Decision: CORS only outside production, for the Next dev server. In production CloudFront
  // serves the site and the API from one origin, so no cross-origin access is ever granted.
  if (!config.isProduction) {
    app.use(
      "*",
      cors({
        origin: WEB_DEV_ORIGIN,
        allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
        allowHeaders: ["content-type", "x-request-id", "x-fixture-scenario"],
        exposeHeaders: ["x-request-id"],
        maxAge: 600,
      }),
    );
  }
  // Decision: the origin check runs whenever an origin secret is configured, not only when
  // NODE_ENV says production, so a Lambda deployed with a wrong NODE_ENV still fails closed.
  if (config.isProduction || config.originVerifyParam !== undefined) {
    app.use("*", originVerify(deps.originSecret ?? null, { now }));
  }

  const meta = prepareJson(buildMeta(data));
  const places = prepareJson(buildPlacesPayload(data));
  const dataIssues = prepareJson(buildDataIssuesPayload(data));

  // Decision: health reports the deployed commit so the deploy smoke test can prove the new code
  // is live, not just that something answers.
  app.get("/health", async (c) => {
    const status = await llm.status();
    const body: HealthResponse = {
      ok: true,
      version: packageJson.version,
      commit: config.gitSha,
      llmAvailable: status.available,
      model: status.model,
    };
    return c.json(body);
  });
  app.get("/meta", (c) => sendPreparedJson(c, meta));
  app.get("/places", (c) => sendPreparedJson(c, places));
  app.get("/data-issues", (c) => sendPreparedJson(c, dataIssues));
  registerPlanRoute(app, {
    config,
    data,
    llm,
    now,
    rateLimiter: deps.rateLimiter ?? createTokenBucket({ ...PLAN_RATE_LIMIT, now }),
    cache: deps.planCache ?? new LruCache<Itinerary>(PLAN_CACHE_ENTRIES),
    ...(deps.timing === undefined ? {} : { timing: deps.timing }),
  });

  for (const [path, allow] of Object.entries(ROUTE_METHODS)) {
    app.all(path, (c) => {
      c.header("Allow", allow);
      return sendError(c, 405, "method_not_allowed", "Method not allowed");
    });
  }
  app.notFound((c) => sendError(c, 404, "not_found", "Not found"));
  // Decision: the client gets a fixed message and the request id; the error itself (redacted)
  // goes only to the log line, so stack traces and internals never leave the function.
  app.onError((error, c) => {
    const fields = c.get("logFields") as AppEnv["Variables"]["logFields"] | undefined;
    if (fields) fields.error = error;
    return sendError(c, 500, "internal_error", "Something went wrong. Please try again.");
  });
  return app;
}

export type App = ReturnType<typeof createApp>;
