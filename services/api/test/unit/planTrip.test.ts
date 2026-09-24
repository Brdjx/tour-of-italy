import { type TripRequest, TripRequestSchema } from "@italy/planner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shippedData } from "../../src/data";
import { LlmError } from "../../src/llm/errors";
import { FIXTURE_SCENARIOS, FixtureClient, type FixtureScenario } from "../../src/llm/fixture";
import { validSelection } from "../../src/llm/fixtureAnswers";
import { type PlanDeps, planTrip } from "../../src/plan/planTrip";
import { START_DATE } from "../helpers/app";
import { ScriptedClient, textResult } from "../helpers/fakeClients";
import { expectValidItinerary } from "../helpers/validPlan";

// Failure vector F2: the AI path must end in a valid plan with the right label, inside the
// deadline, whatever the model does. Fake timers make the slow scenarios instant and exact.

const { ctx } = shippedData();
const DEADLINE = 24_000;
const TIMEOUT = 12_000;

function request(overrides: Record<string, unknown> = {}): TripRequest {
  return TripRequestSchema.parse({ startDate: START_DATE, pace: "balanced", ...overrides });
}

function deps(llm: PlanDeps["llm"], overrides: Partial<PlanDeps> = {}): PlanDeps {
  return {
    llm,
    ctx,
    now: () => Date.now(),
    config: { timeoutMs: TIMEOUT, deadlineMs: DEADLINE, maxAttempts: 2 },
    ...overrides,
  };
}

/** Runs planTrip under fake timers, 100 ms at a time, and reports when it settled. */
async function run(llm: PlanDeps["llm"], overrides: Partial<PlanDeps> = {}, req = request()) {
  const started = Date.now();
  let settledAt: number | undefined;
  const pending = planTrip(req, deps(llm, overrides), { startedAt: started }).then((outcome) => {
    settledAt = Date.now();
    return outcome;
  });
  for (let step = 0; step < 400 && settledAt === undefined; step++) {
    await vi.advanceTimersByTimeAsync(100);
  }
  const outcome = await pending;
  return { outcome, elapsed: (settledAt ?? Number.POSITIVE_INFINITY) - started };
}

const EXPECTED: Record<FixtureScenario, { source: string; reason?: string; attempts: number }> = {
  valid: { source: "ai", attempts: 1 },
  "unknown-id-then-valid": { source: "ai_repaired", attempts: 2 },
  "closed-day-then-valid": { source: "ai_repaired", attempts: 2 },
  "always-invalid": { source: "deterministic", reason: "invalid_after_repair", attempts: 2 },
  "schema-invalid": { source: "ai_repaired", attempts: 2 },
  truncated: { source: "deterministic", reason: "max_tokens", attempts: 1 },
  refusal: { source: "deterministic", reason: "refusal", attempts: 1 },
  "rate-limited": { source: "deterministic", reason: "rate_limited", attempts: 1 },
  // Brief failures get one retry, so two calls are made before the fallback.
  overloaded: { source: "deterministic", reason: "rate_limited", attempts: 2 },
  "server-error": { source: "deterministic", reason: "llm_error", attempts: 2 },
  "connection-error": { source: "deterministic", reason: "llm_error", attempts: 2 },
  "connection-reset-then-valid": { source: "ai", attempts: 2 },
  "slow-first-call": { source: "deterministic", reason: "timeout", attempts: 1 },
  "slow-repair": { source: "deterministic", reason: "timeout", attempts: 2 },
  "non-sdk-throw": { source: "deterministic", reason: "llm_error", attempts: 1 },
  "injection-echo": { source: "ai_repaired", attempts: 2 },
};

describe("planTrip with every fixture scenario", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 8, 23, 12) }));
  afterEach(() => vi.useRealTimers());

  for (const scenario of FIXTURE_SCENARIOS) {
    const want = EXPECTED[scenario];
    it(`"${scenario}" ends in a valid ${want.source} plan inside the deadline`, async () => {
      const client = new FixtureClient(ctx, scenario);

      const { outcome, elapsed } = await run(client);

      const itinerary = expectValidItinerary(outcome.itinerary);
      expect(itinerary.source).toBe(want.source);
      expect(itinerary.meta.fallbackReason).toBe(want.reason);
      expect(itinerary.meta.attempts).toBe(want.attempts);
      expect(itinerary.meta.model).toBe(`fixture:${scenario}`);
      expect(itinerary.meta.promptVersion).toBe("v1");
      expect(elapsed).toBeLessThan(DEADLINE);
      expect(itinerary.meta.latencyMs).toBeLessThan(DEADLINE);
    });
  }

  it("never waits past the per-call timeout for a model that ignores its abort signal", async () => {
    const client = new ScriptedClient(() => new Promise(() => {}));

    const { outcome, elapsed } = await run(client);

    expect(outcome.itinerary.meta.fallbackReason).toBe("timeout");
    expect(elapsed).toBeLessThanOrEqual(TIMEOUT + 10);
  });

  it("skips the repair when too little time is left, instead of blowing the deadline", async () => {
    const slowInvalid = new ScriptedClient(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 19_000));
      const selection = validSelection(input.request, input.user, ctx);
      selection.days[0]?.placeIds.unshift("place_999");
      return textResult({ selection });
    });

    const { outcome, elapsed } = await run(slowInvalid, {
      config: { timeoutMs: 20_000, deadlineMs: DEADLINE, maxAttempts: 2 },
    });

    expect(slowInvalid.inputs).toHaveLength(1);
    expect(outcome.itinerary.meta.fallbackReason).toBe("timeout");
    expect(elapsed).toBeLessThan(DEADLINE);
  });

  it("still calls the model when LLM_TIMEOUT_MS is shorter than the default minimum", async () => {
    const client = new FixtureClient(ctx, "valid");

    const { outcome } = await run(client, {
      config: { timeoutMs: 1_000, deadlineMs: 5_000, maxAttempts: 2 },
    });

    expect(client.calls).toBe(1);
    expect(outcome.itinerary.source).toBe("ai");
  });

  it("reports schema_invalid when an off-schema answer cannot be repaired", async () => {
    const client = new FixtureClient(ctx, "schema-invalid");

    const { outcome } = await run(client, {
      config: { timeoutMs: TIMEOUT, deadlineMs: DEADLINE, maxAttempts: 1 },
    });

    expect(outcome.itinerary.meta.fallbackReason).toBe("schema_invalid");
  });

  it("sends the exact violations to the repair turn", async () => {
    const client = new ScriptedClient(async (input, call) => {
      const selection = validSelection(input.request, input.user, ctx);
      if (call === 1) selection.days[0]?.placeIds.unshift("place_999");
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { outcome } = await run(client);

    const repair = client.inputs[1];
    expect(repair && "repairMessage" in repair ? repair.repairMessage : "").toContain(
      "UNKNOWN_PLACE, day 1, place_999",
    );
    expect(outcome.itinerary.source).toBe("ai_repaired");
    expect(outcome.trace.violationCodes).toContain("UNKNOWN_PLACE");
  });

  it("rejects a real place the model was not offered", async () => {
    const client = new ScriptedClient(async (input) => {
      const selection = validSelection(input.request, input.user, ctx);
      selection.days[0]?.placeIds.unshift("place_025"); // rated 2.1, never shortlisted
      return textResult({ selection });
    });

    const { outcome } = await run(client);

    expect(outcome.trace.violationCodes).toContain("UNKNOWN_PLACE");
    expect(outcome.itinerary.source).toBe("deterministic");
  });

  it("uses the rules-only planner when asked, without calling the model", async () => {
    const client = new FixtureClient(ctx, "valid");

    const outcome = await planTrip(request(), deps(client), { mode: "deterministic" });

    expect(client.calls).toBe(0);
    expect(outcome.itinerary.meta.fallbackReason).toBe("requested");
    expectValidItinerary(outcome.itinerary);
  });

  it("labels plans made with no client by the configured reason", async () => {
    const noKey = await planTrip(request(), deps(null, { offReason: "no_key" }));
    const disabled = await planTrip(request(), deps(null, { offReason: "disabled" }));

    expect(noKey.itinerary.meta.fallbackReason).toBe("no_key");
    expect(disabled.itinerary.meta.fallbackReason).toBe("disabled");
    expect(noKey.itinerary.meta.attempts).toBe(0);
    expect(noKey.itinerary.meta.model).toBeUndefined();
  });

  it("turns a crash anywhere on the AI path into the rules-only plan, never an exception", async () => {
    const client = new ScriptedClient(async () =>
      textResult({ selection: { days: null } as never }),
    );

    const { outcome } = await run(client);

    expect(outcome.itinerary.meta.fallbackReason).toBe("llm_error");
    expectValidItinerary(outcome.itinerary);
  });

  it("sums token usage across the first call and the repair", async () => {
    const { outcome } = await run(new FixtureClient(ctx, "unknown-id-then-valid"));

    expect(outcome.trace.usage.inputTokens).toBeGreaterThan(0);
    expect(outcome.trace.stopReasons).toEqual(["end_turn", "end_turn"]);
  });

  it("keeps clean AI reasons and replaces the rest with rule reasons", async () => {
    const { outcome } = await run(new FixtureClient(ctx, "injection-echo"));

    const stops = outcome.itinerary.days.flatMap((day) => day.stops);
    expect(stops.some((stop) => stop.reasonSource === "ai")).toBe(true);
    expect(stops.some((stop) => stop.reasonSource === "rule")).toBe(true);
    expect(outcome.trace.reasonRejections).toEqual(
      expect.arrayContaining(["names_other_place", "time_or_price", "markup_or_injection"]),
    );
  });

  it("maps each thrown LlmError kind to its fallback reason, retrying only brief failures", async () => {
    const kinds = [
      ["auth", "llm_error", 1],
      ["bad_request", "llm_error", 1],
      ["timeout", "timeout", 1],
      ["rate_limited", "rate_limited", 1],
      ["overloaded", "rate_limited", 2],
    ] as const;
    for (const [kind, reason, calls] of kinds) {
      const client = new ScriptedClient(async () => {
        throw new LlmError(kind, "x");
      });
      const { outcome } = await run(client);
      expect(outcome.itinerary.meta.fallbackReason).toBe(reason);
      expect(outcome.trace.llmErrors).toEqual(Array(calls).fill(kind));
    }
  });
});
