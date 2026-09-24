import type { PlannerContext } from "@italy/planner";
import type { EvalCase } from "./cases";
import { ReplayClient } from "./clients";
import { measurePipelinePlan, type Usage } from "./measure";
import type { PlanMeasure } from "./metrics";
import { candidateHash, pipelineSettings, runPlan, shortlistFor } from "./pipeline";
import { groupRuns, type RecordedRun, type Recording, type RecordingKind } from "./recording";
import { readRecordings } from "./recordingStore";
import { ReplayClock } from "./replayClock";
import { type Summary, summarize } from "./summary";

// Replays recorded model answers through the current pipeline, with no network. What the model
// said, how long it took, and what it cost come from the recording; everything the pipeline made
// of it (validity, repair, fallback, plan quality, expectations) is recomputed with today's code.

/** When every replayed plan starts, so replays are identical run to run. */
export const REPLAY_NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

export interface StaleRun {
  caseId: string;
  run: number;
  reasons: string[]; // "candidates changed", "request changed"
}

export interface ScenarioOutcome {
  caseId: string;
  name: string;
  note: string;
  expected: string; // "ai_repaired", or "deterministic (max_tokens)"
  got: string;
  asExpected: boolean;
  finalValid: boolean;
  stale: boolean; // a stale recording's "valid" answer may no longer be valid, so it may not match
}

export interface ReplayedGroup {
  kind: RecordingKind;
  model: string;
  promptVersion: string;
  recordedOn: string | null; // newest recording date, for live runs
  runsPerCase: number;
  measures: PlanMeasure[];
  summary: Summary;
  stale: StaleRun[];
  scenarios: ScenarioOutcome[]; // adversarial runs only
  missingCalls: number; // calls the pipeline made that no recording answered
  turnMismatches: number; // calls answered by a recording of the other turn (select or repair)
}

function outcomeLabel(source: string, reason: string | null | undefined): string {
  return reason ? `${source} (${reason})` : source;
}

/** Why a recorded run no longer matches what the pipeline would offer today. */
function staleReasons(run: RecordedRun, caseDef: EvalCase | undefined, hash: string): string[] {
  const first = run.attempts[0] as Recording;
  const reasons: string[] = [];
  if (first.candidateHash !== hash) reasons.push("candidates changed");
  if (caseDef && JSON.stringify(caseDef.request) !== JSON.stringify(first.request)) {
    reasons.push("request changed");
  }
  return reasons;
}

interface ReplayedRun {
  measure: PlanMeasure;
  stale: StaleRun | null;
  scenario: ScenarioOutcome | null;
  missingCalls: number;
  turnMismatches: number;
}

async function replayRun(
  run: RecordedRun,
  caseDef: EvalCase | undefined,
  ctx: PlannerContext,
): Promise<ReplayedRun> {
  const first = run.attempts[0] as Recording;
  // Decision: the recorded request is replayed, not the case file's current one, because it is
  // what the model answered. A case edited since then is reported as "request changed".
  const request = first.request;
  const shortlist = shortlistFor(request, ctx);
  const reasons = staleReasons(run, caseDef, candidateHash(shortlist, ctx));
  const clock = new ReplayClock(REPLAY_NOW);
  const client = new ReplayClient(run.attempts, run.model, clock);
  // Decision: a live run is replayed with the limits it ran with (a run made with a shorter
  // PLAN_DEADLINE_MS must give up where it gave up); the offline sets use today's defaults.
  const config = first.limits ?? pipelineSettings().config;
  const attempt = await runPlan(request, client, ctx, { now: clock.now, config });
  const recordedCalls = run.attempts.map((r) => ({ turn: r.turn, response: r.response }));
  // Model time is every recorded call of the run, failed ones included; tokens come from answers.
  const usage: Usage | null =
    run.kind === "live"
      ? {
          model: run.model,
          latencyMs: run.attempts.reduce(
            (sum, r) => sum + (r.response?.latencyMs ?? r.error?.latencyMs ?? 0),
            0,
          ),
          calls: recordedCalls,
        }
      : null;
  const measure = measurePipelinePlan(
    {
      caseId: run.caseId,
      caseDef,
      run: run.run,
      attempt,
      calls: client.calls,
      shortlist,
      usage,
      stale: reasons.length > 0,
    },
    ctx,
  );
  const stale = reasons.length > 0 ? { caseId: run.caseId, run: run.run, reasons } : null;
  return {
    measure,
    stale,
    scenario: scenarioOutcome(first, measure),
    missingCalls: client.missingCalls,
    turnMismatches: client.turnMismatches,
  };
}

function scenarioOutcome(first: Recording, measure: PlanMeasure): ScenarioOutcome | null {
  const scenario = first.scenario;
  if (scenario === undefined) return null;
  const expected = outcomeLabel(scenario.expectSource, scenario.expectFallbackReason);
  const got = outcomeLabel(measure.source, measure.fallbackReason);
  return {
    caseId: first.caseId,
    name: scenario.name,
    note: scenario.note,
    expected,
    got,
    asExpected: expected === got,
    finalValid: measure.shape?.finalValid ?? false,
    stale: measure.stale,
  };
}

/**
 * Which recordings to replay: live ones when any exist, otherwise the simulated set, and the
 * adversarial set always.
 */
// Decision: once real model answers are recorded, the simulated set says nothing more about the
// model and is left out of the report. The adversarial set is guardrail stress, not model
// behavior, so it always runs.
export function chooseRecordings(all: readonly Recording[]): Recording[] {
  const hasLive = all.some((r) => r.kind === "live");
  return all.filter((r) => r.kind === "adversarial" || r.kind === (hasLive ? "live" : "simulated"));
}

/** Replays every chosen recording under `dir`, one group per kind, model, and prompt version. */
export async function replayRecordings(
  dir: string,
  cases: readonly EvalCase[],
  ctx: PlannerContext,
): Promise<ReplayedGroup[]> {
  const casesById = new Map(cases.map((c) => [c.id, c]));
  const runs = groupRuns(chooseRecordings(readRecordings(dir)));
  const groups = new Map<string, { runs: RecordedRun[]; replayed: ReplayedRun[] }>();
  for (const run of runs) {
    const key = `${run.kind}|${run.model}|${run.promptVersion}`;
    const group = groups.get(key) ?? { runs: [], replayed: [] };
    group.runs.push(run);
    group.replayed.push(await replayRun(run, casesById.get(run.caseId), ctx));
    groups.set(key, group);
  }
  return [...groups.values()].map(({ runs: groupRunsList, replayed }) => {
    const head = groupRunsList[0] as RecordedRun;
    const dates = groupRunsList.flatMap((r) => r.attempts.map((a) => a.recordedAt.slice(0, 10)));
    const measures = replayed.map((r) => r.measure);
    return {
      kind: head.kind,
      model: head.model,
      promptVersion: head.promptVersion,
      recordedOn: head.kind === "live" ? ([...dates].sort().at(-1) ?? null) : null,
      runsPerCase: Math.max(...groupRunsList.map((r) => r.run)),
      measures,
      summary: summarize(measures),
      stale: replayed.flatMap((r) => (r.stale ? [r.stale] : [])),
      scenarios: replayed.flatMap((r) => (r.scenario ? [r.scenario] : [])),
      missingCalls: replayed.reduce((sum, r) => sum + r.missingCalls, 0),
      turnMismatches: replayed.reduce((sum, r) => sum + r.turnMismatches, 0),
    };
  });
}
