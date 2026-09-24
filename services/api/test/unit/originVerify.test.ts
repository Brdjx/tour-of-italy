import { describe, expect, it, vi } from "vitest";
import { createOriginCheck, secretsMatch } from "../../src/lib/originVerify";
import { createCachedSecret, type ParameterFetcher } from "../../src/lib/secrets";

// The origin check (F5): every request must carry CloudFront's secret header. It fails closed
// when the secret cannot be read, accepts a rotated secret at once, and keeps the previous value
// working only for the grace window while CloudFront edges catch up.

function source(fetch: ParameterFetcher, now: () => number) {
  return createCachedSecret({
    name: "/italy-planner/secret",
    fetch,
    ttlMs: 60_000,
    timeoutMs: 1_000,
    retryAfterFailureMs: 5_000,
    minRefreshMs: 10_000,
    now,
  });
}

describe("origin verification", () => {
  it("compares in constant time and only accepts the exact secret", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abc", "abd")).toBe(false);
    expect(secretsMatch("abc", "abcd")).toBe(false);
    expect(secretsMatch("", "abc")).toBe(false);
  });

  it("refuses a missing header without reading SSM", async () => {
    const fetch = vi.fn<ParameterFetcher>(async () => "secret-value");
    const check = createOriginCheck(source(fetch, () => 0));

    expect(await check(undefined)).toBe("missing_header");
    expect(await check("")).toBe("missing_header");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the secret cannot be read", async () => {
    const down = source(
      async () => {
        throw new Error("SSM unavailable");
      },
      () => 0,
    );

    expect(await createOriginCheck(down)("anything")).toBe("secret_unavailable");
  });

  it("accepts a rotated secret at once, and the old one only for the grace window", async () => {
    let now = 0;
    let value = "secret-old";
    const clock = () => now;
    const check = createOriginCheck(
      source(async () => value, clock),
      {
        now: clock,
        graceMs: 60_000,
      },
    );
    expect(await check("secret-old")).toBeNull();
    value = "secret-new";
    now = 20_000;

    expect(await check("secret-new")).toBeNull();
    // Edges that have not picked up the new header yet are not refused mid-rotation.
    expect(await check("secret-old")).toBeNull();
    now = 20_000 + 60_000;
    expect(await check("secret-old")).toBe("mismatch");
    expect(await check("secret-new")).toBeNull();
  });

  it("never accepts a value it has not seen as the secret, even during a grace window", async () => {
    let now = 0;
    let value = "secret-old";
    const clock = () => now;
    const check = createOriginCheck(
      source(async () => value, clock),
      { now: clock },
    );
    await check("secret-old");
    value = "secret-new";
    now = 20_000;
    await check("secret-new");

    expect(await check("secret-guess")).toBe("mismatch");
  });
});
