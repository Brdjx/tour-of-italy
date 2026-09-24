import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createAnthropicClient } from "@italy/api/llm/anthropic";
import type { LlmClient } from "@italy/api/llm/client";
import { LlmError } from "@italy/api/llm/errors";
import { validSelection } from "@italy/api/llm/fixtureAnswers";
import { PROMPT_VERSION } from "@italy/api/llm/prompt";
import { afterEach, describe, expect, it } from "vitest";
import { runLive, stopReason } from "../src/liveRun";
import { pipelineSettings } from "../src/pipeline";
import { readRecordings } from "../src/recordingStore";
import { replayRecordings } from "../src/replayRun";
import { Scrubber } from "../src/scrub";
import { CASES, caseById, ctx, filesUnder, tempDir } from "./helpers";

// `pnpm eval` cannot call Claude in CI, so the whole live path runs here against a local fake of
// the Messages API with the real SDK client: the same requests, headers, and error classes as a
// live run. The fake key is really sent (the fake server sees it) and must never reach disk.

const FAKE_KEY = "sk-ant-test-FAKE-live-run-0123456789";
const rome = caseById("rome-food-balanced");
const splurge = caseById("splurge");

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function readBody(req: IncomingMessage): Promise<{ messages: { content: string }[] }> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => resolve(JSON.parse(text)));
  });
}

/** Answers Rome with a valid plan and rejects the key (echoing it back) for anything else. */
async function fakeMessagesApi(): Promise<{ baseURL: string; keysSeen: string[] }> {
  const keysSeen: string[] = [];
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const key = String(req.headers["x-api-key"]);
    keysSeen.push(key);
    const user = body.messages[0]?.content ?? "";
    if (user.includes(`Day 1: ${rome.request.startDate}`)) {
      const text = JSON.stringify(validSelection(rome.request, user, ctx));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 4000, output_tokens: 600 },
        }),
      );
      return;
    }
    res.writeHead(401, { "content-type": "application/json", "x-api-key": key });
    const message = `invalid x-api-key: ${key}`;
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message } }));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}`, keysSeen };
}

async function liveRun(cases = [rome, splurge], runs = 2) {
  const api = await fakeMessagesApi();
  const recordingsDir = tempDir();
  const resultsDir = tempDir();
  const client = createAnthropicClient({
    apiKey: FAKE_KEY,
    model: "claude-sonnet-5",
    effort: "low",
    baseURL: api.baseURL,
  });
  const run = () =>
    runLive({
      model: "claude-sonnet-5",
      runs,
      cases,
      ctx,
      client,
      settings: pipelineSettings(),
      scrubber: new Scrubber([FAKE_KEY]),
      recordingsDir,
      resultsDir,
    });
  return { api, recordingsDir, resultsDir, run };
}

describe("live runner against a fake Messages API", () => {
  it("records every call, measures tokens and cost, and stops at a rejected key", async () => {
    const { api, recordingsDir, resultsDir, run } = await liveRun();
    const result = await run();
    expect(api.keysSeen.every((k) => k === FAKE_KEY)).toBe(true);
    expect(result.measures.map((m) => `${m.caseId} ${m.source}`)).toEqual([
      "rome-food-balanced ai",
      "rome-food-balanced ai",
      "splurge deterministic",
    ]);
    expect(result.stopped).toMatch(
      /rejected the key.*It said: .*\(authentication_error: invalid \[redacted\]/,
    );
    // Rome finished and was saved; splurge stopped at the key, so none of its calls were.
    expect(result.recordings).toBe(2);
    expect(
      filesUnder(recordingsDir).every(({ path }) => path.includes("/rome-food-balanced-")),
    ).toBe(true);
    const first = result.measures[0];
    expect(first?.inputTokens).toBe(4000);
    expect(first?.costUsd).toBeCloseTo((4000 * 2 + 600 * 10) / 1_000_000, 10);
    const results = JSON.parse(readFileSync(result.resultsPath, "utf8"));
    expect(results.summary.plans).toBe(3);
    expect(results.pricing.price).toEqual({ inputUsdPerMillion: 2, outputUsdPerMillion: 10 });
    for (const { path, text } of [...filesUnder(recordingsDir), ...filesUnder(resultsDir)]) {
      expect(text.includes("sk-ant-test-FAKE"), path).toBe(false);
      expect(/x-api-key/i.test(text), path).toBe(false);
    }
  });

  it("writes recordings that replay offline to the outcome they had live", async () => {
    const { recordingsDir, run } = await liveRun([rome], 2);
    const live = await run();
    const [recording] = readRecordings(recordingsDir);
    expect(recording?.limits).toEqual(pipelineSettings().config);
    expect(recording?.startedAfterMs).toBeGreaterThanOrEqual(0);
    const groups = await replayRecordings(recordingsDir, CASES, ctx);
    expect(groups.map((g) => `${g.kind} ${g.model}`)).toEqual(["live claude-sonnet-5"]);
    const replayed = groups[0]?.measures ?? [];
    expect(replayed.map((m) => [m.source, m.fallbackReason])).toEqual(
      live.measures.map((m) => [m.source, m.fallbackReason]),
    );
    expect(replayed[0]?.inputTokens).toBe(4000);
    expect(groups[0]?.stale).toEqual([]);
  });

  it("replaces a case's old recordings, so a leftover repair answer cannot join the new run", async () => {
    const { recordingsDir, run } = await liveRun([rome], 1);
    const folder = join(recordingsDir, "claude-sonnet-5", PROMPT_VERSION);
    mkdirSync(folder, { recursive: true });
    const leftover = join(folder, "rome-food-balanced-1-2.json");
    writeFileSync(leftover, "{}");
    await run();
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(join(folder, "rome-food-balanced-1-1.json"))).toBe(true);
  });
});

/** A client that fails every call with a rejected key, like a revoked ANTHROPIC_API_KEY. */
const rejectingClient: LlmClient = {
  model: "claude-sonnet-5",
  select: () => Promise.reject(new LlmError("auth", "Model API rejected the key", { status: 401 })),
  repair: () => Promise.reject(new Error("unused")),
};

describe("live runner that stops early", () => {
  it("keeps the previous recordings of a case when a rerun stops at a rejected key", async () => {
    const { recordingsDir, resultsDir, run } = await liveRun([rome], 1);
    await run();
    const before = filesUnder(recordingsDir);
    expect(before).toHaveLength(1);
    const again = await runLive({
      model: "claude-sonnet-5",
      runs: 3,
      cases: [rome],
      ctx,
      client: rejectingClient,
      settings: pipelineSettings(),
      scrubber: new Scrubber([FAKE_KEY]),
      recordingsDir,
      resultsDir,
    });
    expect(again.stopped).toMatch(/rejected the key/);
    expect(again.recordings).toBe(0);
    expect(filesUnder(recordingsDir)).toEqual(before);
  });
});

describe("live runner decisions", () => {
  it("stops the run on a rejected key or request, and carries on after anything else", () => {
    expect(stopReason([{ turn: "select", error: { kind: "auth", message: "bad key" } }])).toMatch(
      /key.*It said: bad key/,
    );
    expect(stopReason([{ turn: "select", error: { kind: "bad_request", message: "x" } }])).toMatch(
      /model id/,
    );
    expect(
      stopReason([{ turn: "select", error: { kind: "rate_limited", message: "x" } }]),
    ).toBeNull();
    expect(stopReason([])).toBeNull();
  });
});
