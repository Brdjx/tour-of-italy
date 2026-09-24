import { describe, expect, it } from "vitest";
import { canonicalJson, LruCache, planCacheKey } from "../../src/lib/cache";
import { createTokenBucket, PLAN_RATE_LIMIT } from "../../src/lib/rateLimit";

// Failure vector F5: cost runaway. The rate limiter caps plans per client; the cache keeps a
// repeated request from paying for the model twice, and must never be poisonable.

describe("token bucket rate limiter", () => {
  it("allows 10 plans a minute per client and refuses the 11th", () => {
    let now = 0;
    const limiter = createTokenBucket({ ...PLAN_RATE_LIMIT, now: () => now });

    const decisions = Array.from({ length: 11 }, () => limiter.take("203.0.113.1"));

    expect(decisions.slice(0, 10).every((d) => d.allowed)).toBe(true);
    expect(decisions[10]).toMatchObject({ allowed: false, remaining: 0 });
    expect(decisions[10]?.retryAfterSec).toBeGreaterThanOrEqual(1);
    now += 6_000;
    expect(limiter.take("203.0.113.1").allowed).toBe(true);
  });

  it("keeps clients apart, so one noisy client cannot lock out another", () => {
    const limiter = createTokenBucket({ ...PLAN_RATE_LIMIT, now: () => 0 });
    for (let i = 0; i < 10; i++) limiter.take("a");

    expect(limiter.take("a").allowed).toBe(false);
    expect(limiter.take("b").allowed).toBe(true);
  });

  it("refills to the burst size after a quiet minute, never above it", () => {
    let now = 0;
    const limiter = createTokenBucket({ ...PLAN_RATE_LIMIT, now: () => now });
    for (let i = 0; i < 10; i++) limiter.take("a");
    now += 60 * 60_000;

    const decisions = Array.from({ length: 11 }, () => limiter.take("a"));

    expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
  });

  it("stays bounded in memory under a flood of distinct addresses", () => {
    const limiter = createTokenBucket({
      capacity: 10,
      refillPerMinute: 10,
      maxKeys: 50,
      now: () => 0,
    });

    for (let i = 0; i < 10_000; i++) limiter.take(`10.0.${i >> 8}.${i & 255}`);

    expect(limiter.size()).toBe(50);
  });
});

describe("plan cache", () => {
  it("returns copies, so editing a returned plan cannot poison the next caller", () => {
    const cache = new LruCache<{ days: string[] }>(10);
    const stored = { days: ["rome"] };
    cache.set("k", stored);
    stored.days.push("mutated after set");

    const first = cache.get("k");
    first?.days.push("mutated after get");

    expect(cache.get("k")).toEqual({ days: ["rome"] });
  });

  it("drops the least recently used entry when full", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it("refuses a zero-size cache instead of silently caching nothing", () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
  });

  it("keys on prompt version, model, and the canonical request", () => {
    const request = { pace: "balanced", interests: ["art"] };
    const base = planCacheKey({ promptVersion: "v1", model: "m", request });

    expect(planCacheKey({ promptVersion: "v2", model: "m", request })).not.toBe(base);
    expect(planCacheKey({ promptVersion: "v1", model: "other", request })).not.toBe(base);
    expect(
      planCacheKey({ promptVersion: "v1", model: "m", request: { ...request, pace: "packed" } }),
    ).not.toBe(base);
    expect(
      planCacheKey({
        promptVersion: "v1",
        model: "m",
        request: { interests: ["art"], pace: "balanced" },
      }),
    ).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sorts object keys at every level but keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    expect(canonicalJson(undefined)).toBe("null");
  });
});
