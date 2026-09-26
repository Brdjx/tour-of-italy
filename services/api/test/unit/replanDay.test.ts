import { checkDayBase, type DaySelection } from "@italy/planner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanDayResponseSchema } from "../../src/contract";
import { shippedData } from "../../src/data";
import type { LlmClient, LlmDayResult, RepairInput, SelectInput } from "../../src/llm/client";
import { DAY_REPAIR_INSTRUCTION, DAY_SYSTEM_PROMPT } from "../../src/llm/dayPrompt";
import { LlmError } from "../../src/llm/errors";
import { validDayAnswer } from "../../src/llm/fixtureDayAnswers";
import { PlanGuardError } from "../../src/plan/outcome";
import type { PlanDeps } from "../../src/plan/planTrip";
import { replanDay } from "../../src/plan/replanDay";
import { dayInput, plannedTrip } from "../helpers/day";
import { delay } from "../helpers/fakeClients";

// The one-day pipeline with hand-scripted model clients: the deadline, the retry, the repair
// turn and its message, every fallback, and the guards that keep an invalid day from leaving.

const { ctx } = shippedData();
const rome = plannedTrip();
const input = dayInput(rome, 2, "florence");
const witness = checkDayBase(input.request, input.days, 2, "florence", ctx).day as DaySelection;

const TIMEOUT = 15_000;
const DEADLINE = 24_000;

type Script = (input: SelectInput | RepairInput, call: number) => Promise<LlmDayResult>;

/** A client that runs `script` for every day call and records the inputs. */
class ScriptedDayClient implements LlmClient {
  readonly model = "scripted-day";
  readonly inputs: (SelectInput | RepairInput)[] = [];
  constructor(private readonly script: Script) {}
  select(): never {
    throw new Error("A day pipeline never asks for a whole trip");
  }
  repair(): never {
    throw new Error("A day pipeline never asks for a whole trip");
  }
  selectDay(input: SelectInput): Promise<LlmDayResult> {
    this.inputs.push(input);
    return this.script(input, this.inputs.length);
  }
  repairDay(input: RepairInput): Promise<LlmDayResult> {
    this.inputs.push(input);
    return this.script(input, this.inputs.length);
  }
}

function result(overrides: Partial<LlmDayResult> = {}): LlmDayResult {
  return {
    answer: null,
    rawText: "{}",
    schemaIssues: [],
    usage: { inputTokens: 100, outputTokens: 20 },
    latencyMs: 5,
    model: "scripted-day",
    stopReason: "end_turn",
    ...overrides,
  };
}

const valid = (i: SelectInput) => result({ answer: validDayAnswer(i.request, i.user, ctx) });

function deps(llm: LlmClient | null, overrides: Partial<PlanDeps> = {}): PlanDeps {
  return {
    llm,
    ctx,
    now: () => Date.now(),
    config: { timeoutMs: TIMEOUT, deadlineMs: DEADLINE, maxAttempts: 2 },
    ...overrides,
  };
}

async function run(llm: LlmClient | null, overrides: Partial<PlanDeps> = {}) {
  const started = Date.now();
  const promise = replanDay(input, witness, deps(llm, overrides), { startedAt: started });
  await vi.runAllTimersAsync();
  const outcome = await promise;
  expect(PlanDayResponseSchema.safeParse(outcome.result).success).toBe(true);
  return { outcome, elapsed: Date.now() - started };
}

describe("replanDay", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 8, 23, 12) }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks for the day with the day prompt, and returns an AI day", async () => {
    const client = new ScriptedDayClient(async (i) => valid(i));

    const { outcome } = await run(client);

    expect(outcome.result.source).toBe("ai");
    expect(client.inputs[0]?.system).toBe(DAY_SYSTEM_PROMPT);
    expect(outcome.trace).toMatchObject({ attempts: 1, model: "scripted-day" });
    expect(outcome.trace.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it("sends the violations and the day instruction back in the repair turn", async () => {
    const client = new ScriptedDayClient(async (i, call) => {
      const good = valid(i);
      if (call > 1) return good;
      const answer = good.answer as NonNullable<LlmDayResult["answer"]>;
      return result({ answer: { ...answer, placeIds: ["place_999", ...answer.placeIds] } });
    });

    const { outcome } = await run(client);

    expect(outcome.result.source).toBe("ai_repaired");
    const repair = client.inputs[1] as RepairInput;
    expect(repair.repairMessage).toContain("UNKNOWN_PLACE, day 3, place_999");
    expect(repair.repairMessage.endsWith(DAY_REPAIR_INSTRUCTION)).toBe(true);
    expect(repair.previousText).toBe("{}");
  });

  it("repairs an off-schema answer, and falls back schema_invalid when there is no repair", async () => {
    const offSchema = new ScriptedDayClient(async (i, call) =>
      call === 1 ? result({ schemaIssues: ["placeIds: expected array"] }) : valid(i),
    );
    expect((await run(offSchema)).outcome.result.source).toBe("ai_repaired");
    expect((offSchema.inputs[1] as RepairInput).violations[0]).toMatchObject({
      code: "SCHEMA_INVALID",
      detail: "placeIds: expected array",
    });

    const noRepair = new ScriptedDayClient(async () => result());
    const { outcome } = await run(noRepair, {
      config: { timeoutMs: TIMEOUT, deadlineMs: DEADLINE, maxAttempts: 1 },
    });
    expect(outcome.result.meta.fallbackReason).toBe("schema_invalid");
  });

  it("never waits past the per-call timeout for a model that ignores its abort signal", async () => {
    const client = new ScriptedDayClient(() => new Promise(() => {}));

    const { outcome, elapsed } = await run(client);

    expect(outcome.result.source).toBe("deterministic");
    expect(outcome.result.meta.fallbackReason).toBe("timeout");
    expect(elapsed).toBeLessThanOrEqual(TIMEOUT + 10);
  });

  it("skips the repair when too little time is left, and says timeout", async () => {
    const client = new ScriptedDayClient(async (i) => {
      await delay(19_000);
      const good = valid(i).answer as NonNullable<LlmDayResult["answer"]>;
      return result({ answer: { ...good, placeIds: ["place_999"] } });
    });

    const { outcome, elapsed } = await run(client, {
      config: { timeoutMs: 20_000, deadlineMs: DEADLINE, maxAttempts: 2 },
    });

    expect(client.inputs).toHaveLength(1);
    expect(outcome.result.meta.fallbackReason).toBe("timeout");
    expect(elapsed).toBeLessThan(DEADLINE);
  });

  it("retries a dropped connection once, then gives up with the error's reason", async () => {
    const flaky = new ScriptedDayClient(async (i, call) => {
      if (call === 1) throw new LlmError("connection", "Connection reset");
      return valid(i);
    });
    expect((await run(flaky)).outcome.result.source).toBe("ai");
    expect(flaky.inputs).toHaveLength(2);

    const down = new ScriptedDayClient(async () => {
      throw new LlmError("auth", "Model API rejected the key", { status: 401 });
    });
    const { outcome } = await run(down);
    expect(outcome.result.meta.fallbackReason).toBe("llm_error");
    expect(outcome.trace.llmErrors).toEqual(["auth"]);
  });

  it("falls back on a refusal or a cut-off answer without a repair", async () => {
    for (const stopReason of ["refusal", "max_tokens"]) {
      const client = new ScriptedDayClient(async () => result({ stopReason }));
      const { outcome } = await run(client);
      expect(outcome.result.meta.fallbackReason).toBe(stopReason);
      expect(client.inputs).toHaveLength(1);
    }
  });

  it("falls back invalid_after_repair when the repair is still wrong", async () => {
    const client = new ScriptedDayClient(async () =>
      result({ answer: { placeIds: ["place_999"], reasons: [] } }),
    );

    const { outcome } = await run(client);

    expect(outcome.result.meta.fallbackReason).toBe("invalid_after_repair");
    expect(outcome.result.dayPlan.stops.map((s) => s.placeId)).toEqual([...witness.placeIds]);
    expect(outcome.trace.violationCodes).toContain("UNKNOWN_PLACE");
  });

  it("ends in the rules-only day for anything unexpected on the AI path", async () => {
    const client = new ScriptedDayClient(async () => {
      throw new TypeError("Cannot read properties of undefined");
    });

    const { outcome } = await run(client);

    expect(outcome.result.meta.fallbackReason).toBe("llm_error");
  });

  it("plans with the rules alone when there is no client, or one that cannot plan a day", async () => {
    const off = await run(null, { offReason: "no_key" });
    expect(off.outcome.result.meta).toMatchObject({ fallbackReason: "no_key", attempts: 0 });

    const tripOnly: LlmClient = {
      model: "trip-only",
      select: async () => {
        throw new Error("not called");
      },
      repair: async () => {
        throw new Error("not called");
      },
    };
    const { outcome } = await run(tripOnly);
    expect(outcome.result.meta.fallbackReason).toBe("disabled");
    expect(outcome.result.meta.model).toBeUndefined();
  });

  it("ends in the rules-only day when the day itself cannot be prepared for the model", async () => {
    const client = new ScriptedDayClient(async (i) => valid(i));
    // A base the shortlist cannot build (the route checks bases first; this is a bug guard).
    const odd = { ...input, anchorId: "atlantis" };
    const promise = replanDay(odd, witness, deps(client), {});
    await vi.runAllTimersAsync();
    const outcome = await promise;

    expect(outcome.result.meta.fallbackReason).toBe("llm_error");
    expect(outcome.trace.llmErrors).toEqual(["unknown"]);
    expect(client.inputs).toHaveLength(0);
  });

  it("lets a guard failure of the rules-only day through, from the AI path too (503)", async () => {
    const bad = { anchorId: "florence", placeIds: [rome.days[0]?.stops[0]?.placeId as string] };
    const client = new ScriptedDayClient(async () => result({ stopReason: "refusal" }));
    const promise = replanDay(input, bad, deps(client), {});
    const settled = promise.catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await settled).toBeInstanceOf(PlanGuardError);
  });

  it("plans with the rules alone for mode deterministic", async () => {
    const client = new ScriptedDayClient(async (i) => valid(i));
    const outcome = await replanDay(input, witness, deps(client), { mode: "deterministic" });

    expect(outcome.result.meta.fallbackReason).toBe("requested");
    expect(client.inputs).toHaveLength(0);
  });

  it("falls back, marking the trace, when a checked AI day fails the response schema", async () => {
    const client = new ScriptedDayClient(async (i) => valid(i));
    const real = PlanDayResponseSchema.safeParse.bind(PlanDayResponseSchema);
    let calls = 0;
    vi.spyOn(PlanDayResponseSchema, "safeParse").mockImplementation((value) => {
      calls++;
      return calls === 1 ? ({ success: false } as ReturnType<typeof real>) : real(value as never);
    });

    const { outcome } = await run(client);

    expect(outcome.trace.guardFailed).toBe(true);
    expect(outcome.result.meta.fallbackReason).toBe("llm_error");
  });

  it("refuses to return a rules-only day that would add an error, or fails the schema (503)", async () => {
    const bad = { anchorId: "florence", placeIds: [rome.days[0]?.stops[0]?.placeId as string] };
    await expect(
      replanDay(input, bad, deps(null), { mode: "deterministic" }),
    ).rejects.toBeInstanceOf(PlanGuardError);

    vi.spyOn(PlanDayResponseSchema, "safeParse").mockReturnValue({
      success: false,
    } as ReturnType<typeof PlanDayResponseSchema.safeParse>);
    await expect(
      replanDay(input, witness, deps(null), { mode: "deterministic" }),
    ).rejects.toBeInstanceOf(PlanGuardError);
  });
});
