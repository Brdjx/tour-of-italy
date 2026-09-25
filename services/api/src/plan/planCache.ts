import { hasNotes, type Itinerary, ItinerarySchema, type TripRequest } from "@italy/planner";
import { z } from "zod";
import type { LruCache } from "../lib/cache";
import type { LogFields } from "../lib/logger";
import type { AiItinerary } from "../trips/records";
import {
  cacheKey,
  expiresAtFrom,
  KEEP_SECONDS,
  STORE_TIMEOUT_MS,
  type TripStore,
  withinTime,
} from "../trips/store";

// The AI plan cache, so the same options are not sent to the model twice. Two layers: this
// instance's memory (an LruCache), then the shared table (item "cache#<key>", KEEP_SECONDS.cache),
// so a plan made on one Lambda instance serves the same options on every other. A lookup goes
// memory, then the table with a short time limit, then the model; the log line says which
// (cache: hit-memory, hit-store or miss). Only AI plans are written, with their planId, so a
// plan served from the cache can still be saved with its AI why lines. The key is planCacheKey
// (lib/cache.ts).

/** A cached plan and when it stops being served, in epoch seconds. */
export interface CachedPlan {
  itinerary: Itinerary;
  expiresAt: number;
}

export interface PlanCacheDeps {
  memory: LruCache<CachedPlan>;
  store: TripStore | null; // the shared layer; null when there is no table
  now: () => number;
}

export type CacheLookup = "hit-memory" | "hit-store" | "miss";

/** A cached plan as stored in the table. */
const CacheRecordSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("cache"),
  expiresAt: z.number().int().positive(), // the item's own expiry, for the copy kept in memory
  itinerary: ItinerarySchema,
});

// Decision: a request with notes is cached in memory only, never in the table. The table holds
// no personal data (trip requests are stored without the traveler's notes), and a plan made for
// notes carries them in its request and may repeat them in its text. Notes are also close to
// unique, so another traveler would almost never ask for the same plan.
const sharedFor = (request: TripRequest) => !hasNotes(request);

/**
 * The cached plan for `key`, or undefined. Tries memory, then the table for at most
 * STORE_TIMEOUT_MS.cacheRead; a table hit is kept in memory too. Sets fields.cache. Never throws.
 */
export async function readCachedPlan(
  key: string,
  request: TripRequest,
  deps: PlanCacheDeps,
  fields: LogFields,
): Promise<Itinerary | undefined> {
  const nowSeconds = deps.now() / 1000;
  const inMemory = deps.memory.get(key);
  if (inMemory && inMemory.expiresAt > nowSeconds) {
    fields.cache = "hit-memory" satisfies CacheLookup;
    return inMemory.itinerary;
  }
  if (inMemory) deps.memory.delete(key);
  const fromStore = sharedFor(request) ? await readStore(key, deps, fields) : undefined;
  if (fromStore) {
    deps.memory.set(key, fromStore);
    fields.cache = "hit-store" satisfies CacheLookup;
    return fromStore.itinerary;
  }
  fields.cache = "miss" satisfies CacheLookup;
  return undefined;
}

async function readStore(
  key: string,
  deps: PlanCacheDeps,
  fields: LogFields,
): Promise<CachedPlan | undefined> {
  const { store } = deps;
  if (!store) return undefined;
  let text: string | null;
  try {
    text = await withinTime(
      (signal) => store.get(cacheKey(key), signal),
      STORE_TIMEOUT_MS.cacheRead,
    );
  } catch (error) {
    // Decision: a failed or slow read is a miss, not a failed plan. It is logged, but it does
    // not count toward the TripStoreFailures alarm: a cold instance's first read can pass the
    // 150 ms limit, and a table that is really down already shows in the plan record writes.
    fields.cacheRead = "error";
    fields.cacheReadError = error;
    return undefined;
  }
  if (text === null) return undefined;
  const record = parseRecord(text);
  if (!record) return undefined;
  // Decision: the memory copy ends when the table item does, never later, so a plan is never
  // served longer than KEEP_SECONDS.cache after it was made, and its planId always resolves.
  return { itinerary: record.itinerary, expiresAt: record.expiresAt };
}

function parseRecord(text: string): z.output<typeof CacheRecordSchema> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = CacheRecordSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Caches an AI plan under `key`: in memory, and in the table when it has a planId (so every copy
 * can be saved with its AI why lines) and its request has no notes. Waits at most
 * STORE_TIMEOUT_MS.cacheWrite for the table. Never throws.
 */
export async function cachePlan(
  key: string,
  itinerary: AiItinerary,
  deps: PlanCacheDeps,
  fields: LogFields,
): Promise<void> {
  const expiresAt = expiresAtFrom(deps.now(), KEEP_SECONDS.cache);
  deps.memory.set(key, { itinerary, expiresAt });
  const { store } = deps;
  if (!store || itinerary.planId === undefined || !sharedFor(itinerary.request)) return;
  const text = JSON.stringify({ v: 1, kind: "cache", expiresAt, itinerary });
  try {
    // A false answer means another instance cached these options first; its plan is as good.
    await withinTime(
      (signal) => store.putNew(cacheKey(key), text, expiresAt, signal),
      STORE_TIMEOUT_MS.cacheWrite,
    );
    fields.cacheWrite = "ok";
  } catch (error) {
    fields.cacheWrite = "error";
    fields.cacheWriteError = error;
  }
}
