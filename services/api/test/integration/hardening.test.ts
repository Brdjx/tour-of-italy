import { describe, expect, it } from "vitest";
import { createTokenBucket } from "../../src/lib/rateLimit";
import { type SecretSource, staticSecret } from "../../src/lib/secrets";
import { FIXED_NOW, lastRequestLog, makeApp, postPlan, tripBody } from "../helpers/app";
import { ScriptedClient } from "../helpers/fakeClients";
import { expectValidItinerary } from "../helpers/validPlan";

// Guards added after review, end to end through app.request: HTTP caching of the read routes
// (every page load needs two of them), per-/64 rate limiting, server-chosen request ids, the
// origin check keyed on its parameter, and a plan deadline that counts from arrival.

describe("HTTP caching of the read routes", () => {
  for (const path of ["/api/meta", "/api/places", "/api/data-issues"]) {
    it(`lets browsers and CloudFront reuse ${path}, and answers a revalidation with a bodiless 304`, async () => {
      const { app } = makeApp();

      const first = await app.request(path);
      const etag = first.headers.get("etag") ?? "";
      const again = await app.request(path, { headers: { "if-none-match": etag } });

      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toMatch(/public, max-age=\d+/);
      expect(first.headers.get("content-type")).toMatch(/^application\/json/);
      expect(etag).toMatch(/^"[\w-]+"$/);
      expect(again.status).toBe(304);
      expect(await again.text()).toBe("");
    });
  }

  it("never lets a cache keep a plan, the health answer, or an error", async () => {
    const { app } = makeApp();

    const plan = await postPlan(app, tripBody(), { query: "mode=deterministic" });
    const health = await app.request("/api/health");
    const missing = await app.request("/api/nope");

    for (const res of [plan, health, missing]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("sends the full body again when the client's ETag is stale", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/meta", { headers: { "if-none-match": '"old-version"' } });

    expect(res.status).toBe(200);
    expect((await res.json()) as object).toHaveProperty("anchors");
  });
});

describe("per-client plan limit behind CloudFront", () => {
  it("counts every address in one IPv6 /64 as one client, so rotating addresses cannot bypass it", async () => {
    const rateLimiter = createTokenBucket({
      capacity: 2,
      refillPerMinute: 2,
      maxKeys: 100,
      now: () => FIXED_NOW,
    });
    const { app } = makeApp({ rateLimiter });
    const from = (host: string) => ({
      query: "mode=deterministic",
      headers: { "cloudfront-viewer-address": `2001:db8:1:2::${host}:51000` },
    });

    const statuses: number[] = [];
    for (const host of ["a", "b", "c"]) {
      statuses.push((await postPlan(app, tripBody(), from(host))).status);
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect(rateLimiter.size()).toBe(1);
  });
});

describe("request ids in production", () => {
  it("never echoes a client-chosen id, and logs it beside the one the server made", async () => {
    const { app, logs } = makeApp({
      env: { NODE_ENV: "production", ORIGIN_VERIFY_PARAM: "/italy-planner/o", LLM_MODE: "off" },
      originSecret: staticSecret("origin-secret-for-tests"),
    });

    const res = await app.request("/api/health", {
      headers: { "x-request-id": "copied-id-1", "x-origin-verify": "origin-secret-for-tests" },
    });

    const id = res.headers.get("x-request-id") ?? "";
    expect(id).not.toBe("copied-id-1");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lastRequestLog(logs)).toMatchObject({ requestId: id, clientRequestId: "copied-id-1" });
  });
});

describe("origin check", () => {
  it("runs whenever the origin parameter is set, even when NODE_ENV is not production", async () => {
    const { app } = makeApp({
      env: { NODE_ENV: "development", ORIGIN_VERIFY_PARAM: "/italy-planner/o" },
      originSecret: staticSecret("origin-secret-for-tests"),
    });

    const without = await app.request("/api/health");
    const withHeader = await app.request("/api/health", {
      headers: { "x-origin-verify": "origin-secret-for-tests" },
    });

    expect(without.status).toBe(403);
    expect(withHeader.status).toBe(200);
  });
});

describe("plan deadline", () => {
  it("counts from arrival, so a slow origin-secret read cannot push the answer past PLAN_DEADLINE_MS", async () => {
    let reads = 0;
    const slowSecret: SecretSource = {
      get: async () => {
        reads++;
        if (reads === 1) await new Promise((resolve) => setTimeout(resolve, 1000));
        return "origin-secret-for-tests";
      },
    };
    const hanging = new ScriptedClient(() => new Promise(() => {}));
    const { app } = makeApp({
      env: {
        ORIGIN_VERIFY_PARAM: "/italy-planner/o",
        LLM_TIMEOUT_MS: "2000",
        PLAN_DEADLINE_MS: "2500",
      },
      originSecret: slowSecret,
      client: hanging,
      now: () => Date.now(),
      // Decision: a 400 ms reserve keeps the test stable on a loaded CI machine. Without the fix
      // the model call alone would end at 1000 + 2000 ms, well past the 2500 ms deadline.
      timing: {
        reserveMs: 400,
        minCallMs: 100,
        minRepairMs: 100,
        retry: { defaultPauseMs: 10, maxPauseMs: 50 },
      },
    });
    const started = Date.now();

    const res = await postPlan(app, tripBody(), {
      headers: { "x-origin-verify": "origin-secret-for-tests" },
    });

    const itinerary = expectValidItinerary(await res.json());
    expect(itinerary.meta.fallbackReason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2500);
    // The latency the traveler sees includes the origin check, not only the model call.
    expect(itinerary.meta.latencyMs).toBeGreaterThanOrEqual(1000);
  });
});
