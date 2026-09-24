import type { LlmClient, LlmResult, SelectInput } from "@italy/api/llm/client";
import { LlmError } from "@italy/api/llm/errors";
import { validSelection, withUnknownId } from "@italy/api/llm/fixtureAnswers";
import { buildUserMessage } from "@italy/api/llm/promptUser";
import { parseSelectionText } from "@italy/api/llm/schema";
import { describe, expect, it } from "vitest";
import { RecordingClient } from "../src/clients";
import { runLive } from "../src/liveRun";
import type { PlanMeasure } from "../src/metrics";
import { pipelineSettings, shortlistFor } from "../src/pipeline";
import { readRecordings } from "../src/recordingStore";
import { replayRecordings } from "../src/replayRun";
import { Scrubber } from "../src/scrub";
import { CASES, caseById, ctx, tempDir } from "./helpers";

// Time is what decides a live plan's path: a slow call leaves no room for a repair, a timeout is
// the slowest answer a traveler sees. The recordings must keep every duration, and a replay must
// reach the same deadline decisions the live run did.

const rome = caseById("rome-food-balanced");

describe("live runner timing", () => {
  it("replays a run that ran out of time for its repair as that timeout, with no unrecorded call", async () => {
    // A 500 after 8 s, a retry, then an answer with an invented id after 11 s: with the 24 s
    // deadline and its 1.5 s reserve, too little time is left for a repair.
    const florence = caseById("florence-art-monday");
    const user = buildUserMessage(florence.request, shortlistFor(florence.request, ctx), ctx);
    const text = JSON.stringify(withUnknownId(validSelection(florence.request, user, ctx)));
    const parsed = parseSelectionText(text);
    let clock = Date.UTC(2026, 8, 24, 12);
    let calls = 0;
    const client: LlmClient = {
      model: "claude-sonnet-5",
      select: async () => {
        calls++;
        if (calls === 1) {
          clock += 8_000;
          throw new LlmError("server_error", "Model API error", { status: 500 });
        }
        clock += 11_000;
        return {
          selection: parsed.ok ? parsed.selection : null,
          rawText: text,
          schemaIssues: [],
          usage: { inputTokens: 4000, outputTokens: 900 },
          latencyMs: 11_000,
          model: "claude-sonnet-5",
          stopReason: "end_turn",
        };
      },
      repair: () => Promise.reject(new Error("the live run never asks for this repair")),
    };
    const recordingsDir = tempDir();
    const live = await runLive({
      model: "claude-sonnet-5",
      runs: 1,
      cases: [florence],
      ctx,
      client,
      settings: pipelineSettings(),
      scrubber: new Scrubber(),
      recordingsDir,
      resultsDir: tempDir(),
      now: () => clock,
    });
    const outcome = (m: PlanMeasure | undefined) => [m?.source, m?.fallbackReason, m?.calls];
    expect(outcome(live.measures[0])).toEqual(["deterministic", "timeout", 2]);
    expect(readRecordings(recordingsDir).map((r) => r.startedAfterMs)).toEqual([0, 8_000]);
    const [group] = await replayRecordings(recordingsDir, CASES, ctx);
    expect(outcome(group?.measures[0])).toEqual(outcome(live.measures[0]));
    expect(group?.measures[0]?.repairTried).toBe(false);
    expect(group?.missingCalls).toBe(0);
  });
});

describe("recorded call times", () => {
  it("keeps how long a failed call ran, so timeouts count in the latency tail", async () => {
    const times = [1_000, 13_000];
    const clock = () => times.shift() ?? 13_000;
    const inner: LlmClient = {
      model: "m",
      select: () => Promise.reject(new LlmError("timeout", "Model call exceeded 12000 ms")),
      repair: () => Promise.reject(new Error("unused")),
    };
    const client = new RecordingClient(inner, new Scrubber(), { now: clock });
    const input = {
      request: rome.request,
      system: "",
      user: "",
      timeoutMs: 1,
      signal: new AbortController().signal,
    };
    await expect(client.select(input as SelectInput)).rejects.toThrow();
    expect(client.calls[0]?.error).toMatchObject({ kind: "timeout", latencyMs: 12_000 });
  });

  it("stamps a timeout's duration even when the client never settles after the abort", async () => {
    let time = 0;
    const controller = new AbortController();
    const inner: LlmClient = {
      model: "m",
      select: () => new Promise(() => {}),
      repair: () => new Promise(() => {}),
    };
    const client = new RecordingClient(inner, new Scrubber(), {
      now: () => time,
      planStartedAt: 0,
    });
    const input = {
      request: rome.request,
      system: "",
      user: "",
      timeoutMs: 1,
      signal: controller.signal,
    };
    void client.select(input as SelectInput);
    time = 12_000;
    controller.abort();
    expect(client.calls).toEqual([
      {
        turn: "select",
        startedAfterMs: 0,
        error: expect.objectContaining({ kind: "timeout", latencyMs: 12_000 }),
      },
    ]);
  });

  it("records an answer that came after the pipeline gave up as the timeout the pipeline saw", async () => {
    const controller = new AbortController();
    const late: LlmResult = {
      selection: null,
      rawText: "{}",
      schemaIssues: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 13_000,
      model: "m",
      stopReason: "end_turn",
    };
    const inner: LlmClient = {
      model: "m",
      select: () =>
        new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve(late))),
      repair: () => Promise.resolve(late),
    };
    const client = new RecordingClient(inner, new Scrubber());
    const input = {
      request: rome.request,
      system: "",
      user: "",
      timeoutMs: 1,
      signal: controller.signal,
    };
    const pending = client.select(input as SelectInput);
    controller.abort();
    await pending;
    expect(client.calls).toEqual([
      { turn: "select", error: expect.objectContaining({ kind: "timeout" }) },
    ]);
  });
});
