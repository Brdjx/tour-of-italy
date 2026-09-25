// Secrets read from SSM Parameter Store (the Anthropic key, the CloudFront origin secret), cached
// in module scope. Reads are deduplicated, bounded by a timeout, and never throw: a failure is
// null, and each caller decides what null means (the plan route plans without AI; the origin
// check refuses the request).

/** Reads one SecureString parameter, decrypted. Must honor the signal. */
export type ParameterFetcher = (name: string, signal: AbortSignal) => Promise<string>;

export interface SecretSource {
  /** The secret, or null when it cannot be read right now. `forceRefresh` asks for a re-read. */
  get(options?: { forceRefresh?: boolean }): Promise<string | null>;
}

export interface CachedSecretOptions {
  name: string; // parameter name
  fetch: ParameterFetcher;
  ttlMs: number; // how long a value is reused; Infinity to keep it for the instance's life
  timeoutMs: number; // longest wait for one read
  firstTimeoutMs?: number; // longest wait for a read before the first value arrives (cold start)
  retryAfterFailureMs: number; // after a failed read, answer null this long before trying again
  retryBeforeFirstValueMs?: number; // the same wait while no value has ever been read
  minRefreshMs: number; // a forced refresh is skipped when the value is younger than this
  now?: () => number;
  onValue?: (value: string) => void; // called with each new value (to register it for redaction)
  onError?: (error: unknown) => void; // called with each failed read (for logging)
}

export function createCachedSecret(options: CachedSecretOptions): SecretSource {
  const now = options.now ?? Date.now;
  let value: string | null = null;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let failedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<string | null> | null = null;
  const neverRead = (): boolean => fetchedAt === Number.NEGATIVE_INFINITY;

  const read = async (): Promise<string | null> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Decision: the read settles at the timeout even when the fetcher ignores its signal. Every
    // request waits on this read (the origin check gates them all), so a stuck fetch must never
    // hold inFlight open.
    const timeoutMs = neverRead()
      ? (options.firstTimeoutMs ?? options.timeoutMs)
      : options.timeoutMs;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Parameter read exceeded ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      const fetching = Promise.resolve().then(() => options.fetch(options.name, controller.signal));
      const fresh = await Promise.race([fetching, expired]);
      if (typeof fresh !== "string" || fresh === "") throw new Error("Parameter is empty");
      value = fresh;
      fetchedAt = now();
      options.onValue?.(fresh);
      return fresh;
    } catch (error) {
      failedAt = now();
      options.onError?.(error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const start = (): Promise<string | null> => {
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    async get({ forceRefresh = false } = {}) {
      const at = now();
      const fresh = value !== null && at - fetchedAt < options.ttlMs;
      // Decision: a forced refresh (a header that did not match) re-reads at most once per
      // minRefreshMs, so a flood of wrong headers cannot become a flood of SSM calls.
      const refreshAllowed = at - fetchedAt >= options.minRefreshMs;
      if (fresh && !(forceRefresh && refreshAllowed)) return value;
      if (inFlight) return inFlight;
      // Decision: after a failure, answer null for a short while instead of calling SSM on every
      // request; for the origin check that means refusing (fail closed). Before the first value
      // arrives the wait can be shorter (retryBeforeFirstValueMs): an instance with no value can
      // serve nothing, and one read at a time (inFlight) already bounds the calls.
      const backOff = neverRead()
        ? (options.retryBeforeFirstValueMs ?? options.retryAfterFailureMs)
        : options.retryAfterFailureMs;
      if (at - failedAt < backOff) return fresh ? value : null;
      const result = await start();
      // A failed forced refresh keeps using the value that is still inside its TTL.
      return result ?? (fresh ? value : null);
    },
  };
}

/** A secret that is already known (a local .env key). */
export function staticSecret(value: string | undefined): SecretSource {
  const secret = value === undefined || value === "" ? null : value;
  return { get: async () => secret };
}
