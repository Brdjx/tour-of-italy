import { describe, expect, it } from "vitest";
import { ConfigError, hasLlmKeySource, loadConfig } from "../../src/config";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty, so a bare checkout starts", () => {
    const config = loadConfig({});

    expect(config.model).toBe("claude-sonnet-5");
    expect(config.llmEnabled).toBe(true);
    expect(config.llmEffort).toBe("low");
    expect(config.planDeadlineMs).toBe(24_000);
    expect(config.llmTimeoutMs).toBe(15_000);
    expect(config.llmMaxAttempts).toBe(2);
    expect(config.gitSha).toBe("local");
    expect(config.port).toBe(8787);
  });

  it("reads the trips table name, and refuses one DynamoDB would not accept", () => {
    expect(loadConfig({}).tripsTable).toBeUndefined();
    expect(loadConfig({ TRIPS_TABLE: "italy-planner-trips" }).tripsTable).toBe(
      "italy-planner-trips",
    );
    expect(() => loadConfig({ TRIPS_TABLE: "trips table" })).toThrow(/TRIPS_TABLE/);
  });

  it("keeps the plan deadline under the API Gateway 30 s cap by default", () => {
    expect(loadConfig({}).planDeadlineMs).toBeLessThan(30_000);
  });

  it("treats a missing or empty API key as no key, not an error", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "" });

    expect(config.anthropicApiKey).toBeUndefined();
    expect(hasLlmKeySource(config)).toBe(false);
    expect(config.llmMode).toBe("off");
    expect(config.llmOffReason).toBe("no_key");
  });

  it("counts an SSM parameter name as a key source", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY_PARAM: "/italy-planner/anthropic-api-key" });

    expect(hasLlmKeySource(config)).toBe(true);
    expect(config.llmMode).toBe("anthropic");
  });

  it("reports no key source when the AI layer is switched off", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "test-key", LLM_ENABLED: "false" });

    expect(hasLlmKeySource(config)).toBe(false);
    expect(config.llmMode).toBe("off");
    expect(config.llmOffReason).toBe("disabled");
  });

  it("fails fast on invalid values instead of running with a guessed setting", () => {
    expect(() => loadConfig({ LLM_TIMEOUT_MS: "soon" })).toThrow(ConfigError);
    expect(() => loadConfig({ LLM_EFFORT: "extreme" })).toThrow(/LLM_EFFORT/);
    expect(() => loadConfig({ LLM_MODE: "magic" })).toThrow(/LLM_MODE/);
    expect(() => loadConfig({ LLM_MAX_ATTEMPTS: "9" })).toThrow(/LLM_MAX_ATTEMPTS/);
  });

  it("never echoes an invalid value in the error, so a pasted key cannot reach a crash log", () => {
    const secret = "sk-ant-test-FAKE-pasted-into-the-wrong-variable";

    expect(() => loadConfig({ LLM_TIMEOUT_MS: secret })).toThrow(ConfigError);
    try {
      loadConfig({ LLM_TIMEOUT_MS: secret });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });

  it("requires the origin-verify parameter in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/ORIGIN_VERIFY_PARAM/);

    const config = loadConfig({
      NODE_ENV: "production",
      ORIGIN_VERIFY_PARAM: "/italy-planner/origin-verify-secret",
    });
    expect(config.isProduction).toBe(true);
  });

  it("refuses fixture mode in production, so scripted answers never reach travelers", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        ORIGIN_VERIFY_PARAM: "/italy-planner/origin-verify-secret",
        LLM_MODE: "fixture",
      }),
    ).toThrow(/LLM_MODE/);
  });

  it("uses fixture mode when asked outside production, even without a key", () => {
    const config = loadConfig({ LLM_MODE: "fixture" });

    expect(config.llmMode).toBe("fixture");
    expect(config.llmOffReason).toBeUndefined();
  });

  it("says no_key when anthropic mode is forced without a key", () => {
    const config = loadConfig({ LLM_MODE: "anthropic" });

    expect(config.llmMode).toBe("off");
    expect(config.llmOffReason).toBe("no_key");
  });

  it("refuses a plan deadline the API Gateway 30 s cap would cut off", () => {
    expect(() => loadConfig({ PLAN_DEADLINE_MS: "600000" })).toThrow(/PLAN_DEADLINE_MS/);
    expect(loadConfig({ PLAN_DEADLINE_MS: "26000" }).planDeadlineMs).toBe(26_000);
  });

  it("refuses a model timeout longer than the whole plan deadline", () => {
    expect(() => loadConfig({ LLM_TIMEOUT_MS: "25000", PLAN_DEADLINE_MS: "24000" })).toThrow(
      /LLM_TIMEOUT_MS/,
    );
  });

  it("requires at least two model attempts, so an invalid answer is never mislabelled as repaired", () => {
    expect(() => loadConfig({ LLM_MAX_ATTEMPTS: "1" })).toThrow(/LLM_MAX_ATTEMPTS/);
  });

  it("refuses to start inside AWS Lambda unless NODE_ENV is production, so the origin check cannot be skipped", () => {
    const lambda = { AWS_LAMBDA_FUNCTION_NAME: "italy-planner-api" };
    expect(() => loadConfig(lambda)).toThrow(ConfigError);
    expect(() => loadConfig({ ...lambda, NODE_ENV: "test", LLM_MODE: "fixture" })).toThrow(
      /production/,
    );
    const production = { NODE_ENV: "production", ORIGIN_VERIFY_PARAM: "/italy-planner/o" };
    expect(loadConfig({ ...lambda, ...production }).isProduction).toBe(true);
  });

  it("lets LLM_ENABLED=false override every mode (the production kill switch)", () => {
    const config = loadConfig({ LLM_MODE: "fixture", LLM_ENABLED: "false" });

    expect(config.llmMode).toBe("off");
    expect(config.llmOffReason).toBe("disabled");
  });
});
