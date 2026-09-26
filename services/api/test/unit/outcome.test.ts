import {
  type DaySelection,
  type Itinerary,
  planDeterministic,
  planRoute,
  scheduleTrip,
  TripRequestSchema,
  validationErrors,
  withReplannedDays,
} from "@italy/planner";
import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "../../src/contract";
import { buildAppData, shippedData } from "../../src/data";
import { createLlmProvider } from "../../src/llm/provider";
import { buildShortlist } from "../../src/plan/candidates";
import { materializeSelection } from "../../src/plan/materialize";
import { finishPlan, newTrace, passesGuard } from "../../src/plan/outcome";
import { makeApp, postPlan, START_DATE, testConfig, tripBody } from "../helpers/app";
import { ScriptedClient, textResult } from "../helpers/fakeClients";
import { expectValidItinerary } from "../helpers/validPlan";

// The last line of defense: a plan with a validator error is never returned (F1 at the API), and
// the planner's own "no feasible plan" becomes a clear 422, not a 500.

const { ctx } = shippedData();
const request = TripRequestSchema.parse({ startDate: START_DATE, pace: "balanced" });

describe("final guard", () => {
  it("rejects an itinerary with a validator error", () => {
    const broken: Itinerary = {
      request,
      days: [],
      source: "ai",
      warnings: [],
      meta: { attempts: 1, latencyMs: 0, generatedAt: "2026-09-23T12:00:00.000Z" },
    };

    expect(passesGuard(broken, ctx)).toBe(false);
  });

  it("replaces an AI plan that fails the guard with the rules-only plan, and flags the bug", () => {
    const trace = newTrace();
    const broken: Itinerary = {
      request,
      days: [],
      source: "ai",
      warnings: [],
      meta: { attempts: 1, latencyMs: 0, generatedAt: "2026-09-23T12:00:00.000Z" },
    };
    const made = {
      itinerary: broken,
      errors: [],
      reasonStats: { kept: 0, replaced: 0, rejections: [] },
    };

    const outcome = finishPlan(made, "ai", request, { ctx, now: () => 0 }, 0, trace);

    expect(trace.guardFailed).toBe(true);
    expect(outcome.itinerary.source).toBe("deterministic");
    expect(outcome.itinerary.meta.fallbackReason).toBe("llm_error");
    expectValidItinerary(outcome.itinerary);
  });
});

describe("a whole trip keeps to two bases", () => {
  // Rome, Florence, Venice as a route set by hand: valid for the validator, which allows a base a
  // day, and still refused as a whole-trip answer, whose prompt allows two (decision 16).
  const rome = planDeterministic(
    TripRequestSchema.parse({ startDate: START_DATE, pace: "balanced", anchors: ["rome"] }),
    ctx,
  );
  const days = rome.days.map((day) => ({
    anchorId: day.anchorId,
    placeIds: day.stops.map((stop) => stop.placeId),
  }));
  const plan = planRoute(rome.request, days, ["rome", "florence", "venice"], ctx);
  const planned = plan.rulesDays as DaySelection[];
  const timed = scheduleTrip(rome.request, planned, ctx).days;
  const three = withReplannedDays(
    rome,
    timed.map((dayPlan, day) => ({ day, dayPlan })),
    ctx,
  );

  it("fails the final guard with three bases the validator passes", () => {
    expect(validationErrors(three, ctx)).toEqual([]);
    expect(passesGuard(three, ctx)).toBe(false);
  });

  it("reports a model's three bases as TOO_MANY_ANCHORS", () => {
    const request = TripRequestSchema.parse({ startDate: START_DATE, pace: "balanced" });
    const selection = {
      days: planned.map((day) => ({
        anchorId: day.anchorId,
        placeIds: [...day.placeIds],
        reasons: [],
      })),
      summary: "",
    };
    const made = materializeSelection(
      selection,
      request,
      buildShortlist(request, ctx),
      ctx,
      three.meta,
    );

    expect(made.errors.map((error) => error.code)).toContain("TOO_MANY_ANCHORS");
  });
});

/** Six places in one city: one base that cannot fill three days once most are excluded. */
function tinyData() {
  const raw = Array.from({ length: 6 }, (_, i) => ({
    id: `tiny_${i}`,
    name: `Tiny Place ${i}`,
    type: "museum",
    city: "Rome",
    region: "Lazio",
    neighborhood: "Centro",
    description: "",
    latitude: 41.9 + i * 0.001,
    longitude: 12.49,
    hours: "9:00-18:00",
    duration_minutes: 60,
    price_range: "€",
    rating: 4.5,
    tags: ["art"],
    seasonal_notes: null,
    booking_required: false,
  }));
  return buildAppData(raw);
}

describe("route errors from the planner", () => {
  it("answers 422 no_feasible_plan when no base can fill every day", async () => {
    const data = tinyData();
    const { app } = makeApp({ data, env: { LLM_MODE: "off" } });
    const exclude = ["tiny_0", "tiny_1", "tiny_2", "tiny_3", "tiny_4"];

    const res = await postPlan(app, tripBody({ interests: [], exclude }));

    expect(res.status).toBe(422);
    expect(ErrorResponseSchema.parse(await res.json()).error.code).toBe("no_feasible_plan");
  });

  it("answers 422 on the AI path too, after the model fails", async () => {
    const data = tinyData();
    const client = new ScriptedClient(async () =>
      textResult({ rawText: "nope", schemaIssues: ["x"] }),
    );
    const { app } = makeApp({ data, client });
    const exclude = ["tiny_0", "tiny_1", "tiny_2", "tiny_3", "tiny_4"];

    const res = await postPlan(app, tripBody({ interests: [], exclude }));

    expect(res.status).toBe(422);
  });
});

describe("model provider", () => {
  it("builds the real client once per key and reuses it", async () => {
    const config = testConfig({ LLM_MODE: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test-FAKE-key" });
    const created: string[] = [];
    const provider = createLlmProvider({
      config,
      ctx,
      apiKey: { get: async () => "sk-ant-test-FAKE-key" },
      createClient: (key) => {
        created.push(key);
        return new ScriptedClient(async () => textResult());
      },
    });

    const first = await provider.session(undefined);
    const second = await provider.session(undefined);

    expect(created).toHaveLength(1);
    expect(first.ok && second.ok && first.session.client === second.session.client).toBe(true);
    expect(await provider.status()).toEqual({ available: true, model: "claude-sonnet-5" });
  });

  it("plans without AI when the key source has nothing", async () => {
    const config = testConfig({ LLM_MODE: "anthropic", ANTHROPIC_API_KEY: "k" });
    const provider = createLlmProvider({ config, ctx, apiKey: { get: async () => null } });

    const result = await provider.session(undefined);

    expect(result).toEqual({ ok: true, session: { client: null, offReason: "no_key" } });
  });

  it("builds a real Anthropic client from a key without calling the network", async () => {
    const config = testConfig({ LLM_MODE: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test-FAKE" });
    const provider = createLlmProvider({
      config,
      ctx,
      apiKey: { get: async () => "sk-ant-test-FAKE" },
    });

    const result = await provider.session(undefined);

    expect(result.ok && result.session.client?.model).toBe("claude-sonnet-5");
  });

  it("serves the default scenario when no fixture header is sent", async () => {
    const config = testConfig({ LLM_MODE: "fixture" });
    const provider = createLlmProvider({ config, ctx, apiKey: { get: async () => null } });

    const result = await provider.session(undefined);

    expect(result.ok && result.session.client?.model).toBe("fixture:valid");
  });
});
