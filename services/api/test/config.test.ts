import { describe, expect, it } from "vitest";
import { ConfigError, hasLlmKeySource, loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    const config = loadConfig({});

    expect(config.model).toBe("claude-sonnet-5");
    expect(config.llmEnabled).toBe(true);
    expect(config.llmEffort).toBe("low");
    expect(config.planDeadlineMs).toBe(24_000);
    expect(config.gitSha).toBe("local");
    expect(config.port).toBe(8787);
  });

  it("treats a missing or empty API key as no key, not an error", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "" });

    expect(config.anthropicApiKey).toBeUndefined();
    expect(hasLlmKeySource(config)).toBe(false);
  });

  it("counts an SSM parameter name as a key source", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY_PARAM: "/italy-planner/anthropic-api-key" });

    expect(hasLlmKeySource(config)).toBe(true);
  });

  it("reports no key source when the AI layer is switched off", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "test-key", LLM_ENABLED: "false" });

    expect(hasLlmKeySource(config)).toBe(false);
  });

  it("fails fast on invalid values", () => {
    expect(() => loadConfig({ LLM_TIMEOUT_MS: "soon" })).toThrow(ConfigError);
    expect(() => loadConfig({ LLM_EFFORT: "extreme" })).toThrow(/LLM_EFFORT/);
  });

  it("requires the origin-verify parameter in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/ORIGIN_VERIFY_PARAM/);

    const config = loadConfig({
      NODE_ENV: "production",
      ORIGIN_VERIFY_PARAM: "/italy-planner/origin-verify-secret",
    });
    expect(config.isProduction).toBe(true);
  });
});
