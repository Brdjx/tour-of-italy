import type { Itinerary } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { TripSnapshotSchema } from "../../src/contract";
import { shippedData } from "../../src/data";
import { FixtureClient } from "../../src/llm/fixture";
import { createMemoryStore, type TripStore } from "../../src/trips/store";
import { FIXED_NOW, lastRequestLog, makeApp, postPlan, tripBody } from "../helpers/app";
import { getTrip, saveBody, saveTrip } from "../helpers/trips";
import { expectValidItinerary } from "../helpers/validPlan";

// The AI plan cache through app.request: this instance's memory first, then the shared table
// (here the in-memory store two app instances share, as two Lambda instances share DynamoDB),
// then the model. Only AI plans are cached, a store problem never fails a plan, and a plan with
// notes never reaches the table.

const { ctx } = shippedData();

/** Two instances of the API, each with its own memory, sharing one store and one model client. */
function twoInstances(store: TripStore = createMemoryStore(() => FIXED_NOW), scenario = "valid") {
  const client = new FixtureClient(ctx, scenario as "valid");
  return {
    client,
    store,
    one: makeApp({ client, tripStore: store }),
    two: makeApp({ client, tripStore: store }),
  };
}

async function planOn(app: ReturnType<typeof makeApp>["app"], body = tripBody()) {
  const res = await postPlan(app, body);
  return { res, plan: expectValidItinerary(await res.json()) };
}

/** Every cache item the store holds, by reading the keys the app would write. */
function cacheWrites(store: TripStore): string[] {
  const keys: string[] = [];
  const original = store.putNew.bind(store);
  store.putNew = (key, body, expiresAt, signal) => {
    if (key.startsWith("cache#")) keys.push(key);
    return original(key, body, expiresAt, signal);
  };
  return keys;
}

describe("the shared plan cache", () => {
  it("serves a plan made on one instance to another, with the same planId, without the model", async () => {
    const { client, one, two } = twoInstances();

    const first = await planOn(one.app);
    const second = await planOn(two.app);

    expect(client.calls).toBe(1);
    expect(second.plan).toEqual(first.plan);
    expect(second.plan.planId).toBeDefined();
    expect(lastRequestLog(one.logs)).toMatchObject({ cache: "miss", cacheWrite: "ok" });
    expect(lastRequestLog(two.logs)).toMatchObject({ cache: "hit-store", source: "ai" });
    // The second instance keeps it in memory now.
    await planOn(two.app);
    expect(lastRequestLog(two.logs).cache).toBe("hit-memory");
  });

  it("saves a plan served from the table with its AI why lines, through the planId it carries", async () => {
    const { one, two } = twoInstances();
    await planOn(one.app);
    const { plan } = await planOn(two.app);

    const id = await saveTrip(two.app, saveBody(plan));

    expect(lastRequestLog(two.logs)).toMatchObject({ aiSource: "plan" });
    const snapshot = TripSnapshotSchema.parse(await (await getTrip(two.app, id)).json());
    expect(snapshot.origin.plannedBy).toBe("ai");
    expect(snapshot.itinerary.days).toEqual(plan.days);
  });

  it("serves the same options in another order, answering with the request as sent", async () => {
    const { client, one, two } = twoInstances();
    await planOn(one.app, tripBody({ interests: ["historic", "food"] }));

    const { plan } = await planOn(two.app, tripBody({ interests: ["food", "historic"] }));

    expect(client.calls).toBe(1);
    expect(plan.request.interests).toEqual(["food", "historic"]);
  });

  it("never serves a plan cached by an earlier deploy, whose planner or checks may have changed since", async () => {
    const { client, store, one } = twoInstances();
    const next = makeApp({ client, tripStore: store, env: { GIT_SHA: "next-deploy" } });
    await planOn(one.app);

    await planOn(next.app);

    expect(client.calls).toBe(2);
    expect(lastRequestLog(next.logs).cache).toBe("miss");
  });

  it("never writes a plan made with notes to the table, and plans it again on another instance", async () => {
    const { client, store, one, two } = twoInstances();
    const writes = cacheWrites(store);
    const body = tripBody({ notes: "We travel with a toddler." });

    await planOn(one.app, body);
    await planOn(one.app, body);
    await planOn(two.app, body);

    expect(writes).toEqual([]);
    expect(client.calls).toBe(2); // once per instance; the first instance's memory served it again
    expect(lastRequestLog(two.logs).cache).toBe("miss");
  });

  it("never caches a fallback plan in either layer", async () => {
    const { client, store, one, two } = twoInstances(undefined, "rate-limited");
    const writes = cacheWrites(store);

    await planOn(one.app);
    await planOn(two.app);

    expect(client.calls).toBe(2); // once on each instance
    expect(writes).toEqual([]);
    expect(one.cache.size).toBe(0);
  });

  it("plans as usual when the table read fails, and logs it apart from the trips metric", async () => {
    const store = createMemoryStore(() => FIXED_NOW);
    store.get = async (key) => {
      if (key.startsWith("cache#")) throw new Error("ThrottlingException");
      return null;
    };
    const { app, logs } = makeApp({ tripStore: store, emitMetrics: true });

    const { res, plan } = await planOn(app);

    expect(res.status).toBe(200);
    expect(plan.source).toBe("ai");
    const log = lastRequestLog(logs);
    expect(log).toMatchObject({ cache: "miss", cacheRead: "error", tripStore: "ok" });
    expect(log.TripStoreFailures).toBe(0);
  });

  it("waits no more than about 150 ms for a table that does not answer", async () => {
    const store = createMemoryStore(() => FIXED_NOW);
    store.get = (key) => (key.startsWith("cache#") ? new Promise(() => {}) : Promise.resolve(null));
    const { app, logs } = makeApp({ tripStore: store });
    const started = Date.now();

    const { plan } = await planOn(app);

    expect(plan.source).toBe("ai");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lastRequestLog(logs)).toMatchObject({ cache: "miss" });
  });

  it("answers with the plan when the cache write fails", async () => {
    const store = createMemoryStore(() => FIXED_NOW);
    const put = store.putNew.bind(store);
    store.putNew = async (key, body, expiresAt, signal) => {
      if (key.startsWith("cache#")) throw new Error("AccessDeniedException");
      return put(key, body, expiresAt, signal);
    };
    const { app, logs } = makeApp({ tripStore: store });

    const { res, plan } = await planOn(app);

    expect(res.status).toBe(200);
    expect(plan.planId).toBeDefined();
    expect(lastRequestLog(logs)).toMatchObject({ cache: "miss", cacheWrite: "error" });
  });

  it("treats an unreadable table item as a miss", async () => {
    const { client, store, one, two } = twoInstances();
    const put = store.putNew.bind(store);
    store.putNew = (key, body, expiresAt, signal) =>
      put(key, key.startsWith("cache#") ? '{"v":1,"kind":"cache"}' : body, expiresAt, signal);
    await planOn(one.app);

    await planOn(two.app);

    expect(client.calls).toBe(2);
    expect(lastRequestLog(two.logs).cache).toBe("miss");
  });

  it("writes to the table only a plan that has a planId, so every copy can be saved with AI text", async () => {
    const store = createMemoryStore(() => FIXED_NOW);
    const writes = cacheWrites(store);
    const put = store.putNew.bind(store);
    store.putNew = async (key, body, expiresAt, signal) => {
      if (key.startsWith("plan#")) throw new Error("plan records are failing");
      return put(key, body, expiresAt, signal);
    };
    const { app } = makeApp({ tripStore: store });

    const { plan } = await planOn(app);

    expect(plan.planId).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("caches in memory only when there is no table", async () => {
    const client = new FixtureClient(ctx, "valid");
    const { app, logs, cache } = makeApp({ client, tripStore: null });

    await planOn(app);
    const again: Itinerary = (await planOn(app)).plan;

    expect(client.calls).toBe(1);
    expect(again.source).toBe("ai");
    expect(cache.size).toBe(1);
    expect(lastRequestLog(logs).cache).toBe("hit-memory");
  });
});
