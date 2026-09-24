// In-memory token bucket per client, for POST /api/plan. Each Lambda instance has its own map,
// so this is a per-instance guard; API Gateway throttling and the WAF's per-IP rule are the real
// limits. It exists so one client cannot run up the Claude bill through a warm instance.

export interface RateDecision {
  allowed: boolean;
  remaining: number; // whole tokens left after this request
  retryAfterSec: number; // seconds until one token is back, 0 when allowed
}

export interface RateLimiter {
  take(key: string): RateDecision;
  size(): number; // tracked clients, for tests and bounds checks
}

export interface TokenBucketOptions {
  capacity: number; // burst size, and the most tokens a client can hold
  refillPerMinute: number; // tokens added per minute
  maxKeys: number; // most clients tracked at once; the least recently seen is dropped first
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** The plan route's limit: 10 plans per minute per client. */
export const PLAN_RATE_LIMIT = { capacity: 10, refillPerMinute: 10, maxKeys: 5000 } as const;

export function createTokenBucket(options: TokenBucketOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const perMs = options.refillPerMinute / 60_000;
  const buckets = new Map<string, Bucket>();

  const refill = (bucket: Bucket, at: number): void => {
    const elapsed = Math.max(0, at - bucket.updatedAt);
    bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * perMs);
    bucket.updatedAt = at;
  };

  // Decision: least-recently-seen eviction keeps memory bounded under a flood of distinct
  // addresses. Evicting a client resets its bucket, which only ever errs toward allowing.
  const touch = (key: string, bucket: Bucket): void => {
    buckets.delete(key);
    buckets.set(key, bucket);
    while (buckets.size > options.maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  };

  return {
    take(key) {
      const at = now();
      const bucket = buckets.get(key) ?? { tokens: options.capacity, updatedAt: at };
      refill(bucket, at);
      touch(key, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSec: 0 };
      }
      const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    },
    size: () => buckets.size,
  };
}
