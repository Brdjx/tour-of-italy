import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./appEnv";
import { sendError } from "./httpErrors";
import type { SecretSource } from "./secrets";

// Production only: every /api request must carry x-origin-verify with the secret CloudFront adds.
// Callers that go around CloudFront (the raw execute-api URL) get 403, which also keeps them away
// from the WAF-free path to the Claude bill. Health is included: the deploy smoke test expects
// the direct URL to answer 403.

export const ORIGIN_HEADER = "x-origin-verify";

/**
 * Constant-time comparison. Both sides are hashed first, so the compare never leaks the secret's
 * length and timingSafeEqual always gets equal-length buffers.
 */
export function secretsMatch(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Why a request was refused, for the log line only (the response always says "Forbidden"). */
export type OriginRefusal = "missing_header" | "secret_unavailable" | "mismatch";

export type OriginCheck = (header: string | undefined) => Promise<OriginRefusal | null>;

export interface OriginCheckOptions {
  now?: () => number;
  graceMs?: number; // how long the previous secret keeps working after a change is seen
}

// Decision: after this instance sees the secret change, the previous value keeps working for 15
// minutes. Terraform changes SSM and the CloudFront header in one apply, but CloudFront edges
// take minutes to pick up the new header; without the grace window every rotation refuses real
// traffic until they do. An instance that starts after the change never saw the old value and
// cannot honor it (see the open issue in the api decisions).
export const ROTATION_GRACE_MS = 15 * 60_000;

/** A header check that remembers the value before the latest change seen, for the grace window. */
export function createOriginCheck(secret: SecretSource, options: OriginCheckOptions = {}) {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? ROTATION_GRACE_MS;
  let latest: string | null = null;
  let previous: { value: string; until: number } | null = null;

  const observe = (value: string | null): void => {
    if (value === null) return;
    if (latest !== null && value !== latest) previous = { value: latest, until: now() + graceMs };
    latest = value;
  };
  const matchesPrevious = (header: string): boolean =>
    previous !== null && now() < previous.until && secretsMatch(header, previous.value);

  const check: OriginCheck = async (header) => {
    if (header === undefined || header === "") return "missing_header";
    const current = await secret.get();
    observe(current);
    if (current === null) return "secret_unavailable";
    if (secretsMatch(header, current) || matchesPrevious(header)) return null;
    // Decision: one forced re-read on a mismatch, so a rotated secret works within seconds instead
    // of waiting out the cache TTL. createCachedSecret rate-limits these re-reads.
    const refreshed = await secret.get({ forceRefresh: true });
    observe(refreshed);
    if (refreshed !== null && secretsMatch(header, refreshed)) return null;
    return matchesPrevious(header) ? null : "mismatch";
  };
  return check;
}

/**
 * The middleware. `secret` null means no secret source is configured: in production that refuses
 * everything (fail closed).
 */
export function originVerify(
  secret: SecretSource | null,
  options: OriginCheckOptions = {},
): MiddlewareHandler<AppEnv> {
  const check = secret === null ? null : createOriginCheck(secret, options);
  return async (c, next) => {
    const refusal =
      check === null ? "secret_unavailable" : await check(c.req.header(ORIGIN_HEADER));
    if (refusal !== null) {
      c.get("logFields").originRefusal = refusal;
      return sendError(c, 403, "forbidden", "Forbidden");
    }
    await next();
  };
}
