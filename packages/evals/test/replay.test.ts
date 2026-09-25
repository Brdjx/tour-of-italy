import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LlmError } from "@italy/api/llm/errors";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ReplayClient, ReplayExhaustedError, resultFromRecording } from "../src/clients";
import { buildLatest, type LatestBuild } from "../src/latest";
import { LATEST_REPORT, PATHS } from "../src/paths";
import { groupRuns, type Recording } from "../src/recording";
import { readRecordings, writeRecording } from "../src/recordingStore";
import { ReplayClock } from "../src/replayClock";
import { chooseRecordings, replayRecordings } from "../src/replayRun";
import { Scrubber } from "../src/scrub";
import { CASES, caseById, ctx, filesUnder, tempDir } from "./helpers";

// The replay is what CI runs on every push. It must be deterministic (the same recordings always
// give the same report), must end every plan valid whatever the recorded answer was, and must
// notice recordings that no longer match today's candidates instead of silently trusting them.

const committed = readRecordings(PATHS.recordings);

function recordingsFor(kind: Recording["kind"], caseId: string): Recording[] {
  return committed.filter((r) => r.kind === kind && r.caseId === caseId);
}

function writeAll(recordings: readonly Recording[]): string {
  const dir = tempDir();
  for (const r of recordings) writeRecording(dir, r, new Scrubber());
  return dir;
}

describe("replay of the committed recordings", () => {
  let first: LatestBuild;
  beforeAll(async () => {
    first = await buildLatest({ cases: CASES, ctx, recordingsDir: PATHS.recordings });
  });

  it("ends every replayed plan valid, bad answers included (the one blocking check)", () => {
    expect(first.plans).toBe(28); // 16 simulated cases and 12 guardrail recordings
    expect(first.invalidPlans).toBe(0);
  });

  it("fails when the committed latest.md no longer matches a replay of the committed recordings", () => {
    const committedReport = readFileSync(join(PATHS.results, LATEST_REPORT), "utf8");
    const hint = "results/latest.md is out of date: run `pnpm eval:replay` and commit it";
    expect(committedReport, hint).toBe(first.markdown);
  });

  it("ends every guardrail recording by the path it names", () => {
    const scenarios = first.groups.flatMap((g) => g.scenarios);
    expect(scenarios).toHaveLength(12);
    for (const s of scenarios) {
      expect(s.finalValid, s.name).toBe(true);
      // A stale recording (the candidates changed since it was made) is still replayed, but its
      // well-formed answer may no longer be valid, so only its final plan is held to account.
      // Re-seed with `pnpm --filter @italy/evals eval:seed` to make it current again.
      if (!s.stale) expect(s.got, s.name).toBe(s.expected);
    }
  });

  it("gives identical plans, numbers, and report on a second replay", async () => {
    const second = await buildLatest({ cases: CASES, ctx, recordingsDir: PATHS.recordings });
    expect(second.markdown).toBe(first.markdown);
    expect(JSON.stringify(second.groups)).toBe(JSON.stringify(first.groups));
  });

  it("marks every offline recording as such in its file name", () => {
    for (const { path } of filesUnder(PATHS.recordings)) {
      expect(path).toMatch(
        /\/(simulated|adversarial)\/v\d+\/[a-z0-9-]+-\d+-\d+\.(simulated|adversarial)\.json$/,
      );
    }
  });
});

describe("replay isolation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never touches the network, even for a run that needs a repair", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network used during replay")));
    vi.stubGlobal("fetch", fetchSpy);
    const [group] = await replayRecordings(
      writeAll(recordingsFor("adversarial", "everything")),
      CASES,
      ctx,
    );
    expect(group?.measures[0]?.source).toBe("ai_repaired");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("what the model did, not what code tidied", () => {
  it("counts a closed-day pick the tidy step dropped as the model's mistake", async () => {
    // The first answer puts a museum on its closed Monday. Tidying drops it, so the plan passes
    // with no repair and no rejected answer, but the case forbids a closed pick by the model.
    const [first] = recordingsFor("adversarial", "florence-art-monday");
    const [group] = await replayRecordings(writeAll([first as Recording]), CASES, ctx);
    const m = group?.measures[0];
    expect(m?.source).toBe("ai_repaired");
    expect(m?.repairTried).toBe(false);
    expect(m?.firstPassValid).toBe(false);
    const forbid = m?.checks.find((check) => check.name === "forbidViolationCodes");
    expect(forbid?.status).toBe("fail");
  });
});

describe("stale and partial recordings", () => {
  it("marks a run stale when the candidate list changed since recording, and still replays it", async () => {
    const [attempt] = recordingsFor("simulated", "lake-como-july");
    const changed = { ...(attempt as Recording), candidateHash: `sha256:${"a".repeat(64)}` };
    const [group] = await replayRecordings(writeAll([changed]), CASES, ctx);
    expect(group?.stale).toEqual([
      { caseId: "lake-como-july", run: 1, reasons: ["candidates changed"] },
    ]);
    expect(group?.measures[0]?.shape?.finalValid).toBe(true);
    expect(group?.measures[0]?.stale).toBe(true);
  });

  it("marks a run stale when its case's request was edited after recording", async () => {
    const dir = writeAll(recordingsFor("simulated", "splurge"));
    const edited = CASES.map((c) =>
      c.id === "splurge" ? { ...c, request: { ...c.request, pace: "packed" as const } } : c,
    );
    const [group] = await replayRecordings(dir, edited, ctx);
    expect(group?.stale[0]?.reasons).toEqual(["request changed"]);
  });

  it("falls back and counts the gap when the recordings end before the pipeline is done", async () => {
    // Only the first answer, whose invented ids no tidying can fix: the pipeline asks for a
    // repair that was never recorded. (A closed-day answer no longer needs one: tidy.ts drops it.)
    const [bad] = recordingsFor("adversarial", "adversarial-outside-data");
    const [group] = await replayRecordings(writeAll([bad as Recording]), CASES, ctx);
    const m = group?.measures[0];
    expect(m?.source).toBe("deterministic");
    expect(m?.fallbackReason).toBe("llm_error");
    expect(m?.shape?.finalValid).toBe(true);
    expect(group?.missingCalls).toBe(1);
  });

  it("refuses a run with a gap in its attempts instead of replaying half of it", () => {
    const [, second] = recordingsFor("adversarial", "everything");
    expect(() => groupRuns([second as Recording])).toThrow(/attempt 1 is missing/);
  });

  it("replays live recordings instead of the simulated set once any exist", () => {
    const simulated = recordingsFor("simulated", "splurge");
    const live = simulated.map((r) => ({ ...r, kind: "live" as const, model: "claude-sonnet-5" }));
    const chosen = chooseRecordings([...committed, ...live]);
    expect(chosen.some((r) => r.kind === "simulated")).toBe(false);
    expect(chosen.filter((r) => r.kind === "live")).toHaveLength(live.length);
    expect(chosen.filter((r) => r.kind === "adversarial")).toHaveLength(20);
  });
});

describe("replayed time", () => {
  it("skips a repair the live run had no time for, instead of asking for an unrecorded call", async () => {
    // A 500 after 8 s, then an invalid answer after 11 s: a frozen clock would grant a repair,
    // find no recording for it, and report llm_error instead of the timeout that happened.
    const recordings = recordingsFor("adversarial", "must-include-two-cities");
    const [group] = await replayRecordings(writeAll(recordings), CASES, ctx);
    const m = group?.measures[0];
    expect([m?.source, m?.fallbackReason, m?.repairTried]).toEqual([
      "deterministic",
      "timeout",
      false,
    ]);
    expect(group?.missingCalls).toBe(0);
  });

  it("replays a live run with the deadline it ran with, not today's default", async () => {
    // Under a 2 s deadline there is no time for even a first call; under today's 24 s default
    // the recorded answer would become the plan.
    const tight = { timeoutMs: 2_000, deadlineMs: 2_000, maxAttempts: 2 };
    const live = recordingsFor("simulated", "splurge").map((r) => ({
      ...r,
      kind: "live" as const,
      model: "claude-sonnet-5",
      limits: tight,
    }));
    const [group] = await replayRecordings(writeAll(live), CASES, ctx);
    const m = group?.measures[0];
    expect([m?.source, m?.fallbackReason, m?.calls]).toEqual(["deterministic", "timeout", 0]);
  });

  it("moves the clock to where each recorded call ended, and never back", async () => {
    const [answer] = recordingsFor("simulated", "splurge");
    if (!answer) throw new Error("fixture missing");
    const timed = (startedAfterMs: number | undefined, latencyMs: number): Recording => ({
      ...answer,
      ...(startedAfterMs === undefined ? {} : { startedAfterMs }),
      response: { ...(answer.response as NonNullable<Recording["response"]>), latencyMs },
    });
    const clock = new ReplayClock(1_000);
    const client = new ReplayClient(
      [timed(500, 2_000), timed(undefined, 3_000), timed(0, 0)],
      "m",
      clock,
    );
    const input = {
      request: answer.request,
      system: "",
      user: "",
      timeoutMs: 1,
      signal: new AbortController().signal,
    };
    await client.select(input);
    expect(clock.now()).toBe(3_500); // started 500 ms in, ran 2 s
    await client.select(input);
    expect(clock.elapsedMs).toBe(5_500); // no recorded start: began when the previous call ended
    await client.select(input);
    expect(clock.elapsedMs).toBe(5_500);
  });
});

describe("replay client", () => {
  const base = recordingsFor("adversarial", "splurge"); // overloaded, then a valid answer
  const signal = new AbortController().signal;
  const input = {
    request: caseById("splurge").request,
    system: "",
    user: "",
    timeoutMs: 1,
    signal,
  };

  it("throws a recorded failure as the same error kind, status, and retry-after", async () => {
    const client = new ReplayClient(recordingsFor("adversarial", "budget-traveler"), "m");
    const error = await client.select(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 30_000 });
  });

  it("answers calls in recorded order and notes a call it has no answer for", async () => {
    const client = new ReplayClient(base, "m");
    await expect(client.select(input)).rejects.toMatchObject({ kind: "overloaded" });
    await expect(client.select(input)).resolves.toMatchObject({ stopReason: "end_turn" });
    await expect(client.select(input)).rejects.toBeInstanceOf(ReplayExhaustedError);
    expect(client.missingCalls).toBe(1);
    expect(client.calls.map((c) => c.turn)).toEqual(["select", "select", "select"]);
  });

  it("parses answers with the production parser, and never parses a cut-off or refused one", () => {
    const valid = base[1]?.response;
    if (!valid) throw new Error("fixture missing");
    expect(resultFromRecording(valid).selection?.days).toHaveLength(3);
    expect(resultFromRecording({ ...valid, stopReason: "max_tokens" }).selection).toBeNull();
    expect(resultFromRecording({ ...valid, stopReason: "refusal" }).selection).toBeNull();
    const offSchema = resultFromRecording({ ...valid, rawText: '{"days":"three"}' });
    expect(offSchema.selection).toBeNull();
    expect(offSchema.schemaIssues.length).toBeGreaterThan(0);
  });
});
