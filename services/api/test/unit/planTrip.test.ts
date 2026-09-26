import { type TripRequest, TripRequestSchema } from "@italy/planner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config";
import { shippedData } from "../../src/data";
import { LlmError } from "../../src/llm/errors";
import { FIXTURE_SCENARIOS, FixtureClient, type FixtureScenario } from "../../src/llm/fixture";
import { validSelection } from "../../src/llm/fixtureAnswers";
import { PROMPT_VERSION } from "../../src/llm/prompt";
import { DEFAULT_TIMING, type PlanDeps, planTrip } from "../../src/plan/planTrip";
import { START_DATE } from "../helpers/app";
import { delay, ScriptedClient, textResult } from "../helpers/fakeClients";
import { expectValidItinerary } from "../helpers/validPlan";

// Failure vector F2: the AI path must end in a valid plan with the right label, inside the
// deadline, whatever the model does. Fake timers make the slow scenarios instant and exact.

const { ctx } = shippedData();
// The production defaults (config.ts, infra/sam/template.yaml): 24 s a plan, 15 s a call.
const DEFAULTS = loadConfig({});
const DEADLINE = DEFAULTS.planDeadlineMs;
const TIMEOUT = DEFAULTS.llmTimeoutMs;

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
  // Tidied before the check, so no repair turn; a changed answer is never labelled "ai".
  "closed-day-tidied": { source: "ai_repaired", attempts: 1 },
  "repeat-tidied": { source: "ai_repaired", attempts: 1 },
  "messy-tidied": { source: "ai_repaired", attempts: 1 },
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
      expect(itinerary.meta.promptVersion).toBe(PROMPT_VERSION);
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

  it("gives the first call 15 s, so an answer at 14 s becomes the plan instead of a fallback", async () => {
    const slow = new ScriptedClient(async (input) => {
      await delay(14_000);
      return textResult({ selection: validSelection(input.request, input.user, ctx) });
    });

    const { outcome, elapsed } = await run(slow);

    expect(TIMEOUT).toBe(15_000);
    expect(slow.inputs[0]?.timeoutMs).toBe(15_000);
    expect(outcome.itinerary.source).toBe("ai");
    expect(elapsed).toBeGreaterThanOrEqual(14_000);
  });

  it("still repairs an answer that took almost the whole first call, in what is left of the deadline", async () => {
    // 24 s - 14.9 s - the 1.5 s reserve leaves 7.6 s for the repair, over its 4 s minimum; live
    // repairs that answered took 2.6 to 8.0 s.
    const client = new ScriptedClient(async (input, call) => {
      const selection = validSelection(input.request, input.user, ctx);
      if (call === 1) {
        await delay(14_900);
        selection.days[0]?.placeIds.unshift("place_999");
      } else {
        await delay(7_000);
      }
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { outcome, elapsed } = await run(client);

    expect(client.inputs.map((input) => input.timeoutMs)).toEqual([
      15_000,
      DEADLINE - 14_900 - DEFAULT_TIMING.reserveMs,
    ]);
    expect(outcome.itinerary.source).toBe("ai_repaired");
    expect(elapsed).toBeLessThan(DEADLINE - DEFAULT_TIMING.reserveMs);
  });

  it("cuts a repair after a slow first answer at what is left of the deadline, then falls back in time", async () => {
    const client = new ScriptedClient(async (input, call) => {
      if (call > 1) return new Promise(() => {});
      await delay(14_900);
      const selection = validSelection(input.request, input.user, ctx);
      selection.days[0]?.placeIds.unshift("place_999");
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { outcome, elapsed } = await run(client);

    expect(client.inputs).toHaveLength(2);
    expect(outcome.itinerary.meta.fallbackReason).toBe("timeout");
    expect(elapsed).toBeLessThanOrEqual(DEADLINE - DEFAULT_TIMING.reserveMs + 100);
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

  it("labels an answer that passes exactly as written ai, with nothing tidied", async () => {
    const { outcome } = await run(new FixtureClient(ctx, "valid"));

    expect(outcome.itinerary.source).toBe("ai");
    expect(outcome.trace.tidied).toEqual([]);
  });

  it("tidies a messy answer into a valid plan without a repair turn, and says so", async () => {
    const client = new FixtureClient(ctx, "messy-tidied");

    // With these interests the prompt offers a place that is closed on day 1, so the messy
    // answer breaks three rules at once: an order that cannot be timed, a repeat, and a closure.
    const { outcome } = await run(client, {}, request({ interests: ["historic", "food"] }));

    const itinerary = expectValidItinerary(outcome.itinerary);
    expect(client.calls).toBe(1);
    expect(itinerary.source).toBe("ai_repaired");
    expect(itinerary.meta.attempts).toBe(1);
    expect(outcome.trace.violationCodes).toEqual([]);
    const rules = new Set(outcome.trace.tidied.map((change) => change.rule));
    expect([...rules]).toEqual(expect.arrayContaining(["closed", "duplicate", "reordered"]));
    expect(outcome.trace.tidied.every((change) => change.answer === 1)).toBe(true);
  });

  it("drops what a day's hours cannot hold before the check, without a repair turn", async () => {
    // Monday to Wednesday in Rome. The second day holds the Colosseum, lunch at Da Enzo, the
    // Forum, the Borghese Gallery, and four hours in the Vatican Museums: more than its opening
    // hours allow, which the model cannot see because code assigns the times.
    const vatican = "place_010";
    const overHours = ["place_001", "place_003", "place_004", "place_007", vatican];
    const client = new ScriptedClient(async (input) => {
      const selection = validSelection(input.request, input.user, ctx);
      const day = (placeIds: string[]) => ({ anchorId: "rome", placeIds, reasons: [] });
      selection.days = [day(["place_019"]), day(overHours), day(["place_002"])];
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { outcome } = await run(client, {}, request({ anchors: ["rome"] }));

    const itinerary = expectValidItinerary(outcome.itinerary);
    expect(client.inputs).toHaveLength(1);
    expect(itinerary.source).toBe("ai_repaired");
    expect(itinerary.meta.attempts).toBe(1);
    expect(outcome.trace.violationCodes).toEqual([]);
    // Day 0, with the Spanish Steps alone, holds the museums, so they move there, and the record
    // keeps the rule that took them off day 1. The meals the days lack are added after the check.
    const added = outcome.trace.tidied.filter((change) => change.rule === "meal_added");
    expect(outcome.trace.tidied.filter((change) => change.rule !== "meal_added")).toEqual([
      { rule: "moved_day", day: 1, placeId: vatican, toDay: 0, cause: "does_not_fit", answer: 1 },
    ]);
    const chosen = (day: number) =>
      itinerary.days[day]?.stops
        .map((stop) => stop.placeId)
        .filter((id) => !added.some((change) => change.placeId === id));
    expect(chosen(1)).toEqual(overHours.slice(0, -1));
    expect(chosen(0)).toEqual(["place_019", vatican]);
  });

  it("never shows a restaurant over the budget as a visit: it moves to a day that lacks the meal", async () => {
    // Rome at the lowest budget, Friday 9 to Sunday 11 October 2026: the reviewer's probe of
    // 2026-09-25. Il Sorpasso is offered one level over the budget, for meals only. The answer
    // puts it between the Trevi Fountain and dinner, where the day times it as a 16:30 visit.
    const sorpasso = "place_020";
    const client = new ScriptedClient(async () => {
      const day = (placeIds: string[]) => ({ anchorId: "rome", placeIds, reasons: [] });
      const selection = {
        days: [
          day(["place_011", "place_003", "place_005", "place_018", sorpasso, "place_042"]),
          day(["place_077", "place_019", "place_002"]),
          day(["place_097", "place_014", "place_006"]),
        ],
        summary: "Three days in Rome.",
      };
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });
    const budget = request({ startDate: "2026-10-09", anchors: ["rome"], maxPriceLevel: 1 });

    const { outcome } = await run(client, {}, budget);

    const itinerary = expectValidItinerary(outcome.itinerary);
    expect(client.inputs).toHaveLength(1);
    expect(itinerary.source).toBe("ai_repaired");
    expect(outcome.trace.tidied).toContainEqual({
      rule: "moved_day",
      day: 0,
      placeId: sorpasso,
      toDay: 1,
      cause: "over_budget_visit",
      answer: 1,
    });
    const lunch = itinerary.days[1]?.stops.find((stop) => stop.placeId === sorpasso);
    expect(lunch?.role).toBe("lunch");
    for (const warning of itinerary.warnings.filter((w) => w.code === "OVER_BUDGET")) {
      const stop = itinerary.days[warning.day ?? -1]?.stops.find(
        (s) => s.placeId === warning.placeId,
      );
      expect(stop?.role).not.toBe("visit");
    }
  });

  // Rome, Friday 9 to Sunday 11 October 2026, balanced: the owner's request that fell back on
  // 2026-09-25 (invalid_after_repair, EMPTY_DAY after both turns). The answers are rebuilt from
  // its log: the first puts day 3 on the Vatican Museums, closed that Sunday, and three places
  // days 1 and 2 already have; the repair does the same and adds the Aventine Keyhole, a fourth.
  const OWNER = request({ startDate: "2026-10-09", anchors: ["rome"] });
  const ownerDay = (ids: number[]) => ({
    anchorId: "rome",
    placeIds: ids.map((n) => `place_${String(n).padStart(3, "0")}`),
    reasons: [],
  });
  const OWNER_DAYS = [
    [7, 5, 11, 3, 18, 19, 2, 20, 9],
    [1, 4, 15, 14, 97, 22, 77],
  ];
  const OWNER_FIRST = [...OWNER_DAYS, [10, 97, 19, 20]].map(ownerDay);
  const OWNER_REPAIR = [...OWNER_DAYS, [10, 97, 19, 20, 14]].map(ownerDay);

  it("turns the owner's failed first answer into a valid AI plan, with no repair turn", async () => {
    const client = new ScriptedClient(async () => {
      const selection = { days: structuredClone(OWNER_FIRST), summary: "Three days in Rome." };
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { outcome } = await run(client, {}, OWNER);

    const itinerary = expectValidItinerary(outcome.itinerary);
    expect(client.inputs).toHaveLength(1);
    expect(itinerary.source).toBe("ai_repaired");
    expect(outcome.trace.violationCodes).toEqual([]);
    expect(itinerary.days.map((day) => day.stops.length > 0)).toEqual([true, true, true]);
    // Day 3 keeps the Spanish Steps, and day 1, which had nine stops, gives them up.
    expect(outcome.trace.tidied).toContainEqual({
      rule: "duplicate",
      day: 0,
      placeId: "place_019",
      answer: 1,
    });
    expect(itinerary.days[2]?.stops.map((stop) => stop.placeId)).toContain("place_019");
  });

  it("turns the owner's failed repair answer into a valid AI plan as well", async () => {
    const client = new ScriptedClient(async (_input, call) => {
      const days = call === 1 ? [ownerDay([999]), ...OWNER_FIRST.slice(1)] : OWNER_REPAIR;
      const selection = { days: structuredClone(days), summary: "Three days in Rome." };
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { outcome } = await run(client, {}, OWNER);

    const itinerary = expectValidItinerary(outcome.itinerary);
    expect(client.inputs).toHaveLength(2);
    expect(itinerary.source).toBe("ai_repaired");
    expect(itinerary.days.map((day) => day.stops.length > 0)).toEqual([true, true, true]);
  });

  it("tells the repair turn what tidying removed, and what is free for a day it could not fill", async () => {
    // Monday 19 to Wednesday 21 October in Rome. Day 3 repeats day 1's only stop, so it cannot
    // keep it, and nothing else was dropped that could move there: the day is empty.
    const monday = request({ anchors: ["rome"] });
    const client = new ScriptedClient(async (input, call) => {
      const selection =
        call === 1
          ? {
              days: [ownerDay([5]), ownerDay([1, 4]), ownerDay([5])],
              summary: "Three days in Rome.",
            }
          : validSelection(input.request, input.user, ctx);
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { outcome } = await run(client, {}, monday);

    const repair = client.inputs[1];
    const message = repair && "repairMessage" in repair ? repair.repairMessage : "";
    expect(message).toContain("- EMPTY_DAY, day 3, -,");
    expect(message).toContain(
      "- day 3, place_005: already on day 1; each id may appear once in the trip",
    );
    const free =
      /- Day 3 \(rome, Wednesday 2026-10-21\) has no stops left\. Candidates at rome open that day and not in the trip: (.+)\./.exec(
        message,
      );
    expect(free?.[1]?.split(", ").length).toBeGreaterThan(10);
    expect(free?.[1]).not.toMatch(/place_00[15]\b/);
    expect(free?.[1]).toMatch(/place_\d+ \(meal\)/);
    // The model's own answer goes back as it wrote it, so the removals explain its day 3.
    expect(repair && "previousText" in repair ? repair.previousText : "").toContain("place_005");
    expect(expectValidItinerary(outcome.itinerary).source).toBe("ai_repaired");
  });

  it("sends only what is still wrong after tidying to the repair turn", async () => {
    const client = new ScriptedClient(async (input, call) => {
      const selection = validSelection(input.request, input.user, ctx);
      const [first, , last] = selection.days;
      if (call === 1 && first && last) {
        last.placeIds.push(first.placeIds[0] ?? ""); // a repeat, which tidying drops
        first.placeIds.unshift("place_999"); // an invented id, which only the model can fix
      }
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { outcome } = await run(client);

    const repair = client.inputs[1];
    const message = repair && "repairMessage" in repair ? repair.repairMessage : "";
    expect(message).toContain("UNKNOWN_PLACE");
    expect(message).not.toContain("DUPLICATE_PLACE");
    expect(outcome.trace.tidied).toEqual([
      expect.objectContaining({ rule: "duplicate", answer: 1 }),
    ]);
    expect(outcome.itinerary.source).toBe("ai_repaired");
    expectValidItinerary(outcome.itinerary);
  });

  it("sends a must-include on its closed day to the repair turn rather than tidying it away", async () => {
    // Sunday 25 October: the Vatican Museums (a must-include) are closed, and the first answer
    // puts them on its only Rome day. Tidied away, that answer would pass without them.
    const vatican = "place_010";
    const sunday = request({
      startDate: "2026-10-25",
      anchors: ["rome", "florence"],
      mustInclude: [vatican],
    });
    const client = new ScriptedClient(async (input, call) => {
      const selection = validSelection(input.request, input.user, ctx);
      if (call === 1) {
        const day = (anchorId: string, placeIds: string[]) => ({ anchorId, placeIds, reasons: [] });
        selection.days = [
          day("rome", [vatican, "place_001", "place_020", "place_005"]),
          day("florence", ["place_029", "place_036", "place_084", "place_027"]),
          day("florence", ["place_032", "place_033", "place_103", "place_093", "place_039"]),
        ];
      }
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { outcome } = await run(client, {}, sunday);

    const repair = client.inputs[1];
    const message = repair && "repairMessage" in repair ? repair.repairMessage : "";
    expect(message).toContain(`CLOSED_AT_TIME, day 1, ${vatican}`);
    expect(outcome.trace.tidied.filter((change) => change.placeId === vatican)).toEqual([]);
    const itinerary = expectValidItinerary(outcome.itinerary);
    expect(itinerary.source).toBe("ai_repaired");
    expect(itinerary.days.flatMap((d) => d.stops.map((s) => s.placeId))).toContain(vatican);
  });

  it("tidies the repaired answer too", async () => {
    const client = new ScriptedClient(async (input, call) => {
      const selection = validSelection(input.request, input.user, ctx);
      const [first, , last] = selection.days;
      if (call === 1) first?.placeIds.unshift("place_999");
      if (call === 2 && first && last) last.placeIds.push(first.placeIds[0] ?? "");
      return textResult({ selection, rawText: JSON.stringify(selection) });
    });

    const { outcome } = await run(client);

    expect(client.inputs).toHaveLength(2);
    expect(outcome.trace.tidied).toEqual([
      expect.objectContaining({ rule: "duplicate", answer: 2 }),
    ]);
    expect(expectValidItinerary(outcome.itinerary).source).toBe("ai_repaired");
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
