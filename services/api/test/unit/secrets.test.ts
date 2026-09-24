import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import { createCachedSecret, type ParameterFetcher, staticSecret } from "../../src/lib/secrets";
import { createSsmFetcher } from "../../src/lib/ssm";

// Secrets from SSM: cached, bounded, never throwing. The origin check built on them must fail
// closed whenever the secret cannot be read (F5).

function source(fetch: ParameterFetcher, now: () => number, overrides = {}) {
  return createCachedSecret({
    name: "/italy-planner/secret",
    fetch,
    ttlMs: 60_000,
    timeoutMs: 1_000,
    retryAfterFailureMs: 5_000,
    minRefreshMs: 10_000,
    now,
    ...overrides,
  });
}

describe("createCachedSecret", () => {
  it("reads once and reuses the value inside the TTL", async () => {
    const fetch = vi.fn<ParameterFetcher>(async () => "value-1");
    const secret = source(fetch, () => 0);

    expect(await secret.get()).toBe("value-1");
    expect(await secret.get()).toBe("value-1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares one read between concurrent callers", async () => {
    const fetch = vi.fn<ParameterFetcher>(async () => "value-1");
    const secret = source(fetch, () => 0);

    await Promise.all([secret.get(), secret.get(), secret.get()]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the TTL so a rotated value is picked up", async () => {
    let now = 0;
    let value = "old";
    const secret = source(
      async () => value,
      () => now,
    );
    await secret.get();
    value = "new";
    now = 61_000;

    expect(await secret.get()).toBe("new");
  });

  it("answers null (never throws) when SSM fails, and waits before retrying", async () => {
    let now = 0;
    const fetch = vi.fn<ParameterFetcher>(async () => {
      throw new Error("AccessDenied");
    });
    const onError = vi.fn();
    const secret = source(fetch, () => now, { onError });

    expect(await secret.get()).toBeNull();
    expect(await secret.get()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    now = 6_000;
    await secret.get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats an empty parameter as a failure", async () => {
    const secret = source(
      async () => "",
      () => 0,
    );

    expect(await secret.get()).toBeNull();
  });

  it("gives up on a read that hangs, at its timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetch: ParameterFetcher = (_, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      const secret = source(fetch, () => 0);

      const pending = secret.get();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rate-limits forced refreshes, so bad headers cannot flood SSM", async () => {
    let now = 0;
    const fetch = vi.fn<ParameterFetcher>(async () => "value");
    const secret = source(fetch, () => now);
    await secret.get();

    for (let i = 0; i < 50; i++) await secret.get({ forceRefresh: true });
    expect(fetch).toHaveBeenCalledTimes(1);

    now = 10_000;
    await secret.get({ forceRefresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports each new value so it can be registered for redaction", async () => {
    const onValue = vi.fn();
    const secret = source(
      async () => "registered-value",
      () => 0,
      { onValue },
    );

    await secret.get();

    expect(onValue).toHaveBeenCalledWith("registered-value");
  });

  it("static secrets answer the configured value, or null when unset", async () => {
    expect(await staticSecret("k").get()).toBe("k");
    expect(await staticSecret(undefined).get()).toBeNull();
    expect(await staticSecret("").get()).toBeNull();
  });
});

describe("secret reads that never settle", () => {
  it("settles at the timeout even when the fetcher ignores its abort signal", async () => {
    vi.useFakeTimers();
    try {
      const secret = source(
        () => new Promise<string>(() => {}),
        () => Date.now(),
      );
      let settled: string | null | undefined;
      void secret.get().then((value) => {
        settled = value;
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the next request start a fresh read instead of joining the stuck one", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const secret = source(
        () => {
          calls++;
          return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve("value-2");
        },
        () => Date.now(),
        { retryAfterFailureMs: 0 },
      );
      const first = secret.get();
      await vi.advanceTimersByTimeAsync(1_000);
      await first;

      expect(await secret.get()).toBe("value-2");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createSsmFetcher", () => {
  it("asks SSM for the decrypted parameter and passes the abort signal", async () => {
    const send = vi.fn(async () => ({ Parameter: { Value: "decrypted" } }));
    const signal = new AbortController().signal;

    const value = await createSsmFetcher({ send })("/italy-planner/x", signal);

    expect(value).toBe("decrypted");
    const [command, options] = send.mock.calls[0] as unknown as [
      GetParameterCommand,
      { abortSignal: AbortSignal },
    ];
    expect(command).toBeInstanceOf(GetParameterCommand);
    expect(command.input).toEqual({ Name: "/italy-planner/x", WithDecryption: true });
    expect(options.abortSignal).toBe(signal);
  });

  it("throws when the parameter has no value, so the caller treats it as a failure", async () => {
    const send = vi.fn(async () => ({ Parameter: {} }));

    await expect(createSsmFetcher({ send })("/x", new AbortController().signal)).rejects.toThrow(
      /no value/,
    );
  });
});
