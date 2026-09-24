import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { createLambdaHandler } from "../../src/runtime";
import { tripBody } from "../helpers/app";
import { event, lambdaContext, postContext, START, silent } from "../helpers/lambdaEvents";
import { expectValidItinerary } from "../helpers/validPlan";

// The Lambda entry wiring with synthetic API Gateway v2 events: base64 bodies, query strings,
// header casing, and JSON errors through the adapter.

describe("Lambda handler with API Gateway v2 events", () => {
  const devHandler = () =>
    createLambdaHandler(loadConfig({ NODE_ENV: "test", LLM_MODE: "off" }), { logger: silent });

  it("decodes a base64 body and reads the query string", async () => {
    const body = Buffer.from(JSON.stringify(tripBody({ startDate: START }))).toString("base64");

    const res = await devHandler()(
      event({
        rawPath: "/api/plan",
        rawQueryString: "mode=deterministic",
        queryStringParameters: { mode: "deterministic" },
        headers: { "Content-Type": "application/json" },
        body,
        isBase64Encoded: true,
        requestContext: postContext("/api/plan"),
      }),
      lambdaContext,
    );

    expect(res.statusCode).toBe(200);
    const itinerary = expectValidItinerary(JSON.parse(res.body ?? "{}"));
    expect(itinerary.meta.fallbackReason).toBe("requested");
  });

  it("treats header names case-insensitively", async () => {
    const res = await devHandler()(
      event({ headers: { "X-Request-Id": "Case-Test-1" } }),
      lambdaContext,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["x-request-id"]).toBe("Case-Test-1");
  });

  it("answers unknown paths with a JSON 404 through the handler", async () => {
    const res = await devHandler()(
      event({
        rawPath: "/api/unknown",
        requestContext: {
          ...postContext("/api/unknown"),
          http: { method: "GET", path: "/api/unknown", sourceIp: "203.0.113.9" },
        },
      }),
      lambdaContext,
    );

    expect(res.statusCode).toBe(404);
    expect(res.headers?.["content-type"]).toContain("application/json");
  });

  it("rate-limits by the CloudFront viewer address, not the edge server's IP", async () => {
    const handler = devHandler();
    const post = (viewer: string) =>
      handler(
        event({
          rawPath: "/api/plan",
          rawQueryString: "mode=deterministic",
          headers: {
            "content-type": "application/json",
            "cloudfront-viewer-address": `${viewer}:443`,
          },
          body: JSON.stringify(tripBody({ startDate: START })),
          requestContext: postContext("/api/plan"),
        }),
        lambdaContext,
      );

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post("198.51.100.1")).statusCode ?? 0);
    const other = await post("198.51.100.2");

    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(other.statusCode).toBe(200);
  });
});
