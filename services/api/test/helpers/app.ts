import { type AppDeps, createApp } from "../../src/app";
import { type Config, loadConfig } from "../../src/config";
import { shippedData } from "../../src/data";
import { LruCache } from "../../src/lib/cache";
import { createLogger } from "../../src/lib/logger";
import { createTokenBucket, type RateLimiter } from "../../src/lib/rateLimit";
import { staticSecret } from "../../src/lib/secrets";
import type { LlmClient } from "../../src/llm/client";
import { createLlmProvider, type LlmProvider } from "../../src/llm/provider";
import type { CachedPlan } from "../../src/plan/planCache";

// Builds the app for integration tests: the shipped data, a fixed clock, captured log lines, and
// a fixture or fake model client. No network, no AWS, no key.

/** 2026-09-23 12:00 UTC. Every test that depends on "today" uses this clock. */
export const FIXED_NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

/** A Monday about a month after FIXED_NOW, inside the accepted start-date window. */
export const START_DATE = "2026-10-19";

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: "test", GIT_SHA: "abc1234", LOG_LEVEL: "debug", ...env });
}

export interface TestApp {
  app: ReturnType<typeof createApp>;
  logs: string[]; // every log line written while the app ran
  cache: LruCache<CachedPlan>; // the plan cache's memory layer
}

export interface TestAppOptions extends Partial<Omit<AppDeps, "config">> {
  env?: Record<string, string>;
  client?: LlmClient; // a fixed model client for every request (anthropic-mode shape)
}

/** A provider that always returns `client`, like anthropic mode with a key. */
export function fixedClientProvider(client: LlmClient): LlmProvider {
  return {
    mode: "anthropic",
    session: async () => ({ ok: true, session: { client } }),
    status: async () => ({ available: true, model: client.model }),
    reportAuthFailure: () => {},
  };
}

export function makeApp(options: TestAppOptions = {}): TestApp {
  const config = testConfig({ LLM_MODE: "fixture", ...options.env });
  const logs: string[] = [];
  const data = options.data ?? shippedData();
  const cache = options.planCache ?? new LruCache<CachedPlan>(100);
  const llm =
    options.llm ??
    (options.client
      ? fixedClientProvider(options.client)
      : createLlmProvider({ config, ctx: data.ctx, apiKey: staticSecret(config.anthropicApiKey) }));
  const logger =
    options.logger ?? createLogger({ level: "debug", sink: (line) => logs.push(line) });
  const rateLimiter: RateLimiter =
    options.rateLimiter ??
    createTokenBucket({ capacity: 1000, refillPerMinute: 1000, maxKeys: 100 });
  const app = createApp({
    ...options,
    config,
    data,
    llm,
    logger,
    now: options.now ?? (() => FIXED_NOW),
    rateLimiter,
    planCache: cache,
  });
  return { app, logs, cache };
}

/** A valid trip request body; override any field. */
export function tripBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startDate: START_DATE,
    pace: "balanced",
    interests: ["historic", "food"],
    maxPriceLevel: null,
    anchors: "auto",
    mustInclude: [],
    exclude: [],
    ...overrides,
  };
}

export interface PostOptions {
  scenario?: string; // x-fixture-scenario
  query?: string; // e.g. "mode=deterministic"
  headers?: Record<string, string>;
}

export function postPlan(
  app: TestApp["app"],
  body: unknown,
  options: PostOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };
  if (options.scenario) headers["x-fixture-scenario"] = options.scenario;
  const path = options.query ? `/api/plan?${options.query}` : "/api/plan";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return Promise.resolve(app.request(path, { method: "POST", headers, body: text }));
}

/** The parsed log lines. */
export function logRecords(logs: readonly string[]): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The request log line for the last request. */
export function lastRequestLog(logs: readonly string[]): Record<string, unknown> {
  const records = logRecords(logs).filter((record) => record.event === "request");
  const last = records.at(-1);
  if (!last) throw new Error("No request log line was written");
  return last;
}
