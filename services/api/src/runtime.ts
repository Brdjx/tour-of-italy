import { handle } from "hono/aws-lambda";
import { type AppDeps, createApp } from "./app";
import type { Config } from "./config";
import { shippedData } from "./data";
import { createLogger, type Logger } from "./lib/logger";
import {
  createCachedSecret,
  type ParameterFetcher,
  type SecretSource,
  staticSecret,
} from "./lib/secrets";
import { createSsmFetcher } from "./lib/ssm";
import type { LlmClient } from "./llm/client";
import { createLlmProvider } from "./llm/provider";

// Wires the real dependencies for a running process: SSM-backed secrets, the stdout logger, and
// the model provider. lambda.ts and local.ts call this; tests call createApp with fakes, or this
// with a fake SSM fetcher.

export interface RuntimeOverrides {
  fetchParameter?: ParameterFetcher; // SSM reader; the real one by default
  logger?: Logger;
  now?: () => number;
  createClient?: (apiKey: string) => LlmClient; // model client per key; the real one by default
}

// Decision: the origin secret is re-read every 5 minutes (rotation takes effect within that, or
// at once through the forced re-read on a mismatch, at most every 10 s). After an SSM failure the
// check fails closed for 5 s before trying again.
const ORIGIN_SECRET_CACHE = { ttlMs: 5 * 60_000, minRefreshMs: 10_000, retryAfterFailureMs: 5_000 };

// Decision: the Anthropic key is re-read every 15 minutes, and at once (at most once a minute)
// when the API rejects it, so a rotated key reaches warm instances without a redeploy. After a
// failed read, plans run without AI and the read is retried a minute later.
const API_KEY_CACHE = {
  ttlMs: 15 * 60_000,
  minRefreshMs: 60_000,
  retryAfterFailureMs: 60_000,
};

const SSM_TIMEOUT_MS = 3_000;

function apiKeySource(
  config: Config,
  fetch: ParameterFetcher,
  logger: Logger,
  now: () => number,
): SecretSource {
  if (config.anthropicApiKey !== undefined) return staticSecret(config.anthropicApiKey);
  if (config.anthropicKeyParam === undefined) return staticSecret(undefined);
  return createCachedSecret({
    name: config.anthropicKeyParam,
    fetch,
    timeoutMs: SSM_TIMEOUT_MS,
    now,
    ...API_KEY_CACHE,
    onValue: (value) => logger.addSecret(value),
    onError: (error) =>
      logger.warn("secret_read_failed", { parameter: "anthropic_api_key", error }),
  });
}

function originSecretSource(
  config: Config,
  fetch: ParameterFetcher,
  logger: Logger,
  now: () => number,
): SecretSource | null {
  if (config.originVerifyParam === undefined) return null;
  return createCachedSecret({
    name: config.originVerifyParam,
    fetch,
    timeoutMs: SSM_TIMEOUT_MS,
    now,
    ...ORIGIN_SECRET_CACHE,
    onValue: (value) => logger.addSecret(value),
    onError: (error) => logger.error("secret_read_failed", { parameter: "origin_verify", error }),
  });
}

export function createRuntimeDeps(config: Config, overrides: RuntimeOverrides = {}): AppDeps {
  const now = overrides.now ?? Date.now;
  const logger = overrides.logger ?? createLogger({ level: config.logLevel, now });
  logger.addSecret(config.anthropicApiKey);
  const fetch = overrides.fetchParameter ?? createSsmFetcher();
  const data = shippedData();
  const apiKey = apiKeySource(config, fetch, logger, now);
  // The origin secret is read whenever its parameter is configured (see createApp).
  const originSecret = originSecretSource(config, fetch, logger, now);
  // Decision: start both reads at cold start (without waiting), so the first request does not
  // pay for them. Failures are logged by the sources and retried later.
  void apiKey.get();
  void originSecret?.get();
  return {
    config,
    data,
    logger,
    now,
    originSecret,
    llm: createLlmProvider({
      config,
      ctx: data.ctx,
      apiKey,
      ...(overrides.createClient === undefined ? {} : { createClient: overrides.createClient }),
    }),
  };
}

export function createLambdaHandler(config: Config, overrides: RuntimeOverrides = {}) {
  return handle(createApp(createRuntimeDeps(config, overrides)));
}
