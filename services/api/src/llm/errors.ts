import type { FallbackReason } from "@italy/planner";

// One error type for every model-call failure, so the plan pipeline decides on a kind instead of
// inspecting SDK classes or messages. anthropic.ts maps SDK errors to these kinds.

export const LLM_ERROR_KINDS = [
  "timeout", // the call ran out of time (our timer or the SDK's)
  "rate_limited", // 429
  "overloaded", // 529
  "server_error", // other 5xx
  "connection", // network failure before a response
  "auth", // 401 or 403: the key is wrong or lacks access
  "bad_request", // 400, 404, 413, 422: the request itself is wrong
  "api_error", // any other API status
  "unknown", // anything that is not an SDK error
] as const;

export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];

/** What the API said about a failed call, kept for the log line (never shown to travelers). */
export interface LlmErrorDetail {
  type?: string; // the API's error type, e.g. "invalid_request_error"
  apiRequestId?: string; // Anthropic's request id, for a support ticket
  apiMessage?: string; // the API's own message, cut to API_MESSAGE_CHARS
}

/** Longest API error message kept in a log line. */
export const API_MESSAGE_CHARS = 200;

export class LlmError extends Error {
  override name = "LlmError";
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined; // how long the API asked us to wait, when it said
  readonly detail: LlmErrorDetail;

  constructor(
    kind: LlmErrorKind,
    message: string,
    options: {
      status?: number;
      cause?: unknown;
      retryAfterMs?: number;
      detail?: LlmErrorDetail;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail ?? {};
  }
}

/**
 * One failed call as the request log line records it: kind, status, the API's error type,
 * request id, and message. The logger redacts keys and registered secrets from all of it.
 */
export function describeLlmFailure(error: unknown): Record<string, unknown> {
  if (error instanceof LlmError) {
    return {
      kind: error.kind,
      status: error.status,
      retryAfterMs: error.retryAfterMs,
      ...error.detail,
      message: error.message,
    };
  }
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "unknown", name, message: message.slice(0, API_MESSAGE_CHARS) };
}

/** When a failed call is worth one more try, and how long to pause first. */
export interface RetryPolicy {
  defaultPauseMs: number; // pause when the API did not say how long to wait
  maxPauseMs: number; // a longer requested wait means no retry
}

// Decision: one retry for failures that are usually brief: a dropped connection (often a stale
// keep-alive socket after Lambda froze the instance), a 5xx, or 529 overloaded. A 429 is retried
// only when the API says the wait is short. Anything longer falls back to rules-only at once
// instead of holding the request (the SDK itself never retries; see anthropic.ts).
export function retryPauseMs(error: unknown, policy: RetryPolicy): number | null {
  if (!(error instanceof LlmError)) return null;
  const { kind, retryAfterMs } = error;
  const transient = kind === "connection" || kind === "server_error" || kind === "overloaded";
  if (!transient && kind !== "rate_limited") return null;
  if (retryAfterMs !== undefined) return retryAfterMs <= policy.maxPauseMs ? retryAfterMs : null;
  return transient ? policy.defaultPauseMs : null;
}

/** The fallback reason a failed call leads to. */
export function fallbackReasonFor(kind: LlmErrorKind): FallbackReason {
  if (kind === "timeout") return "timeout";
  if (kind === "rate_limited" || kind === "overloaded") return "rate_limited";
  return "llm_error";
}

/** The kind of any thrown value: an LlmError keeps its kind; anything else is "unknown". */
export function errorKindOf(error: unknown): LlmErrorKind {
  return error instanceof LlmError ? error.kind : "unknown";
}
