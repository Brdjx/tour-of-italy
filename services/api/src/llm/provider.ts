import type { PlannerContext } from "@italy/planner";
import type { Config, LlmMode, LlmOffReason } from "../config";
import type { SecretSource } from "../lib/secrets";
import { createAnthropicClient } from "./anthropic";
import type { LlmClient } from "./client";
import { FixtureClient, isFixtureScenario } from "./fixture";

// Chooses the model client for each plan request from LLM_MODE: the real Claude API client
// (once the key is available), a fixture scenario named by the x-fixture-scenario header, or none.

export const FIXTURE_HEADER = "x-fixture-scenario";

export interface LlmSession {
  client: LlmClient | null;
  offReason?: LlmOffReason; // why client is null
}

export type SessionResult =
  | { ok: true; session: LlmSession }
  | { ok: false; error: "unknown_scenario" };

export interface LlmStatus {
  available: boolean; // AI planning can run right now
  model: string | null; // the model a plan would use, null when none
}

export interface LlmProvider {
  readonly mode: LlmMode;
  session(fixtureScenario: string | undefined): Promise<SessionResult>;
  status(): Promise<LlmStatus>;
  /** The API rejected the key (401 or 403): re-read it, and report AI unavailable until it changes. */
  reportAuthFailure(): void;
}

export interface ProviderOptions {
  config: Config;
  ctx: PlannerContext;
  apiKey: SecretSource; // the Anthropic key (env locally, SSM in production)
  createClient?: (apiKey: string) => LlmClient; // tests pass a fake
}

function anthropicProvider(options: ProviderOptions): LlmProvider {
  const { config } = options;
  const create =
    options.createClient ??
    ((apiKey: string) =>
      createAnthropicClient({ apiKey, model: config.model, effort: config.llmEffort }));
  let cached: { key: string; client: LlmClient } | undefined;
  let rejectedKey: string | undefined;
  return {
    mode: "anthropic",
    async session() {
      const key = await options.apiKey.get();
      // Decision: a key that cannot be read (SSM down, parameter missing) plans without AI and
      // says no_key, never a 500. The key source retries on a later request.
      if (key === null) return { ok: true, session: { client: null, offReason: "no_key" } };
      if (cached?.key !== key) cached = { key, client: create(key) };
      return { ok: true, session: { client: cached.client } };
    },
    async status() {
      const key = await options.apiKey.get();
      // Decision: a key the API rejected counts as unavailable, so health tells the truth
      // while a revoked key is still cached. A new key (rotation) clears it.
      const available = key !== null && key !== rejectedKey;
      return { available, model: available ? config.model : null };
    },
    reportAuthFailure() {
      rejectedKey = cached?.key;
      void options.apiKey.get({ forceRefresh: true });
    },
  };
}

function fixtureProvider(options: ProviderOptions): LlmProvider {
  return {
    mode: "fixture",
    async session(scenario) {
      const name = scenario ?? "valid";
      if (!isFixtureScenario(name)) return { ok: false, error: "unknown_scenario" };
      return { ok: true, session: { client: new FixtureClient(options.ctx, name) } };
    },
    status: async () => ({ available: true, model: "fixture" }),
    reportAuthFailure: () => {},
  };
}

function offProvider(reason: LlmOffReason): LlmProvider {
  return {
    mode: "off",
    session: async () => ({ ok: true, session: { client: null, offReason: reason } }),
    status: async () => ({ available: false, model: null }),
    reportAuthFailure: () => {},
  };
}

export function createLlmProvider(options: ProviderOptions): LlmProvider {
  const { config } = options;
  if (config.llmMode === "fixture" && !config.isProduction) return fixtureProvider(options);
  if (config.llmMode === "anthropic") return anthropicProvider(options);
  return offProvider(config.llmOffReason ?? "disabled");
}
