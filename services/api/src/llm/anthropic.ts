import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmResult, RepairInput, SelectInput } from "./client";
import { API_MESSAGE_CHARS, LlmError, type LlmErrorDetail } from "./errors";
import { type Effort, settingsFor } from "./models";
import { parseSelectionText, SELECTION_JSON_SCHEMA } from "./schema";

// The real Claude API client. One messages.create call per attempt, with structured outputs
// (output_config.format json_schema) so the answer is JSON in the text block. Every failure
// becomes an LlmError with a kind; every answer is checked for stop_reason and then parsed with
// Zod. Nothing here decides whether the plan is good; plan/planTrip.ts does.

/** The part of the SDK client this module calls, so tests can pass a fake. */
export interface MessagesApi {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): PromiseLike<Anthropic.Message>;
  };
}

export interface AnthropicClientOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  sdk?: MessagesApi; // injected in tests; built from apiKey otherwise
  baseURL?: string; // a local fake Messages API in tests; the real API otherwise
  now?: () => number;
}

// Decision: the SDK never retries. Its retry sleeps for the full retry-after the API sends (20 s
// on a busy 429), which only our per-call timer would cut short, so a rate-limited plan would
// wait out LLM_TIMEOUT_MS and be labelled timeout. planTrip retries a short failure itself, with
// the deadline in view (see retryPauseMs in errors.ts).
const SDK_MAX_RETRIES = 0;

export function createAnthropicClient(options: AnthropicClientOptions): LlmClient {
  const sdk: MessagesApi =
    options.sdk ??
    new Anthropic({
      apiKey: options.apiKey,
      maxRetries: SDK_MAX_RETRIES,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });
  const now = options.now ?? Date.now;
  const settings = settingsFor(options.model, options.effort);

  const call = async (
    input: SelectInput,
    messages: Anthropic.MessageParam[],
  ): Promise<LlmResult> => {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: options.model,
      max_tokens: settings.maxTokens,
      system: input.system,
      messages,
      output_config: {
        format: { type: "json_schema", schema: SELECTION_JSON_SCHEMA as Record<string, unknown> },
        ...(settings.effort === undefined ? {} : { effort: settings.effort }),
      },
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    };
    const started = now();
    let message: Anthropic.Message;
    try {
      message = await sdk.messages.create(params, {
        timeout: input.timeoutMs,
        signal: input.signal,
        maxRetries: SDK_MAX_RETRIES,
      });
    } catch (error) {
      throw toLlmError(error);
    }
    return toResult(message, now() - started);
  };

  return {
    model: options.model,
    select: (input) => call(input, [{ role: "user", content: input.user }]),
    repair: (input: RepairInput) =>
      call(input, [
        { role: "user", content: input.user },
        // Decision: the previous answer goes back as plain assistant text. The API rejects an
        // empty text block, so an empty answer is sent as "{}".
        { role: "assistant", content: input.previousText.slice(0, 20_000) || "{}" },
        { role: "user", content: input.repairMessage },
      ]),
  };
}

/** The text of the first text block, or "" when there is none. */
export function textOf(message: Anthropic.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/** An API response as an LlmResult. Refusals and cut-off answers never reach the parser. */
export function toResult(message: Anthropic.Message, latencyMs: number): LlmResult {
  const rawText = textOf(message);
  const usage = {
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0,
  };
  const base = { rawText, usage, latencyMs, model: message.model, stopReason: message.stop_reason };
  if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") {
    return { ...base, selection: null, schemaIssues: [] };
  }
  const parsed = parseSelectionText(rawText);
  if (parsed.ok) return { ...base, selection: parsed.selection, schemaIssues: [] };
  return { ...base, selection: null, schemaIssues: parsed.issues };
}

/** The wait the API asked for, from retry-after-ms or retry-after (seconds or an HTTP date). */
export function retryAfterMsOf(
  headers: Headers | undefined,
  nowMs = Date.now(),
): number | undefined {
  const ms = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
  const text = headers?.get("retry-after");
  if (text === null || text === undefined || text.trim() === "") return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/** The API's error type, request id, and message, for the log line. */
function detailOf(error: InstanceType<typeof Anthropic.APIError>): LlmErrorDetail {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const apiMessage = typeof body?.error?.message === "string" ? body.error.message : error.message;
  return {
    ...(error.type ? { type: error.type } : {}),
    ...(error.requestID ? { apiRequestId: error.requestID } : {}),
    ...(apiMessage ? { apiMessage: apiMessage.slice(0, API_MESSAGE_CHARS) } : {}),
  };
}

/**
 * Maps SDK errors to LlmError kinds by class, most specific first, never by message text.
 * APIConnectionTimeoutError and APIUserAbortError extend APIConnectionError/APIError, so they are
 * checked first.
 */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (!(error instanceof Anthropic.APIError)) {
    return new LlmError("unknown", "Unexpected error while calling the model", { cause: error });
  }
  const retryAfterMs = retryAfterMsOf(error.headers);
  const make = (kind: LlmError["kind"], message: string, status?: number) =>
    new LlmError(kind, message, { status, cause: error, retryAfterMs, detail: detailOf(error) });
  if (error instanceof Anthropic.APIConnectionTimeoutError)
    return make("timeout", "Model call timed out");
  if (error instanceof Anthropic.APIUserAbortError)
    return make("timeout", "Model call was aborted");
  if (error instanceof Anthropic.APIConnectionError)
    return make("connection", "Could not reach the model API");
  if (error instanceof Anthropic.RateLimitError)
    return make("rate_limited", "Model API rate limit", 429);
  if (error instanceof Anthropic.AuthenticationError)
    return make("auth", "Model API rejected the key", 401);
  if (error instanceof Anthropic.PermissionDeniedError)
    return make("auth", "Model API denied access", 403);
  if (error instanceof Anthropic.BadRequestError)
    return make("bad_request", "Model API rejected the request", 400);
  if (error instanceof Anthropic.NotFoundError) return make("bad_request", "Model not found", 404);
  if (error instanceof Anthropic.UnprocessableEntityError) {
    return make("bad_request", "Model API could not process the request", 422);
  }
  if (error instanceof Anthropic.InternalServerError) {
    // Decision: 529 is "overloaded", a typed status on the error, not a message to match.
    if (error.status === 529) return make("overloaded", "Model API is overloaded", 529);
    return make("server_error", "Model API server error", error.status);
  }
  return make("api_error", "Model API error", error.status ?? undefined);
}
