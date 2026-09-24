import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { toLlmError } from "../../src/llm/anthropic";
import { fallbackReasonFor, LlmError } from "../../src/llm/errors";

// Failure vector F2: every SDK error class maps to a kind and a fallback reason by class, never by
// message text, and keeps the API's own details for the log line (never for the traveler).

describe("toLlmError", () => {
  const headers = new Headers();
  const cases: [string, unknown, string, string][] = [
    ["timeout", new Anthropic.APIConnectionTimeoutError(), "timeout", "timeout"],
    ["abort", new Anthropic.APIUserAbortError(), "timeout", "timeout"],
    [
      "connection",
      new Anthropic.APIConnectionError({ message: "ECONNRESET" }),
      "connection",
      "llm_error",
    ],
    [
      "429",
      new Anthropic.RateLimitError(429, undefined, "x", headers),
      "rate_limited",
      "rate_limited",
    ],
    [
      "529",
      new Anthropic.InternalServerError(529, undefined, "x", headers),
      "overloaded",
      "rate_limited",
    ],
    [
      "500",
      new Anthropic.InternalServerError(500, undefined, "x", headers),
      "server_error",
      "llm_error",
    ],
    ["401", new Anthropic.AuthenticationError(401, undefined, "x", headers), "auth", "llm_error"],
    ["403", new Anthropic.PermissionDeniedError(403, undefined, "x", headers), "auth", "llm_error"],
    [
      "400",
      new Anthropic.BadRequestError(400, undefined, "x", headers),
      "bad_request",
      "llm_error",
    ],
    ["404", new Anthropic.NotFoundError(404, undefined, "x", headers), "bad_request", "llm_error"],
    [
      "422",
      new Anthropic.UnprocessableEntityError(422, undefined, "x", headers),
      "bad_request",
      "llm_error",
    ],
    ["409", new Anthropic.ConflictError(409, undefined, "x", headers), "api_error", "llm_error"],
    ["TypeError", new TypeError("x"), "unknown", "llm_error"],
    ["string", "thrown string", "unknown", "llm_error"],
  ];

  for (const [name, error, kind, reason] of cases) {
    it(`maps ${name} to ${kind} and falls back with ${reason}, never a 500`, () => {
      const mapped = toLlmError(error);

      expect(mapped).toBeInstanceOf(LlmError);
      expect(mapped.kind).toBe(kind);
      expect(fallbackReasonFor(mapped.kind)).toBe(reason);
    });
  }

  it("keeps an LlmError as it is", () => {
    const error = new LlmError("timeout", "t");

    expect(toLlmError(error)).toBe(error);
  });

  it("uses fixed messages, so an SDK message carrying request details is not reused", () => {
    const sdkError = new Anthropic.BadRequestError(
      400,
      { message: "sk-ant-test-FAKE in body" },
      "x",
      headers,
    );

    expect(toLlmError(sdkError).message).not.toContain("sk-ant");
  });
});

describe("toLlmError details for the log line", () => {
  it("keeps the API's error type, request id, message, and retry-after from the response", () => {
    const sdkError = Anthropic.APIError.generate(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Slow down" } },
      undefined,
      new Headers({ "request-id": "req_test_1", "retry-after": "12" }),
    );

    const mapped = toLlmError(sdkError);

    expect(mapped).toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 12_000 });
    expect(mapped.detail).toEqual({
      type: "rate_limit_error",
      apiRequestId: "req_test_1",
      apiMessage: "Slow down",
    });
  });

  it("cuts a long API message, so one error cannot flood a log line", () => {
    const long = "x".repeat(1_000);
    const sdkError = Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message: long } },
      undefined,
      new Headers(),
    );

    expect(toLlmError(sdkError).detail.apiMessage).toHaveLength(200);
  });
});
