import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { createLogger } from "../../src/lib/logger";

// Synthetic API Gateway v2 events for tests that call the Lambda handler directly.

export const ORIGIN_SECRET = "origin-secret-7f3a9c2e41";

/** A start date 30 days from the real clock, since the handler here uses Date.now. */
export const START = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

export type V2Event = {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  requestContext: { http: { method: string; path: string; sourceIp: string } } & Record<
    string,
    unknown
  >;
  body?: string;
  isBase64Encoded: boolean;
};

export function event(overrides: Partial<V2Event> = {}): LambdaEvent {
  return {
    version: "2.0",
    routeKey: "ANY /api/{proxy+}",
    rawPath: "/api/health",
    rawQueryString: "",
    headers: { "x-origin-verify": ORIGIN_SECRET, host: "abc.execute-api.us-east-1.amazonaws.com" },
    requestContext: {
      accountId: "123456789012",
      apiId: "abc",
      domainName: "abc.execute-api.us-east-1.amazonaws.com",
      domainPrefix: "abc",
      http: {
        method: "GET",
        path: "/api/health",
        protocol: "HTTP/1.1",
        sourceIp: "203.0.113.9",
        userAgent: "test",
      },
      requestId: "req-1",
      routeKey: "ANY /api/{proxy+}",
      stage: "$default",
      time: "23/Sep/2026:12:00:00 +0000",
      timeEpoch: Date.UTC(2026, 8, 23, 12),
    },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as LambdaEvent;
}

/** The request context of a POST to `path`. */
export function postContext(path: string): V2Event["requestContext"] {
  const base = (event() as unknown as V2Event).requestContext;
  return { ...base, http: { ...base.http, method: "POST", path } };
}

export const lambdaContext = {} as LambdaContext;
export const silent = createLogger({ sink: () => {} });
