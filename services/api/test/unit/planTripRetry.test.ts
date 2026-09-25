import { type TripRequest, TripRequestSchema } from "@italy/planner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shippedData } from "../../src/data";
import { LlmError } from "../../src/llm/errors";
import { FixtureClient } from "../../src/llm/fixture";
import { validSelection } from "../../src/llm/fixtureAnswers";
import { buildShortlist } from "../../src/plan/candidates";
import { type PlanDeps, planTrip } from "../../src/plan/planTrip";
import { START_DATE } from "../helpers/app";
import { ScriptedClient, textResult } from "../helpers/fakeClients";
import { expectValidItinerary } from "../helpers/validPlan";

// Failure vector F2, the edges added after review: brief failures get exactly one retry inside
// the deadline, a long retry-after falls back at once, every failed call leaves its API details
// in the trace, and a request whose own bases cannot fill the trip still gets an AI plan.

const { ctx } = shippedData();
const DEADLINE = 24_000;

function request(overrides: Record<string, unknown> = {}): TripRequest {
  return TripRequestSchema.parse({ startDate: START_DATE, pace: "balanced", ...overrides });
}

function deps(llm: PlanDeps["llm"], overrides: Partial<PlanDeps> = {}): PlanDeps {
  return {
    llm,
    ctx,
    now: () => Date.now(),
    config: { timeoutMs: 15_000, deadlineMs: DEADLINE, maxAttempts: 2 },
    ...overrides,
  };
}

async function run(llm: PlanDeps["llm"], overrides: Partial<PlanDeps> = {}, req = request()) {
  const started = Date.now();
  let settledAt: number | undefined;
  const pending = planTrip(req, deps(llm, overrides), { startedAt: started }).then((outcome) => {
    settledAt = Date.now();
    return outcome;
  });
  for (let step = 0; step < 600 && settledAt === undefined; step++) {
    await vi.advanceTimersByTimeAsync(50);
  }
  const outcome = await pending;
  return { outcome, elapsed: (settledAt ?? Number.POSITIVE_INFINITY) - started };
}

/** Fails the first `failures` calls with `error`, then answers validly. */
function failingThenValid(error: () => LlmError, failures = 1) {
  return new ScriptedClient(async (input, call) => {
    if (call <= failures) throw error();
    return textResult({ selection: validSelection(input.request, input.user, ctx) });
  });
}

describe("retrying a brief model failure", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 8, 23, 12) }));
  afterEach(() => vi.useRealTimers());

  it("recovers from one dropped connection with a single retry, so a stale socket is not a fallback", async () => {
    const client = failingThenValid(() => new LlmError("connection", "reset"));

    const { outcome } = await run(client);

    expect(outcome.itinerary.source).toBe("ai");
    expect(outcome.itinerary.meta.attempts).toBe(2);
    expect(client.inputs).toHaveLength(2);
  });

  it("retries at most once per plan, so a failing API cannot multiply calls", async () => {
    const client = failingThenValid(() => new LlmError("server_error", "500", { status: 500 }), 9);

    const { outcome } = await run(client);

    expect(client.inputs).toHaveLength(2);
    expect(outcome.itinerary.meta.fallbackReason).toBe("llm_error");
  });

  it("falls back at once with rate_limited when a 429 asks for a long wait, instead of waiting it out", async () => {
    const client = failingThenValid(
      () => new LlmError("rate_limited", "429", { status: 429, retryAfterMs: 20_000 }),
    );

    const { outcome, elapsed } = await run(client);

    expect(client.inputs).toHaveLength(1);
    expect(outcome.itinerary.meta.fallbackReason).toBe("rate_limited");
    expect(elapsed).toBeLessThan(1_000);
  });

  it("waits a short retry-after the API asked for, then succeeds", async () => {
    const client = failingThenValid(
      () => new LlmError("overloaded", "529", { status: 529, retryAfterMs: 800 }),
    );

    const { outcome, elapsed } = await run(client);

    expect(outcome.itinerary.source).toBe("ai");
    expect(elapsed).toBeGreaterThanOrEqual(800);
  });

  it("skips the retry when the pause would leave too little time for the call", async () => {
    const client = new ScriptedClient(async (_input, call) => {
      if (call === 1) {
        await new Promise((resolve) => setTimeout(resolve, 21_000));
        throw new LlmError("connection", "reset");
      }
      throw new Error("a second call must not be made");
    });

    const { outcome, elapsed } = await run(client, {
      config: { timeoutMs: 22_000, deadlineMs: DEADLINE, maxAttempts: 2 },
    });

    expect(client.inputs).toHaveLength(1);
    expect(outcome.itinerary.meta.fallbackReason).toBe("llm_error");
    expect(elapsed).toBeLessThan(DEADLINE);
  });

  it("keeps the API's status, error type, request id, and message for every failed call", async () => {
    const client = failingThenValid(
      () =>
        new LlmError("bad_request", "Model API rejected the request", {
          status: 400,
          detail: {
            type: "invalid_request_error",
            apiRequestId: "req_test_1",
            apiMessage: "output_config.effort: Extra inputs are not permitted",
          },
        }),
    );

    const { outcome } = await run(client);

    expect(outcome.trace.llmFailures).toEqual([
      expect.objectContaining({
        kind: "bad_request",
        status: 400,
        type: "invalid_request_error",
        apiRequestId: "req_test_1",
        apiMessage: "output_config.effort: Extra inputs are not permitted",
      }),
    ]);
  });
});

describe("bases the traveler chose cannot fill the trip", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 8, 23, 12) }));
  afterEach(() => vi.useRealTimers());

  const bologna = ctx.anchorById.get("bologna")?.placeIds ?? [];
  const narrow = () =>
    request({ anchors: ["bologna"], exclude: bologna.slice(0, 10), maxPriceLevel: 1 });

  it("offers the model the base the rules-only planner borrows, so the model can succeed", async () => {
    const client = new FixtureClient(ctx, "valid");

    const { outcome } = await run(client, {}, narrow());

    const itinerary = expectValidItinerary(outcome.itinerary);
    expect(itinerary.source).toBe("ai");
    expect(client.calls).toBe(1);
  });

  it("offers no extra base when the traveler's bases are enough", () => {
    const chosen = request({ anchors: ["rome"] });

    const shortlist = buildShortlist(chosen, ctx, ["rome"]);

    expect([...shortlist.anchorIds]).toEqual(["rome"]);
  });
});
