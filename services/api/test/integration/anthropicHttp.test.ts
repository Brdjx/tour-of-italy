import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TripRequestSchema } from "@italy/planner";
import { afterEach, describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import { createAnthropicClient, retryAfterMsOf } from "../../src/llm/anthropic";
import { planTrip } from "../../src/plan/planTrip";
import { START_DATE } from "../helpers/app";

// The real SDK client against a local fake Messages API (no network, no key). Fakes that throw
// LlmError directly cannot show what the SDK itself does with a 429's retry-after; this can.

const { ctx } = shippedData();

type Answer = { status: number; headers?: Record<string, string>; body: unknown };

let server: Server | undefined;

async function fakeApi(answer: Answer): Promise<{ baseURL: string; hits: () => number }> {
  let hits = 0;
  server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    hits++;
    res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}`, hits: () => hits };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function planAgainst(baseURL: string) {
  const llm = createAnthropicClient({
    apiKey: "sk-ant-test-key-for-fake-server",
    model: "claude-sonnet-5",
    effort: "low",
    baseURL,
  });
  const request = TripRequestSchema.parse({ startDate: START_DATE, pace: "balanced" });
  const started = Date.now();
  const outcome = await planTrip(request, {
    llm,
    ctx,
    now: () => Date.now(),
    config: { timeoutMs: 5_000, deadlineMs: 8_000, maxAttempts: 2 },
  });
  return { outcome, elapsed: Date.now() - started };
}

const rateLimitBody = {
  type: "error",
  error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" },
};

describe("the real SDK against a fake Messages API", () => {
  it("falls back at once with rate_limited on a 429 with retry-after 30, instead of sleeping it out as timeout", async () => {
    const api = await fakeApi({
      status: 429,
      headers: { "retry-after": "30" },
      body: rateLimitBody,
    });

    const { outcome, elapsed } = await planAgainst(api.baseURL);

    expect(outcome.itinerary.meta.fallbackReason).toBe("rate_limited");
    expect(outcome.trace.llmErrors).toEqual(["rate_limited"]);
    expect(api.hits()).toBe(1);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("logs the API's error type, request id, and message when it rejects the request", async () => {
    const api = await fakeApi({
      status: 400,
      headers: { "request-id": "req_test_1" },
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "output_config.effort: Extra inputs are not permitted",
        },
      },
    });

    const { outcome } = await planAgainst(api.baseURL);

    expect(outcome.itinerary.meta.fallbackReason).toBe("llm_error");
    expect(outcome.trace.llmFailures[0]).toMatchObject({
      kind: "bad_request",
      status: 400,
      type: "invalid_request_error",
      apiRequestId: "req_test_1",
      apiMessage: "output_config.effort: Extra inputs are not permitted",
    });
  });
});

describe("retryAfterMsOf", () => {
  it("reads retry-after-ms, retry-after in seconds, and retry-after as an HTTP date", () => {
    const now = Date.UTC(2026, 8, 23, 12);
    const at = new Date(now + 5_000).toUTCString();

    expect(retryAfterMsOf(new Headers({ "retry-after-ms": "250.5" }))).toBe(251);
    expect(retryAfterMsOf(new Headers({ "retry-after": "30" }))).toBe(30_000);
    expect(retryAfterMsOf(new Headers({ "retry-after": at }), now)).toBe(5_000);
    expect(retryAfterMsOf(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(retryAfterMsOf(undefined)).toBeUndefined();
  });
});
