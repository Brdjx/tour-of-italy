import Anthropic from "@anthropic-ai/sdk";
import { TRIP_DAYS } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { createAnthropicClient, type MessagesApi, toResult } from "../../src/llm/anthropic";
import type { RepairInput, SelectInput } from "../../src/llm/client";
import { SELECTION_JSON_SCHEMA } from "../../src/llm/schema";

// The real client, against a fake SDK transport: the exact request shape, stop_reason handling,
// and the mapping of every SDK error class to a fallback reason (F2), with no network.

const ANSWER = {
  days: Array.from({ length: TRIP_DAYS }, () => ({
    anchorId: "rome",
    placeIds: ["place_001"],
    reasons: [{ placeId: "place_001", reason: "Iconic." }],
  })),
  summary: "Three days in Rome.",
};

function message(text: string, stop: Anthropic.StopReason = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 340 },
  } as unknown as Anthropic.Message;
}

type Call = {
  params: Anthropic.MessageCreateParamsNonStreaming;
  options?: Anthropic.RequestOptions;
};

function fakeSdk(answer: () => Promise<Anthropic.Message>): { sdk: MessagesApi; calls: Call[] } {
  const calls: Call[] = [];
  const sdk: MessagesApi = {
    messages: {
      create: (params, options) => {
        calls.push({ params, options });
        return answer();
      },
    },
  };
  return { sdk, calls };
}

const signal = new AbortController().signal;
const input: SelectInput = {
  request: {} as SelectInput["request"],
  system: "system prompt",
  user: "user message",
  timeoutMs: 9_000,
  signal,
};

describe("createAnthropicClient request shape", () => {
  it("asks Sonnet 5 for structured JSON with effort, thinking off and no temperature", async () => {
    const { sdk, calls } = fakeSdk(async () => message(JSON.stringify(ANSWER)));
    const client = createAnthropicClient({
      apiKey: "k",
      model: "claude-sonnet-5",
      effort: "low",
      sdk,
    });

    const result = await client.select(input);

    const { params, options } = calls[0] as Call;
    expect(params).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 8000,
      system: "system prompt",
      messages: [{ role: "user", content: "user message" }],
      output_config: {
        format: { type: "json_schema", schema: SELECTION_JSON_SCHEMA },
        effort: "low",
      },
      thinking: { type: "disabled" },
    });
    // No SDK retries: its retry would sleep out a long retry-after inside our time budget.
    expect(options).toEqual({ timeout: 9_000, signal, maxRetries: 0 });
    expect(result.selection?.summary).toBe("Three days in Rome.");
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
  });

  it("sends temperature and no effort to Haiku 4.5", async () => {
    const { sdk, calls } = fakeSdk(async () => message(JSON.stringify(ANSWER)));
    const client = createAnthropicClient({
      apiKey: "k",
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      sdk,
    });

    await client.select(input);

    const { params } = calls[0] as Call;
    expect(params.temperature).toBe(0.2);
    expect(params.output_config).toEqual({
      format: { type: "json_schema", schema: SELECTION_JSON_SCHEMA },
    });
    expect(params.thinking).toBeUndefined();
  });

  it("repairs with the original question, its own answer, then the violation list", async () => {
    const { sdk, calls } = fakeSdk(async () => message(JSON.stringify(ANSWER)));
    const client = createAnthropicClient({
      apiKey: "k",
      model: "claude-sonnet-5",
      effort: "low",
      sdk,
    });
    const repair: RepairInput = {
      ...input,
      previousText: '{"days":[]}',
      violations: [],
      repairMessage: "Fix these problems.",
    };

    await client.repair(repair);

    expect((calls[0] as Call).params.messages).toEqual([
      { role: "user", content: "user message" },
      { role: "assistant", content: '{"days":[]}' },
      { role: "user", content: "Fix these problems." },
    ]);
  });

  it("never sends an empty assistant turn, which the API rejects", async () => {
    const { sdk, calls } = fakeSdk(async () => message(JSON.stringify(ANSWER)));
    const client = createAnthropicClient({
      apiKey: "k",
      model: "claude-sonnet-5",
      effort: "low",
      sdk,
    });

    await client.repair({ ...input, previousText: "", violations: [], repairMessage: "Fix." });

    expect((calls[0] as Call).params.messages[1]).toEqual({ role: "assistant", content: "{}" });
  });

  it("turns SDK failures into LlmErrors so the pipeline never sees SDK classes", async () => {
    const { sdk } = fakeSdk(async () => {
      throw new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    });
    const client = createAnthropicClient({
      apiKey: "k",
      model: "claude-sonnet-5",
      effort: "low",
      sdk,
    });

    await expect(client.select(input)).rejects.toMatchObject({ kind: "rate_limited" });
  });
});

describe("toResult", () => {
  it("does not parse a refused answer", () => {
    const result = toResult(message('{"days":[]}', "refusal"), 5);

    expect(result).toMatchObject({ selection: null, stopReason: "refusal", schemaIssues: [] });
  });

  it("does not parse an answer cut off at max_tokens", () => {
    const result = toResult(message('{"days":[{"anch', "max_tokens"), 5);

    expect(result).toMatchObject({ selection: null, stopReason: "max_tokens" });
  });

  it("reports off-schema JSON with issues for the repair turn", () => {
    const result = toResult(message('{"days":"three"}'), 5);

    expect(result.selection).toBeNull();
    expect(result.schemaIssues.length).toBeGreaterThan(0);
  });

  it("reads the text block after a thinking block", () => {
    const msg = message(JSON.stringify(ANSWER));
    msg.content = [{ type: "thinking", thinking: "", signature: "s" } as never, ...msg.content];

    expect(toResult(msg, 1).selection).not.toBeNull();
  });

  it("treats an answer with no text block as off-schema, not a crash", () => {
    const msg = message("");
    msg.content = [];

    expect(toResult(msg, 1)).toMatchObject({ selection: null, rawText: "" });
  });
});
