import type { TripRequest } from "@italy/planner";

// The contract between the plan pipeline and any model client (the real Claude API client, the
// scripted fixtures, the simulated client). The model only ever returns place ids, their order,
// short reasons, and a summary; code decides everything else.

/** What the model returns, after JSON parsing and schema validation. */
export interface LlmSelection {
  days: {
    anchorId: string; // one base per day
    placeIds: string[]; // stops in visiting order, meals included
    reasons: { placeId: string; reason: string }[]; // one short reason per stop
  }[];
  summary: string; // one or two sentences about the trip
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult {
  selection: LlmSelection | null; // null when the output was cut off, refused, or off-schema
  rawText: string; // the model's text output, used as the assistant turn of a repair
  schemaIssues: string[]; // why `selection` is null when the text did not match the schema
  usage: LlmUsage;
  latencyMs: number;
  model: string; // model id that answered (or "fixture")
  stopReason: string | null; // the API's stop_reason: end_turn, max_tokens, refusal, ...
}

/** One problem with the previous answer, as the repair turn lists it to the model. */
export interface RepairViolation {
  code: string; // violation code, e.g. CLOSED_AT_TIME, or SCHEMA_INVALID
  day?: number; // 0-based day index
  placeId?: string;
  detail: string;
}

export interface SelectInput {
  request: TripRequest; // the validated request (fixtures derive their answers from it)
  system: string; // system prompt
  user: string; // user message: dates, preferences, bases, candidates, notes
  timeoutMs: number; // longest this call may take
  signal: AbortSignal; // aborted when the call's time is up
}

export interface RepairInput extends SelectInput {
  previousText: string; // the model's previous answer, sent back as the assistant turn
  violations: RepairViolation[]; // what was wrong with it
  repairMessage: string; // the user turn listing the violations
}

export interface LlmClient {
  readonly model: string; // for logs, meta, and the cache key
  select(input: SelectInput): Promise<LlmResult>;
  repair(input: RepairInput): Promise<LlmResult>;
}
