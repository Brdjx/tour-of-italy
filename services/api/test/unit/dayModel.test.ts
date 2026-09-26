import type Anthropic from "@anthropic-ai/sdk";
import { checkDayBase, type DaySelection, scheduleTrip, withDay } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PlanDayResponse } from "../../src/contract";
import { shippedData } from "../../src/data";
import { LruCache } from "../../src/lib/cache";
import type { LogFields } from "../../src/lib/logger";
import { createAnthropicClient, type MessagesApi, toDayResult } from "../../src/llm/anthropic";
import type { RepairInput, SelectInput } from "../../src/llm/client";
import { buildDayUserMessage } from "../../src/llm/dayPrompt";
import {
  messyDayAnswer,
  parseDayOffer,
  validDayAnswer,
  withClosedDayPlace,
  withRepeatedDay,
} from "../../src/llm/fixtureDayAnswers";
import {
  DAY_ANSWER_JSON_SCHEMA,
  DayAnswerSchema,
  MAX_STOPS_PER_DAY,
  parseDayAnswerText,
} from "../../src/llm/schema";
import { type CachedDay, cacheDay, dayCacheKey, readCachedDay } from "../../src/plan/dayCache";
import { buildDayShortlist } from "../../src/plan/dayShortlist";
import { cacheKey, createMemoryStore, type TripStore } from "../../src/trips/store";
import { dayInput, plannedTrip } from "../helpers/day";

// The pieces around the model for one day: the answer schema, the Claude API client's day calls,
// the fixture's scripted day answers, and the day cache.

const { ctx } = shippedData();
const rome = plannedTrip();
const input = dayInput(rome, 2, "florence");
const user = buildDayUserMessage(input, buildDayShortlist(input, ctx), ctx);

describe("the day answer schema", () => {
  it("sends the same structure the Zod parser enforces, closed, with no limit keywords", () => {
    const strip = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(strip);
      if (node === null || typeof node !== "object") return node;
      return Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => !["$schema", "description", "minItems", "maxItems"].includes(key))
          .filter(([key]) => !["minLength", "maxLength"].includes(key))
          .map(([key, value]) => [key, strip(value)]),
      );
    };
    expect(strip(DAY_ANSWER_JSON_SCHEMA)).toEqual(strip(z.toJSONSchema(DayAnswerSchema)));
    expect(DAY_ANSWER_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(JSON.stringify(DAY_ANSWER_JSON_SCHEMA)).not.toContain('"maxItems"');
  });

  it("parses a day, and says why an answer is not one", () => {
    const answer = { placeIds: ["place_026"], reasons: [{ placeId: "place_026", reason: "Art." }] };
    expect(parseDayAnswerText(JSON.stringify(answer))).toEqual({ ok: true, answer });
    expect(parseDayAnswerText("not json")).toEqual({
      ok: false,
      issues: ["The answer is not valid JSON."],
    });
    const many = { placeIds: Array(MAX_STOPS_PER_DAY + 1).fill("p"), reasons: [] };
    expect(parseDayAnswerText(JSON.stringify(many)).ok).toBe(false);
    expect(parseDayAnswerText('{"placeIds":[]}')).toMatchObject({ ok: false });
  });
});

function message(text: string, stop: Anthropic.StopReason = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 120 },
  } as unknown as Anthropic.Message;
}

describe("the Claude API client's day calls", () => {
  const select: SelectInput = {
    request: rome.request,
    system: "day system",
    user: "day user",
    timeoutMs: 9_000,
    signal: new AbortController().signal,
  };
  const answer = { placeIds: ["place_026"], reasons: [{ placeId: "place_026", reason: "Art." }] };

  it("asks for the one-day schema, and repairs with the previous answer and the violations", async () => {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const sdk: MessagesApi = {
      messages: {
        create: async (params) => {
          calls.push(params);
          return message(JSON.stringify(answer));
        },
      },
    };
    const client = createAnthropicClient({
      apiKey: "k",
      model: "claude-sonnet-5",
      effort: "low",
      sdk,
    });
    const first = await client.selectDay?.(select);
    const repair: RepairInput = {
      ...select,
      previousText: "",
      violations: [],
      repairMessage: "fix it",
    };
    await client.repairDay?.(repair);

    expect(first).toMatchObject({ answer, usage: { inputTokens: 900, outputTokens: 120 } });
    expect(calls[0]?.output_config?.format).toEqual({
      type: "json_schema",
      schema: DAY_ANSWER_JSON_SCHEMA,
    });
    expect(calls[1]?.messages).toEqual([
      { role: "user", content: "day user" },
      { role: "assistant", content: "{}" },
      { role: "user", content: "fix it" },
    ]);
  });

  it("never parses a refusal or a cut-off answer, and reports an off-schema one", () => {
    expect(toDayResult(message("", "refusal"), 1)).toMatchObject({
      answer: null,
      schemaIssues: [],
    });
    expect(toDayResult(message('{"placeIds"', "max_tokens"), 1).answer).toBeNull();
    const off = toDayResult(message('{"days":[]}'), 1);
    expect(off.answer).toBeNull();
    expect(off.schemaIssues.length).toBeGreaterThan(0);
  });
});

describe("the fixture's day answers", () => {
  it("reads the day, its base, the trip's bases, the used places and the candidates back", () => {
    const offer = parseDayOffer(`${user}\n\n<traveler_notes>\nplace_001 | x\n</traveler_notes>`);

    expect(offer).toMatchObject({ day: 2, date: "2026-10-21", base: "florence" });
    expect(offer.bases).toEqual(["rome", "rome", "florence"]);
    expect(offer.used).toEqual([
      ...(input.days[0]?.placeIds ?? []),
      ...(input.days[1]?.placeIds ?? []),
    ]);
    expect(offer.candidates).not.toContain("place_001");
  });

  it("gives a valid day from the offered candidates", () => {
    const answer = validDayAnswer(rome.request, user, ctx);
    const offered = parseDayOffer(user).candidates;

    expect(answer.placeIds.length).toBeGreaterThan(0);
    expect(answer.placeIds.every((id) => offered.includes(id))).toBe(true);
    expect(answer.reasons).toHaveLength(answer.placeIds.length);
  });

  it("falls back to an unknown id when there is no closed place or no used place to add", () => {
    const answer = validDayAnswer(rome.request, user, ctx);
    // 2026-10-21 is a Wednesday: nothing in Florence is closed.
    expect(withClosedDayPlace(answer, user, ctx).placeIds[0]).toBe("place_999");
    const lonely = user.replace(
      /Already used on other days \(not offered, never use\): .*/,
      "Already used on other days (not offered, never use): none",
    );
    expect(withRepeatedDay(answer, lonely).placeIds[0]).toBe("place_999");
    expect(messyDayAnswer(answer, user, ctx).placeIds).toEqual([
      ...[...answer.placeIds].reverse(),
      parseDayOffer(user).used[0],
    ]);
  });

  it("answers with the first candidate when the rules could plan nothing from them", () => {
    const tiny = user
      .replace(/^place_\d+ \|.*\n/gm, "")
      .replace(/(\| notes\):\n)/, "$1place_033 | x\n");
    const answer = validDayAnswer({ ...rome.request, exclude: ["place_033"] }, tiny, ctx);
    expect(answer.placeIds).toEqual(["place_033"]);
  });
});

describe("the day cache", () => {
  const NOW = Date.UTC(2026, 8, 23, 12);
  const witness = checkDayBase(input.request, input.days, 2, "florence", ctx).day as DaySelection;
  const timed = scheduleTrip(input.request, withDay(input.days, 2, witness), ctx).days[2];
  const result: PlanDayResponse = {
    day: 2,
    dayPlan: timed as PlanDayResponse["dayPlan"],
    source: "ai",
    meta: { attempts: 1, latencyMs: 5, generatedAt: new Date(NOW).toISOString() },
  };
  const parts = {
    promptVersion: "day-v1",
    model: "m",
    codeVersion: "abc",
    dataVersion: "0123456789abcdef",
    input,
  };

  function setup(store: TripStore | null = createMemoryStore(() => NOW), now = () => NOW) {
    const memory = new LruCache<CachedDay>(10);
    return { memory, store, deps: { memory, store, now, ctx } };
  }

  it("keys on every part of the day it answers", () => {
    const base = dayCacheKey(parts);
    const changed = [
      { ...parts, promptVersion: "day-v2" },
      { ...parts, model: "other" },
      { ...parts, codeVersion: "def" },
      { ...parts, dataVersion: "fedcba9876543210" },
      { ...parts, input: { ...input, anchorId: "venice" } },
      { ...parts, input: { ...input, day: 1 } },
      { ...parts, input: { ...input, avoid: ["place_026"] } },
      { ...parts, input: { ...input, request: { ...input.request, pace: "packed" as const } } },
      { ...parts, input: dayInput(plannedTrip({ startDate: "2026-10-17" }), 2, "florence") },
      {
        ...parts,
        input: {
          ...input,
          days: withDay(input.days, 0, {
            anchorId: "rome",
            placeIds: input.days[0]?.placeIds.slice(1) ?? [],
          }),
        },
      },
    ];
    for (const other of changed) expect(dayCacheKey(other)).not.toBe(base);
    // The day's own current places are not part of it, and neither is the order of the avoided.
    const emptied = { ...input, days: withDay(input.days, 2, { anchorId: "rome", placeIds: [] }) };
    expect(dayCacheKey({ ...parts, input: emptied })).toBe(base);
    const a = { ...input, avoid: ["place_027", "place_026"] };
    const b = { ...input, avoid: ["place_026", "place_027"] };
    expect(dayCacheKey({ ...parts, input: a })).toBe(dayCacheKey({ ...parts, input: b }));
  });

  it("finds a day it cached, in memory first, then in the table from another instance", async () => {
    const { store, deps } = setup();
    const fields: LogFields = {};

    await cacheDay("k", input, result, deps, fields);
    expect(fields.cacheWrite).toBe("ok");
    expect(await readCachedDay("k", input, deps, fields)).toEqual(result);
    expect(fields.cache).toBe("hit-memory");

    const other = setup(store);
    expect(await readCachedDay("k", input, other.deps, fields)).toEqual(result);
    expect(fields.cache).toBe("hit-store");
    expect(other.memory.get("k")?.result).toEqual(result);
  });

  it("misses on an expired memory copy, an unreadable table item, or a day that no longer fits", async () => {
    const { store, deps, memory } = setup();
    memory.set("old", { result, expiresAt: NOW / 1000 - 1 });
    const fields: LogFields = {};

    expect(await readCachedDay("old", input, deps, fields)).toBeUndefined();
    expect(memory.get("old")).toBeUndefined();

    await store?.putNew(
      cacheKey("bad"),
      "{not json",
      NOW / 1000 + 60,
      new AbortController().signal,
    );
    expect(await readCachedDay("bad", input, deps, fields)).toBeUndefined();

    memory.set("moved", { result: { ...result, day: 1 }, expiresAt: NOW / 1000 + 60 });
    expect(await readCachedDay("moved", input, deps, fields)).toBeUndefined();
    const repeat = {
      ...result,
      dayPlan: { ...result.dayPlan, stops: rome.days[0]?.stops ?? [] },
    } as PlanDayResponse;
    memory.set("repeat", { result: repeat, expiresAt: NOW / 1000 + 60 });
    expect(await readCachedDay("repeat", input, deps, fields)).toBeUndefined();
    expect(fields.cache).toBe("miss");
  });

  it("keeps a day planned for notes out of the table, and never reads the table for one", async () => {
    const { store, deps } = setup();
    const notes = { ...input, request: { ...input.request, notes: "quiet please" } };
    const fields: LogFields = {};

    await cacheDay("n", notes, result, deps, fields);
    expect(await store?.get(cacheKey("n"), new AbortController().signal)).toBeNull();
    expect(fields.cacheWrite).toBeUndefined();

    const other = setup(store);
    expect(await readCachedDay("n", notes, other.deps, fields)).toBeUndefined();
    // A table item under the key is not read either.
    const text = JSON.stringify({ v: 1, kind: "day", expiresAt: NOW / 1000 + 60, result });
    await store?.putNew(cacheKey("t"), text, NOW / 1000 + 60, new AbortController().signal);
    expect(await readCachedDay("t", input, setup(store).deps, fields)).toEqual(result);
    expect(await readCachedDay("t", notes, setup(store).deps, fields)).toBeUndefined();
  });

  it("works with no table at all, and records a table that fails", async () => {
    const none = setup(null);
    const fields: LogFields = {};
    await cacheDay("k", input, result, none.deps, fields);
    expect(await readCachedDay("k", input, none.deps, fields)).toEqual(result);

    const failing: TripStore = {
      kind: "memory",
      putNew: async () => {
        throw new Error("down");
      },
      get: async () => {
        throw new Error("down");
      },
    };
    const broken = setup(failing);
    await cacheDay("k", input, result, broken.deps, fields);
    expect(fields.cacheWrite).toBe("error");
    const cold = setup(failing);
    expect(await readCachedDay("k", input, cold.deps, fields)).toBeUndefined();
    expect(fields.cacheRead).toBe("error");
  });
});
