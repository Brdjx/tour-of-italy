import { join } from "node:path";
import type { LlmClient } from "@italy/api/llm/client";
import { PROMPT_VERSION } from "@italy/api/llm/prompt";
import type { PlannerContext } from "@italy/planner";
import type { EvalCase } from "./cases";
import { RecordingClient } from "./clients";
import { formatJson, writeJson } from "./jsonFile";
import { measurePipelinePlan } from "./measure";
import type { PlanMeasure } from "./metrics";
import { candidateHash, type PipelineSettings, runPlan, shortlistFor } from "./pipeline";
import { PRICING_CHECKED_ON, PRICING_SOURCE, priceFor } from "./pricing";
import { type CallRecord, folderName, RECORDING_FORMAT, type Recording } from "./recording";
import { replaceCaseRecordings } from "./recordingStore";
import type { Scrubber } from "./scrub";
import { type Summary, summarize } from "./summary";

// The live eval: every case, `runs` times, through the production pipeline with a real model
// client. Every call is recorded as it happened; the measured plans go to a results file.

export interface LiveRunOptions {
  model: string;
  runs: number;
  cases: readonly EvalCase[];
  ctx: PlannerContext;
  client: LlmClient; // one client for the whole run, as a warm API instance keeps one
  settings: PipelineSettings;
  scrubber: Scrubber; // knows the API key, so neither recordings nor results can hold it
  recordingsDir: string;
  resultsDir: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface LiveRunResult {
  measures: PlanMeasure[];
  summary: Summary;
  resultsPath: string;
  recordings: number; // recordings saved: finished cases only
  stopped: string | null; // why the run stopped early, or null
}

/**
 * Why the run should stop now, or null. A rejected key or request fails every later call the
 * same way, so running on would only spend time (and write useless recordings).
 */
export function stopReason(calls: readonly CallRecord[]): string | null {
  const rejected = (kind: string) => calls.find((call) => call.error?.kind === kind)?.error;
  const auth = rejected("auth");
  // The message was scrubbed when it was recorded; it is the only place the API's words survive,
  // because the recordings of a stopped case are not saved.
  if (auth) {
    return `The API rejected the key (401 or 403). Check ANTHROPIC_API_KEY. It said: ${auth.message}`;
  }
  const bad = rejected("bad_request");
  if (bad) {
    return `The API rejected the request (400 or 404): usually a wrong model id or a setting the model does not accept. It said: ${bad.message}`;
  }
  return null;
}

function progressLine(m: PlanMeasure, runs: number): string {
  const how = m.fallbackReason === null ? m.source : `${m.source} (${m.fallbackReason})`;
  const time = m.latencyMs === null ? "" : `, ${(m.latencyMs / 1000).toFixed(1)} s`;
  const valid = m.shape?.finalValid ? "" : ", NOT VALID";
  return `${m.caseId} run ${m.run}/${runs}: ${how}, ${m.calls} call(s)${time}${valid}`;
}

export async function runLive(options: LiveRunOptions): Promise<LiveRunResult> {
  const { model, runs, cases, ctx, scrubber, recordingsDir } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const startedAt = new Date(now()).toISOString();
  const config = options.settings.config;
  const target = { kind: "live" as const, model, promptVersion: PROMPT_VERSION };
  const measures: PlanMeasure[] = [];
  let recordings = 0;
  let stopped: string | null = null;
  for (const caseDef of cases) {
    const shortlist = shortlistFor(caseDef.request, ctx);
    const hash = candidateHash(shortlist, ctx);
    const pending: Recording[] = [];
    for (let run = 1; run <= runs && stopped === null; run++) {
      const planStartedAt = now();
      const client = new RecordingClient(options.client, scrubber, { now, planStartedAt });
      const attempt = await runPlan(caseDef.request, client, ctx, { now, config });
      const recordedAt = new Date(now()).toISOString();
      client.calls.forEach((call, index) => {
        pending.push({
          format: RECORDING_FORMAT,
          ...target,
          caseId: caseDef.id,
          run,
          attempt: index + 1,
          recordedAt,
          candidateHash: hash,
          request: caseDef.request,
          limits: config,
          ...call,
        });
      });
      const latencyMs = attempt.ok ? attempt.outcome.itinerary.meta.latencyMs : 0;
      const measure = measurePipelinePlan(
        {
          caseId: caseDef.id,
          caseDef,
          run,
          attempt,
          calls: client.calls,
          shortlist,
          usage: { model, latencyMs, calls: client.calls },
          stale: false,
        },
        ctx,
      );
      measures.push(measure);
      log(progressLine(measure, runs));
      stopped = stopReason(client.calls);
    }
    if (stopped !== null) {
      log(`${caseDef.id}: not saved because the run stopped; its previous recordings are kept`);
      break;
    }
    // Decision: a case's recordings replace the previous ones only once all its runs finished.
    // A rejected key, a crash, or Ctrl-C part way through leaves the last good recordings (and
    // so the report built from them) as they were, and a paid run keeps every case it finished.
    recordings += replaceCaseRecordings(recordingsDir, target, caseDef.id, pending, scrubber);
  }
  const summary = summarize(measures);
  const resultsPath = join(
    options.resultsDir,
    `${startedAt.replace(/[:.]/g, "-")}-${folderName(model)}-${PROMPT_VERSION}.json`,
  );
  const results = scrubber.value({
    format: 1,
    kind: "live",
    model,
    promptVersion: PROMPT_VERSION,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
    runsPerCase: runs,
    cases: cases.map((c) => c.id),
    settings: { ...options.settings.config, effort: options.settings.effort },
    pricing: { checkedOn: PRICING_CHECKED_ON, source: PRICING_SOURCE, price: priceFor(model) },
    stopped,
    summary,
    plans: measures,
  });
  scrubber.assertClean(formatJson(results), resultsPath);
  writeJson(resultsPath, results);
  return { measures, summary, resultsPath, recordings, stopped };
}
