import { LLM_ERROR_KINDS } from "@italy/api/llm/errors";
import { FALLBACK_REASONS, PLAN_SOURCES, TripRequestSchema } from "@italy/planner";
import { z } from "zod";

// One recording is one model call: what the pipeline sent (the request and a hash of the
// candidates the model was shown), when it started and how long it ran, and what came back (the
// raw text, or the error). A plan's calls are attempts 1..n of one run. Recordings never hold
// keys, headers, or the prompt text.

/**
 * - live: a real model answered (written by `pnpm eval`).
 * - simulated: the scripted client answered offline; never model behavior.
 * - adversarial: a hand-written bad answer that exercises repair and fallback.
 */
export const RECORDING_KINDS = ["live", "simulated", "adversarial"] as const;
export type RecordingKind = (typeof RECORDING_KINDS)[number];

export const RECORDING_FORMAT = 1;

export const RecordedResponseSchema = z.strictObject({
  rawText: z.string(), // the model's text exactly as returned
  stopReason: z.string().nullable(), // end_turn, max_tokens, refusal, ...
  usage: z.strictObject({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
  }),
  latencyMs: z.number().min(0), // time for this call
  model: z.string(), // the model id the API reported
});

export const RecordedErrorSchema = z.strictObject({
  kind: z.enum(LLM_ERROR_KINDS), // how the pipeline classified the failure
  status: z.number().int().optional(), // HTTP status when there was one
  retryAfterMs: z.number().min(0).optional(), // the wait the API asked for
  message: z.string().max(500), // scrubbed, for a person reading the file
  latencyMs: z.number().min(0).optional(), // how long the call ran before it failed
});

/** The pipeline limits a live run used (LLM_TIMEOUT_MS, PLAN_DEADLINE_MS, LLM_MAX_ATTEMPTS). */
export const RecordedLimitsSchema = z.strictObject({
  timeoutMs: z.number().int().positive(),
  deadlineMs: z.number().int().positive(),
  maxAttempts: z.number().int().min(1),
});

/** What an adversarial run exercises and how the pipeline should end. Only on attempt 1. */
export const ScenarioSchema = z.strictObject({
  name: z.string().min(1),
  note: z.string().min(1),
  expectSource: z.enum(PLAN_SOURCES),
  expectFallbackReason: z.enum(FALLBACK_REASONS).optional(),
});

export const RecordingSchema = z
  .strictObject({
    format: z.literal(RECORDING_FORMAT),
    kind: z.enum(RECORDING_KINDS),
    caseId: z.string().min(1),
    run: z.number().int().min(1),
    attempt: z.number().int().min(1),
    turn: z.enum(["select", "repair"]), // the first answer or a repair
    model: z.string().min(1), // the model asked ("simulated" for the scripted client)
    promptVersion: z.string().min(1),
    recordedAt: z.iso.datetime(),
    candidateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    request: TripRequestSchema,
    // Live runs only: the limits the run had, so a replay takes the same deadline decisions.
    limits: RecordedLimitsSchema.optional(),
    // When the call started, in ms after the plan started. Without it, a replay starts each call
    // when the previous one ended.
    startedAfterMs: z.number().min(0).optional(),
    response: RecordedResponseSchema.optional(),
    error: RecordedErrorSchema.optional(),
    scenario: ScenarioSchema.optional(),
  })
  .refine((r) => (r.response === undefined) !== (r.error === undefined), {
    message: "A recording holds either a response or an error",
  });

export type Recording = z.output<typeof RecordingSchema>;
export type RecordedResponse = z.output<typeof RecordedResponseSchema>;
export type RecordedError = z.output<typeof RecordedErrorSchema>;
export type RecordedLimits = z.output<typeof RecordedLimitsSchema>;
export type Scenario = z.output<typeof ScenarioSchema>;

/** One call as a recording or replay client saw it. */
export interface CallRecord {
  turn: "select" | "repair";
  startedAfterMs?: number; // when the call started, after the plan started
  response?: RecordedResponse;
  error?: RecordedError;
}

/** A model id made safe as a folder name. */
export function folderName(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

/**
 * The folder for one kind, model, and prompt version, relative to the recordings root:
 * live runs under the model id, the offline sets under their kind.
 */
export function recordingFolder(kind: RecordingKind, model: string, promptVersion: string) {
  return `${kind === "live" ? folderName(model) : kind}/${folderName(promptVersion)}`;
}

/**
 * `<caseId>-<run>-<attempt>.json` for live recordings. Simulated and adversarial files carry
 * their kind in the name too (`.simulated.json`), so nobody mistakes one for model output.
 */
export function recordingFileName(r: Pick<Recording, "kind" | "caseId" | "run" | "attempt">) {
  const suffix = r.kind === "live" ? "" : `.${r.kind}`;
  return `${r.caseId}-${r.run}-${r.attempt}${suffix}.json`;
}

/** Recordings of one run (one plan), in attempt order. */
export interface RecordedRun {
  kind: RecordingKind;
  model: string;
  promptVersion: string;
  caseId: string;
  run: number;
  attempts: Recording[];
}

/**
 * Groups recordings into runs. Throws when a run's attempts are not exactly 1..n or disagree on
 * the request, since replaying a mixed or partial set would measure something that never happened.
 */
export function groupRuns(recordings: readonly Recording[]): RecordedRun[] {
  const byKey = new Map<string, Recording[]>();
  for (const r of recordings) {
    const key = [r.kind, r.model, r.promptVersion, r.caseId, r.run].join("|");
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const runs: RecordedRun[] = [];
  for (const [key, list] of byKey) {
    const attempts = [...list].sort((a, b) => a.attempt - b.attempt);
    attempts.forEach((r, index) => {
      if (r.attempt !== index + 1) throw new Error(`${key}: attempt ${index + 1} is missing`);
    });
    const first = attempts[0] as Recording;
    const request = JSON.stringify(first.request);
    if (attempts.some((r) => JSON.stringify(r.request) !== request)) {
      throw new Error(`${key}: attempts were recorded for different requests`);
    }
    const { kind, model, promptVersion, caseId, run } = first;
    runs.push({ kind, model, promptVersion, caseId, run, attempts });
  }
  return runs.sort(compareRuns);
}

function compareRuns(a: RecordedRun, b: RecordedRun): number {
  const ka = `${a.kind}|${a.model}|${a.promptVersion}|${a.caseId}`;
  const kb = `${b.kind}|${b.model}|${b.promptVersion}|${b.caseId}`;
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.run - b.run;
}
