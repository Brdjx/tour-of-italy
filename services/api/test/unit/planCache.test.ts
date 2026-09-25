import { planDeterministic, type TripRequest } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { shippedData } from "../../src/data";
import { LruCache } from "../../src/lib/cache";
import type { LogFields } from "../../src/lib/logger";
import { type CachedPlan, cachePlan, readCachedPlan } from "../../src/plan/planCache";
import type { AiItinerary } from "../../src/trips/records";
import { cacheKey, createMemoryStore, KEEP_SECONDS } from "../../src/trips/store";
import { START_DATE } from "../helpers/app";

// The plan cache's two layers on their own: memory first, then the table, with expiry that never
// outlives the table item, and a table that is only a helper, never a way to fail a plan.

const { ctx } = shippedData();
const NOW = Date.UTC(2026, 8, 23, 12);
const DAY_MS = 86_400_000;
const signal = () => new AbortController().signal;

const request: TripRequest = {
  startDate: START_DATE,
  pace: "balanced",
  interests: ["food"],
  maxPriceLevel: null,
  anchors: "auto",
  mustInclude: [],
  exclude: [],
};

function aiItinerary(overrides: Partial<TripRequest> = {}): AiItinerary {
  const plan = planDeterministic({ ...request, ...overrides }, ctx);
  return { ...plan, source: "ai", planId: "Abc1234567" };
}

function setup(now = () => NOW) {
  const memory = new LruCache<CachedPlan>(10);
  const store = createMemoryStore(now);
  return { memory, store, deps: { memory, store, now } };
}

describe("readCachedPlan and cachePlan", () => {
  it("finds a plan it cached, in memory first, and in the table from another instance", async () => {
    const { store, deps } = setup();
    const fields: LogFields = {};
    const plan = aiItinerary();

    await cachePlan("k", plan, deps, fields);

    expect(fields.cacheWrite).toBe("ok");
    expect(await readCachedPlan("k", request, deps, fields)).toEqual(plan);
    expect(fields.cache).toBe("hit-memory");
    const other = { ...deps, memory: new LruCache<CachedPlan>(10) };
    expect(await readCachedPlan("k", request, other, fields)).toEqual(plan);
    expect(fields.cache).toBe("hit-store");
    const item = JSON.parse((await store.get(cacheKey("k"), signal())) ?? "{}");
    expect(item).toMatchObject({ v: 1, kind: "cache", expiresAt: NOW / 1000 + KEEP_SECONDS.cache });
  });

  it("stops serving a plan in every layer a week after it was cached", async () => {
    let now = NOW;
    const { memory, deps } = setup(() => now);
    await cachePlan("k", aiItinerary(), deps, {});
    const other = { ...deps, memory: new LruCache<CachedPlan>(10) };
    await readCachedPlan("k", request, other, {}); // the second instance copies it to memory

    now = NOW + 7 * DAY_MS;
    const fields: LogFields = {};

    expect(await readCachedPlan("k", request, deps, fields)).toBeUndefined();
    expect(await readCachedPlan("k", request, other, fields)).toBeUndefined();
    expect(fields.cache).toBe("miss");
    expect(memory.size).toBe(0);
  });

  it("keeps a table plan in memory only until the table item expires, never a fresh week", async () => {
    let now = NOW;
    const { deps } = setup(() => now);
    await cachePlan("k", aiItinerary(), deps, {});
    now = NOW + 6 * DAY_MS;
    const other = { ...deps, memory: new LruCache<CachedPlan>(10) };
    await readCachedPlan("k", request, other, {});

    now = NOW + 7 * DAY_MS;

    expect(await readCachedPlan("k", request, other, {})).toBeUndefined();
  });

  it("keeps a plan made with notes, or without a planId, in memory only", async () => {
    const { store, deps } = setup();
    const withNotes = aiItinerary({ notes: "Travelling with a toddler." });
    const noPlanId: AiItinerary = { ...aiItinerary(), planId: undefined };

    await cachePlan("notes", withNotes, deps, {});
    await cachePlan("no-id", noPlanId, deps, {});

    expect(await store.get(cacheKey("notes"), signal())).toBeNull();
    expect(await store.get(cacheKey("no-id"), signal())).toBeNull();
    const fields: LogFields = {};
    expect(await readCachedPlan("notes", withNotes.request, deps, fields)).toEqual(withNotes);
    expect(fields.cache).toBe("hit-memory");
  });

  it("does not look in the table for a request with notes", async () => {
    const { store, deps } = setup();
    const reads: string[] = [];
    const get = store.get.bind(store);
    store.get = (key, given) => {
      reads.push(key);
      return get(key, given);
    };
    const fields: LogFields = {};

    expect(await readCachedPlan("k", { ...request, notes: "Quiet" }, deps, fields)).toBeUndefined();
    expect(reads).toEqual([]);
    expect(fields.cache).toBe("miss");
  });

  it("is a miss, never an error, without a table, with an unreadable item, or when the table fails", async () => {
    const plain = { memory: new LruCache<CachedPlan>(10), store: null, now: () => NOW };
    const fields: LogFields = {};
    expect(await readCachedPlan("k", request, plain, fields)).toBeUndefined();
    await cachePlan("k", aiItinerary(), { ...plain, memory: new LruCache(10) }, fields);
    expect(fields.cacheWrite).toBeUndefined();

    const { store, deps } = setup();
    await store.putNew(cacheKey("bad"), "not json", NOW / 1000 + 60, signal());
    expect(await readCachedPlan("bad", request, deps, fields)).toBeUndefined();

    store.get = async () => {
      throw new Error("down");
    };
    const failed: LogFields = {};
    expect(await readCachedPlan("k", request, deps, failed)).toBeUndefined();
    expect(failed).toMatchObject({ cache: "miss", cacheRead: "error" });
    expect(failed.tripStore).toBeUndefined();
  });
});
