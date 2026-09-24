import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config";
import { createLogger } from "../../src/lib/logger";
import { ROTATION_GRACE_MS } from "../../src/lib/originVerify";
import type { ParameterFetcher } from "../../src/lib/secrets";
import { createLambdaHandler, createRuntimeDeps } from "../../src/runtime";
import { tripBody } from "../helpers/app";
import {
  event,
  lambdaContext,
  ORIGIN_SECRET,
  postContext,
  START,
  silent,
} from "../helpers/lambdaEvents";
import { expectValidItinerary } from "../helpers/validPlan";

// Production wiring: the origin check (F5, fails closed), secrets from SSM (a fake fetcher, no
// AWS), and the Lambda handler with synthetic API Gateway v2 events.

const ORIGIN_PARAM = "/italy-planner/origin-verify-secret";
const KEY_PARAM = "/italy-planner/anthropic-api-key";

function prodConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "production",
    ORIGIN_VERIFY_PARAM: ORIGIN_PARAM,
    ANTHROPIC_API_KEY_PARAM: KEY_PARAM,
    GIT_SHA: "a".repeat(40),
    ...extra,
  });
}

function fakeSsm(values: Record<string, string | Error>): ParameterFetcher {
  return vi.fn(async (name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error("ParameterNotFound");
    if (value instanceof Error) throw value;
    return value;
  });
}

describe("origin verification in production", () => {
  async function health(fetch: ParameterFetcher, headers: Record<string, string>) {
    const handler = createLambdaHandler(prodConfig(), { fetchParameter: fetch, logger: silent });
    return handler(event({ headers: { ...headers } }), lambdaContext);
  }

  it("refuses a request with no origin header (a caller that bypassed CloudFront)", async () => {
    const res = await health(fakeSsm({ [ORIGIN_PARAM]: ORIGIN_SECRET }), {});

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? "{}").error.code).toBe("forbidden");
  });

  it("refuses a wrong origin header", async () => {
    const res = await health(fakeSsm({ [ORIGIN_PARAM]: ORIGIN_SECRET }), {
      "x-origin-verify": "guess",
    });

    expect(res.statusCode).toBe(403);
  });

  it("serves a request with the right origin header", async () => {
    const res = await health(fakeSsm({ [ORIGIN_PARAM]: ORIGIN_SECRET, [KEY_PARAM]: "k" }), {
      "x-origin-verify": ORIGIN_SECRET,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "{}")).toMatchObject({ ok: true, commit: "a".repeat(40) });
  });

  it("fails closed with 403 when SSM is down, even for health", async () => {
    const res = await health(fakeSsm({ [ORIGIN_PARAM]: new Error("ThrottlingException") }), {
      "x-origin-verify": ORIGIN_SECRET,
    });

    expect(res.statusCode).toBe(403);
  });

  it("accepts a rotated secret without a redeploy, and the old one only for the grace window", async () => {
    const values: Record<string, string> = { [ORIGIN_PARAM]: "secret-before-rotation" };
    let now = Date.UTC(2026, 8, 23, 12);
    const handler = createLambdaHandler(prodConfig(), {
      fetchParameter: async (name) => values[name] ?? "",
      logger: silent,
      now: () => now,
    });
    const call = (secret: string) =>
      handler(event({ headers: { "x-origin-verify": secret } }), lambdaContext);
    expect((await call("secret-before-rotation")).statusCode).toBe(200);

    values[ORIGIN_PARAM] = "secret-after-rotation";
    now += 11_000;

    expect((await call("secret-after-rotation")).statusCode).toBe(200);
    // CloudFront edges still sending the old header keep working while the change propagates.
    expect((await call("secret-before-rotation")).statusCode).toBe(200);
    now += ROTATION_GRACE_MS;
    expect((await call("secret-before-rotation")).statusCode).toBe(403);
    expect((await call("secret-after-rotation")).statusCode).toBe(200);
  });
});

describe("secrets in production", () => {
  it("plans without AI and says no_key when the key cannot be read from SSM", async () => {
    const handler = createLambdaHandler(prodConfig(), {
      fetchParameter: fakeSsm({
        [ORIGIN_PARAM]: ORIGIN_SECRET,
        [KEY_PARAM]: new Error("AccessDenied"),
      }),
      logger: silent,
    });
    const body = JSON.stringify(tripBody({ startDate: START }));

    const res = await handler(
      event({
        rawPath: "/api/plan",
        headers: { "x-origin-verify": ORIGIN_SECRET, "content-type": "application/json" },
        body,
        requestContext: postContext("/api/plan"),
      }),
      lambdaContext,
    );

    expect(res.statusCode).toBe(200);
    const itinerary = expectValidItinerary(JSON.parse(res.body ?? "{}"));
    expect(itinerary.meta.fallbackReason).toBe("no_key");
  });

  it("reports llmAvailable false on health when the key cannot be read", async () => {
    const deps = createRuntimeDeps(prodConfig(), {
      fetchParameter: fakeSsm({ [KEY_PARAM]: new Error("AccessDenied") }),
      logger: silent,
    });

    expect(await deps.llm?.status()).toEqual({ available: false, model: null });
  });

  it("registers secrets read from SSM for redaction", async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    const deps = createRuntimeDeps(prodConfig(), {
      fetchParameter: fakeSsm({
        [ORIGIN_PARAM]: ORIGIN_SECRET,
        [KEY_PARAM]: "plain-key-from-ssm-0042",
      }),
      logger,
    });
    await deps.llm?.status();
    await deps.originSecret?.get();

    logger.info("echo", { a: "plain-key-from-ssm-0042", b: ORIGIN_SECRET });

    expect(lines.join("\n")).not.toContain("plain-key-from-ssm-0042");
    expect(lines.join("\n")).not.toContain(ORIGIN_SECRET);
  });
});
