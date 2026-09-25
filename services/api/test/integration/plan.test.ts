import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "../../src/contract";
import { shippedData } from "../../src/data";
import { FixtureClient } from "../../src/llm/fixture";
import { lastRequestLog, makeApp, postPlan, tripBody } from "../helpers/app";
import { expectValidItinerary, placeIdsOf } from "../helpers/validPlan";

// POST /api/plan end to end through app.request, with fixture model clients (plan 8.10
// scenarios 2 to 11 and 13; scenario 14 is expectValidItinerary on every response here).

const { ctx } = shippedData();

async function plan(scenario?: string, body = tripBody(), query?: string) {
  const { app, logs } = makeApp();
  const res = await postPlan(app, body, { scenario, query });
  return { res, body: await res.json(), logs };
}

describe("POST /api/plan", () => {
  it("returns an AI plan with AI reasons when the first answer is valid", async () => {
    const { res, body, logs } = await plan("valid");

    expect(res.status).toBe(200);
    const itinerary = expectValidItinerary(body);
    expect(itinerary.source).toBe("ai");
    expect(itinerary.meta.attempts).toBe(1);
    const stops = itinerary.days.flatMap((d) => d.stops);
    expect(stops.every((s) => s.reasonSource === "ai")).toBe(true);
    expect(itinerary.summary).toBeDefined();
    expect(lastRequestLog(logs)).toMatchObject({ source: "ai", attempts: 1, promptVersion: "v1" });
  });

  it("repairs an unknown id and labels the plan ai_repaired", async () => {
    const { body } = await plan("unknown-id-then-valid");

    const itinerary = expectValidItinerary(body);
    expect(itinerary.source).toBe("ai_repaired");
    expect(itinerary.meta.attempts).toBe(2);
    expect(placeIdsOf(itinerary)).not.toContain("place_999");
  });

  it("tidies away a place picked on its closed day, with no repair turn, and logs it", async () => {
    const { body, logs } = await plan("closed-day-tidied");

    const itinerary = expectValidItinerary(body);
    expect(itinerary.source).toBe("ai_repaired");
    expect(itinerary.meta.attempts).toBe(1);
    const log = lastRequestLog(logs);
    expect(log.violationCodes).toEqual([]);
    expect(log.tidied).toEqual([expect.objectContaining({ rule: "closed", day: 0, answer: 1 })]);
  });

  it("falls back to the rules-only plan when the repair is also invalid", async () => {
    const { body } = await plan("always-invalid");

    const itinerary = expectValidItinerary(body);
    expect(itinerary.source).toBe("deterministic");
    expect(itinerary.meta.fallbackReason).toBe("invalid_after_repair");
  });

  it("recovers from an off-schema answer without a 500", async () => {
    const { res, body } = await plan("schema-invalid");

    expect(res.status).toBe(200);
    expect(expectValidItinerary(body).source).toBe("ai_repaired");
  });

  it("falls back with timeout when the model is too slow, inside the deadline", async () => {
    const { app } = makeApp({
      env: { LLM_TIMEOUT_MS: "300", PLAN_DEADLINE_MS: "2000" },
      timing: {
        reserveMs: 200,
        minCallMs: 100,
        minRepairMs: 100,
        retry: { defaultPauseMs: 10, maxPauseMs: 50 },
      },
    });
    const started = Date.now();

    const res = await postPlan(app, tripBody(), { scenario: "slow-first-call" });

    const itinerary = expectValidItinerary(await res.json());
    expect(itinerary.meta.fallbackReason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("says no_key when no key is configured", async () => {
    const { app } = makeApp({ env: { LLM_MODE: "anthropic" } });

    const itinerary = expectValidItinerary(await (await postPlan(app, tripBody())).json());

    expect(itinerary.source).toBe("deterministic");
    expect(itinerary.meta.fallbackReason).toBe("no_key");
  });

  it("says disabled when the kill switch is off", async () => {
    const { app } = makeApp({ env: { LLM_ENABLED: "false" } });

    const itinerary = expectValidItinerary(await (await postPlan(app, tripBody())).json());

    expect(itinerary.meta.fallbackReason).toBe("disabled");
  });

  it("uses the rules-only planner for ?mode=deterministic even with a client", async () => {
    const client = new FixtureClient(ctx, "valid");
    const { app } = makeApp({ client });

    const res = await postPlan(app, tripBody(), { query: "mode=deterministic" });

    const itinerary = expectValidItinerary(await res.json());
    expect(itinerary.source).toBe("deterministic");
    expect(itinerary.meta.fallbackReason).toBe("requested");
    expect(client.calls).toBe(0);
  });

  it("rejects an unknown mode instead of guessing", async () => {
    const { res, body } = await plan("valid", tripBody(), "mode=ai-only");

    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(body).error.details?.[0]?.path).toBe("mode");
  });

  it("rejects an unknown fixture scenario, so a typo cannot pass as a valid plan", async () => {
    const { res, body } = await plan("vaild");

    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(body).error.code).toBe("unknown_fixture_scenario");
  });

  for (const scenario of [
    "truncated",
    "refusal",
    "rate-limited",
    "overloaded",
    "server-error",
    "connection-error",
    "non-sdk-throw",
  ]) {
    it(`answers 200 with a valid rules-only plan when the model fails: ${scenario}`, async () => {
      const { res, body } = await plan(scenario);

      expect(res.status).toBe(200);
      expect(expectValidItinerary(body).source).toBe("deterministic");
    });
  }

  it("calls the model once for the same request twice, and serves the cached copy", async () => {
    const client = new FixtureClient(ctx, "valid");
    const { app, logs } = makeApp({ client });

    const first = await (await postPlan(app, tripBody())).json();
    const second = await (
      await postPlan(app, tripBody({ interests: ["historic", "food"] }))
    ).json();

    expect(client.calls).toBe(1);
    expect(second).toEqual(first);
    expect(lastRequestLog(logs).cache).toBe("hit");
  });

  it("does not share cache entries between different requests", async () => {
    const client = new FixtureClient(ctx, "valid");
    const { app } = makeApp({ client });

    await postPlan(app, tripBody());
    await postPlan(app, tripBody({ pace: "packed" }));

    expect(client.calls).toBe(2);
  });

  it("never caches a fallback plan, so a passing outage is retried next time", async () => {
    const client = new FixtureClient(ctx, "rate-limited");
    const { app, cache } = makeApp({ client });

    await postPlan(app, tripBody());
    await postPlan(app, tripBody());

    expect(client.calls).toBe(2);
    expect(cache.size).toBe(0);
  });

  it("places every must-include the traveler asked for when it can be visited", async () => {
    const mustInclude = ["place_001"];
    const { body } = await plan("valid", tripBody({ mustInclude, anchors: ["rome"] }));

    const itinerary = expectValidItinerary(body);
    expect(placeIdsOf(itinerary)).toContain("place_001");
  });

  it("never schedules an excluded place", async () => {
    const exclude = ctx.anchorById.get("rome")?.placeIds.slice(0, 10) ?? [];
    const { body } = await plan("valid", tripBody({ exclude, anchors: ["rome"] }));

    const ids = placeIdsOf(expectValidItinerary(body));
    for (const id of exclude) expect(ids).not.toContain(id);
  });
});
