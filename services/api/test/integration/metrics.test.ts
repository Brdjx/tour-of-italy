import { describe, expect, it } from "vitest";
import { METRIC_NAMES, METRIC_NAMESPACE } from "../../src/lib/metrics";
import { LlmError } from "../../src/llm/errors";
import type { LlmProvider } from "../../src/llm/provider";
import type { TripStore } from "../../src/trips/store";
import { lastRequestLog, makeApp, postPlan, tripBody } from "../helpers/app";
import { ScriptedClient } from "../helpers/fakeClients";

// The alarms in infra/sam/template.yaml read metrics from the request log line (Embedded Metric
// Format). These tests prove the line carries them for the failures the Lambda Errors metric
// never sees: a handled 500, and plans that quietly fall back because the model call fails.

type Emf = { CloudWatchMetrics: { Namespace: string; Metrics: { Name: string }[] }[] };

function metricsOf(line: Record<string, unknown>) {
  const block = line._aws as Emf | undefined;
  const declared = block?.CloudWatchMetrics[0]?.Metrics.map((metric) => metric.Name) ?? [];
  return { block, declared };
}

describe("metrics on the request log line", () => {
  it("declares every value it writes, in the namespace the alarms read", async () => {
    const { app, logs } = makeApp({ emitMetrics: true });

    await app.request("/api/health");

    const line = lastRequestLog(logs);
    const { block, declared } = metricsOf(line);
    expect(block?.CloudWatchMetrics[0]?.Namespace).toBe(METRIC_NAMESPACE);
    expect(line).toMatchObject({ Service: "italy-planner-api", Requests: 1, ServerErrors: 0 });
    for (const name of declared) expect(line[name]).toBeTypeOf("number");
    expect(declared).not.toContain(METRIC_NAMES.aiPlans);
  });

  it("counts a handled 500, which never reaches the Lambda Errors metric", async () => {
    const broken: LlmProvider = {
      mode: "anthropic",
      session: async () => ({ ok: true, session: { client: null } }),
      status: async () => {
        throw new Error("status failed");
      },
      reportAuthFailure: () => {},
    };
    const { app, logs } = makeApp({ emitMetrics: true, llm: broken });

    const res = await app.request("/api/health");

    expect(res.status).toBe(500);
    expect(lastRequestLog(logs)).toMatchObject({ ServerErrors: 1 });
  });

  it("counts a plan that fell back because the model rejected the key as a model failure", async () => {
    const revoked = new ScriptedClient(async () => {
      throw new LlmError("auth", "Model API rejected the key", { status: 401 });
    });
    const { app, logs } = makeApp({ emitMetrics: true, client: revoked });

    const res = await postPlan(app, tripBody());

    expect(res.status).toBe(200);
    expect(lastRequestLog(logs)).toMatchObject({
      fallbackReason: "llm_error",
      [METRIC_NAMES.aiPlans]: 1,
      [METRIC_NAMES.aiFallbacks]: 1,
      [METRIC_NAMES.modelFailures]: 1,
    });
  });

  it("counts a good AI plan as a plan with no fallback", async () => {
    const { app, logs } = makeApp({ emitMetrics: true });

    await postPlan(app, tripBody(), { scenario: "valid" });

    expect(lastRequestLog(logs)).toMatchObject({
      source: "ai",
      [METRIC_NAMES.aiPlans]: 1,
      [METRIC_NAMES.aiFallbacks]: 0,
      [METRIC_NAMES.modelFailures]: 0,
    });
  });

  it("counts a plan once, when it is made, not again when the cache serves it", async () => {
    const { app, logs } = makeApp({ emitMetrics: true });
    await postPlan(app, tripBody(), { scenario: "valid" });

    await postPlan(app, tripBody(), { scenario: "valid" });

    const line = lastRequestLog(logs);
    expect(line.cache).toBe("hit-memory");
    expect(metricsOf(line).declared).not.toContain(METRIC_NAMES.aiPlans);
  });

  it("never counts a rules-only plan the caller asked for as an AI plan", async () => {
    const { app, logs } = makeApp({ emitMetrics: true });

    await postPlan(app, tripBody(), { query: "mode=deterministic" });

    expect(metricsOf(lastRequestLog(logs)).declared).not.toContain(METRIC_NAMES.aiPlans);
  });

  it("counts store use on plans and trips only, and a failed write as a failure", async () => {
    const { app, logs } = makeApp({ emitMetrics: true });
    const failing: TripStore = {
      kind: "memory",
      putNew: async () => {
        throw new Error("ThrottlingException");
      },
      get: async () => null,
    };
    const broken = makeApp({ emitMetrics: true, tripStore: failing });

    await app.request("/api/health");
    const health = metricsOf(lastRequestLog(logs)).declared;
    await postPlan(app, tripBody(), { scenario: "valid" });
    const kept = lastRequestLog(logs);
    await postPlan(broken.app, tripBody(), { scenario: "valid" });

    expect(health).not.toContain(METRIC_NAMES.tripStoreFailures);
    expect(kept).toMatchObject({ [METRIC_NAMES.tripStoreFailures]: 0 });
    expect(lastRequestLog(broken.logs)).toMatchObject({
      tripStore: "error",
      [METRIC_NAMES.tripStoreFailures]: 1,
      [METRIC_NAMES.serverErrors]: 0,
    });
  });

  it("keeps metrics off local and test log lines unless asked", async () => {
    const { app, logs } = makeApp();

    await app.request("/api/health");

    expect(lastRequestLog(logs)).not.toHaveProperty("_aws");
  });
});
