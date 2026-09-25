import { newRecordId, type RandomSource } from "./ids";

// Where the API keeps three kinds of record: the AI content of a plan it made (90 days, so a
// trip saved from that plan can carry the AI's why lines and summary), saved trips (a year), and
// AI plans cached for the options they answer (7 days, plan/planCache.ts). One table, one item
// per record: pk "plan#<id>", "trip#<id>" or "cache#<key>", the record as JSON text in `body`,
// and `expiresAt` in epoch seconds for DynamoDB's time to live. dynamoStore.ts is the real store;
// the in-memory one below serves local development and tests.

// Decision: the record is one JSON string attribute, not a DynamoDB map. The API reads a record
// whole and checks it with its Zod schema anyway, so a map would only add marshalling code and
// the lib-dynamodb dependency to the Lambda bundle.

export interface TripStore {
  readonly kind: "dynamodb" | "memory";
  /**
   * Writes a new record. False when the key already holds a record that has not expired; nothing
   * is written then.
   */
  putNew(key: string, body: string, expiresAt: number, signal: AbortSignal): Promise<boolean>;
  /** The record's body, or null when there is none or it has expired. */
  get(key: string, signal: AbortSignal): Promise<string | null>;
}

export const planKey = (id: string) => `plan#${id}`;
export const tripKey = (id: string) => `trip#${id}`;
export const cacheKey = (key: string) => `cache#${key}`;

const DAY_SECONDS = 24 * 60 * 60;

/** How long each kind of record is kept, in seconds. */
// Decision: 90 days for a plan's AI content, the same as the last plan the page keeps on the
// device (LAST_PLAN_MAX_AGE_DAYS in apps/web/lib/lastPlan.ts), so any plan the page can still
// show can be saved with its AI why lines. A saved trip is kept a year, which covers planning a
// trip months ahead and looking back at it after. A cached plan is kept 7 days: hours and seasons
// drift, and its planId must point at a plan record for as long as the cache can serve it, so
// the cache never keeps a plan longer than its record.
export const KEEP_SECONDS = {
  plan: 90 * DAY_SECONDS,
  trip: 365 * DAY_SECONDS,
  cache: 7 * DAY_SECONDS,
} as const;

/** Epoch seconds `keepSeconds` after `nowMs`. */
export function expiresAtFrom(nowMs: number, keepSeconds: number): number {
  return Math.floor(nowMs / 1000) + keepSeconds;
}

/** Time limits for store calls, in milliseconds. */
// Decision: 1 s to keep a plan's AI content, so a slow store can never hold a plan back for
// longer than that; 2.5 s for each read and write of saving or opening a trip, well inside the
// page's 10 s deadline for those calls. A cache read gets 150 ms, so a miss is never more than
// that slower than no cache at all (a warm read takes under 10 ms); a cache write gets 500 ms,
// after the plan is made and before it is sent.
export const STORE_TIMEOUT_MS = {
  plan: 1000,
  trip: 2500,
  cacheRead: 150,
  cacheWrite: 500,
} as const;

/** Thrown when a store call does not settle within its time limit. */
export class StoreTimeoutError extends Error {
  override name = "StoreTimeoutError";
}

/** Thrown when every id tried for a new record was already taken. */
export class StoreCollisionError extends Error {
  override name = "StoreCollisionError";
}

/**
 * Runs one store call with a hard time limit. The call gets an AbortSignal that fires at the
 * limit, and the returned promise settles by then even if the call ignores the signal.
 */
export async function withinTime<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StoreTimeoutError(`Store call exceeded ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Ids tried for one new record before giving up. */
// Decision: 3. With 62^10 ids a single collision is already far less likely than a store outage;
// the retry exists so a collision can never overwrite someone else's trip or plan.
export const MAX_ID_ATTEMPTS = 3;

export interface SaveOptions {
  prefix: "plan" | "trip";
  expiresAt: number; // epoch seconds
  timeoutMs: number; // for each write
  random?: RandomSource | undefined; // for tests; crypto.randomBytes by default
}

/**
 * Writes a new record under a fresh id and returns the id. `body` builds the record for its id.
 * A taken id is retried with another; throws StoreCollisionError after MAX_ID_ATTEMPTS, or
 * whatever the store threw.
 */
export async function saveNew(
  store: TripStore,
  body: (id: string) => string,
  options: SaveOptions,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = newRecordId(options.random);
    const key = options.prefix === "plan" ? planKey(id) : tripKey(id);
    const text = body(id);
    const written = await withinTime(
      (signal) => store.putNew(key, text, options.expiresAt, signal),
      options.timeoutMs,
    );
    if (written) return id;
  }
  throw new StoreCollisionError(`No free ${options.prefix} id after ${MAX_ID_ATTEMPTS} tries`);
}

/** Records kept by the in-memory store; the oldest is dropped first. */
export const MEMORY_STORE_ENTRIES = 1000;

/**
 * A store in this process's memory. Records vanish on restart and are not shared between
 * processes, so it is only for local development and tests (createApp uses it when TRIPS_TABLE
 * is unset outside production).
 */
export function createMemoryStore(now: () => number = Date.now): TripStore {
  const items = new Map<string, { body: string; expiresAt: number }>();
  return {
    kind: "memory",
    async putNew(key, body, expiresAt) {
      const item = items.get(key);
      if (item && item.expiresAt * 1000 > now()) return false;
      items.delete(key); // an expired record is replaced and becomes the newest
      items.set(key, { body, expiresAt });
      while (items.size > MEMORY_STORE_ENTRIES) {
        const oldest = items.keys().next().value as string;
        items.delete(oldest);
      }
      return true;
    },
    async get(key) {
      const item = items.get(key);
      if (!item || item.expiresAt * 1000 <= now()) return null;
      return item.body;
    },
  };
}
