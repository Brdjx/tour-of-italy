import { toResult } from "@italy/api/llm/anthropic";
import type { LlmClient, LlmResult, RepairInput, SelectInput } from "@italy/api/llm/client";
import { LlmError } from "@italy/api/llm/errors";
import type { CallRecord, RecordedError, RecordedResponse, Recording } from "./recording";
import { ReplayClock } from "./replayClock";
import type { Scrubber } from "./scrub";

// The two model clients the eval puts in front of the production pipeline:
// - RecordingClient wraps the real client and notes every call, as the pipeline saw it;
// - ReplayClient answers from recordings, with no network.
// planTrip cannot tell either apart from the client it uses in production.

type Turn = CallRecord["turn"];

const MESSAGE_CHARS = 300;

/** The recorded form of a failed call: kind, status, and a scrubbed message. */
export function errorRecord(error: unknown, scrubber: Scrubber): RecordedError {
  if (error instanceof LlmError) {
    const { type, apiMessage } = error.detail;
    const api = apiMessage === undefined ? "" : ` (${type ?? "api"}: ${apiMessage})`;
    return {
      kind: error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      message: scrubber.text(`${error.message}${api}`).slice(0, MESSAGE_CHARS),
    };
  }
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "unknown", message: scrubber.text(`${name}: ${message}`).slice(0, MESSAGE_CHARS) };
}

function responseRecord(result: LlmResult): RecordedResponse {
  return {
    rawText: result.rawText,
    stopReason: result.stopReason,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    latencyMs: result.latencyMs,
    model: result.model,
  };
}

const LATE: RecordedError = { kind: "timeout", message: "No answer before the call's time limit" };

export interface RecordingClientOptions {
  now?: () => number; // the clock the pipeline uses
  planStartedAt?: number; // when the plan started on that clock; each call records its offset
}

/** Wraps a model client and records each call in order. */
export class RecordingClient implements LlmClient {
  readonly model: string;
  readonly calls: CallRecord[] = [];
  private readonly now: () => number;
  private readonly planStartedAt: number | undefined;

  constructor(
    private readonly inner: LlmClient,
    private readonly scrubber: Scrubber,
    options: RecordingClientOptions = {},
  ) {
    this.model = inner.model;
    this.now = options.now ?? Date.now;
    this.planStartedAt = options.planStartedAt;
  }

  select(input: SelectInput): Promise<LlmResult> {
    return this.#capture("select", input.signal, () => this.inner.select(input));
  }

  repair(input: RepairInput): Promise<LlmResult> {
    return this.#capture("repair", input.signal, () => this.inner.repair(input));
  }

  async #capture(turn: Turn, signal: AbortSignal, call: () => Promise<LlmResult>) {
    const started = this.now();
    const elapsed = () => Math.max(0, this.now() - started);
    // Decision: the slot is taken when the call starts, so calls stay in the order the pipeline
    // made them, and a call that never settles is recorded as the timeout the pipeline saw.
    const offset =
      this.planStartedAt === undefined
        ? {}
        : { startedAfterMs: Math.max(0, started - this.planStartedAt) };
    const record: CallRecord = { turn, ...offset, error: LATE };
    this.calls.push(record);
    // The time limit's abort also stamps the duration, for a client that ignores the signal and
    // never settles; a settled call overwrites it below.
    const stampTimeout = () => {
      if (record.response === undefined) record.error = { ...LATE, latencyMs: elapsed() };
    };
    signal.addEventListener("abort", stampTimeout, { once: true });
    try {
      const result = await call();
      // An answer that arrives after the pipeline gave up on the call was never used. Recording
      // it as an answer would make the replay succeed where the live run timed out.
      if (signal.aborted) record.error = { ...LATE, latencyMs: elapsed() };
      else {
        record.response = responseRecord(result);
        delete record.error;
      }
      return result;
    } catch (error) {
      // Decision: a failed call keeps how long it took. A timeout is the slowest outcome a
      // traveler sees, and leaving it out would make the latency tail look better than it is.
      const failure = signal.aborted ? LATE : errorRecord(error, this.scrubber);
      record.error = { ...failure, latencyMs: elapsed() };
      throw error;
    }
  }
}

/** Thrown when the pipeline asks for more calls than the run recorded. */
export class ReplayExhaustedError extends Error {
  override name = "ReplayExhaustedError";
}

/**
 * The recorded response as the real client would have returned it.
 */
// Decision: parse through the real client's toResult, so a replayed answer meets exactly the
// stop_reason checks and schema parsing a live answer meets today, not the ones it met when it
// was recorded. The cast is safe because toResult reads only these fields.
export function resultFromRecording(response: RecordedResponse): LlmResult {
  const message = {
    content: [{ type: "text", text: response.rawText }],
    usage: { input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens },
    model: response.model,
    stop_reason: response.stopReason,
  } as unknown as Parameters<typeof toResult>[0];
  return toResult(message, response.latencyMs);
}

/** How long a recorded call ran, answered or failed. */
function recordedLatencyMs(recorded: Recording): number {
  return recorded.response?.latencyMs ?? recorded.error?.latencyMs ?? 0;
}

/**
 * Answers each call with the next recorded attempt of one run. Never touches the network. With a
 * clock, each answer moves it to when the recorded call ended.
 */
export class ReplayClient implements LlmClient {
  readonly calls: CallRecord[] = [];
  missingCalls = 0; // calls the pipeline made that the run never recorded
  turnMismatches = 0; // calls where the pipeline asked for a different turn than recorded
  #next = 0;

  constructor(
    private readonly attempts: readonly Recording[],
    readonly model: string,
    private readonly clock: ReplayClock = new ReplayClock(0),
  ) {}

  select(_input: SelectInput): Promise<LlmResult> {
    return this.#serve("select");
  }

  repair(_input: RepairInput): Promise<LlmResult> {
    return this.#serve("repair");
  }

  async #serve(turn: Turn): Promise<LlmResult> {
    const recorded = this.attempts[this.#next++];
    if (recorded === undefined) {
      this.missingCalls++;
      const error: RecordedError = { kind: "unknown", message: "No recorded answer for this call" };
      this.calls.push({ turn, error });
      throw new ReplayExhaustedError(error.message);
    }
    if (recorded.turn !== turn) this.turnMismatches++;
    // Decision: the replayed clock jumps to when the recorded call ended (its recorded start, or
    // the end of the previous call, plus its duration), so the pipeline's next deadline check
    // sees the time the live run saw. A frozen clock would grant a repair the live run never had
    // time for, and report the missing answer as an error instead of the timeout it was.
    const start = recorded.startedAfterMs ?? this.clock.elapsedMs;
    this.clock.advanceTo(start + recordedLatencyMs(recorded));
    if (recorded.error !== undefined) {
      const { kind, message, status, retryAfterMs } = recorded.error;
      this.calls.push({ turn, error: recorded.error });
      throw new LlmError(kind, message, { status, retryAfterMs });
    }
    const response = recorded.response as RecordedResponse;
    this.calls.push({ turn, response });
    return resultFromRecording(response);
  }
}
