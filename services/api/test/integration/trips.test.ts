import { dataVersion, type Itinerary, PlaceSchema, RecordIdSchema } from "@italy/planner";
import { describe, expect, it } from "vitest";
import { defaultTripStore } from "../../src/app";
import { loadConfig } from "../../src/config";
import {
  ErrorResponseSchema,
  MetaResponseSchema,
  SaveTripResponseSchema,
  TripSnapshotSchema,
} from "../../src/contract";
import { shippedData } from "../../src/data";
import { createTokenBucket } from "../../src/lib/rateLimit";
import type { LlmClient, LlmResult } from "../../src/llm/client";
import { FixtureClient } from "../../src/llm/fixture";
import { PlanRecordSchema } from "../../src/trips/records";
import { planKey, type TripStore, tripKey } from "../../src/trips/store";
import { lastRequestLog, makeApp, postPlan, tripBody } from "../helpers/app";
import { aiPlan, getTrip, postTrip, saveBody, saveTrip, tripsApp } from "../helpers/trips";
import { expectValidItinerary } from "../helpers/validPlan";

// Saved trips end to end through app.request, with the in-memory store: POST /api/plan keeps an
// AI plan's content under its planId, POST /api/trips rebuilds a trip from ids and stores it, and
// GET /api/trips/:id returns exactly what was stored.

const signal = () => new AbortController().signal;

/** A stored record, parsed. */
async function stored(store: TripStore, key: string): Promise<unknown> {
  const text = await store.get(key, signal());
  return text === null ? null : JSON.parse(text);
}

/** The stops without their why lines: what the rebuild must reproduce exactly. */
function timings(itinerary: Pick<Itinerary, "days">) {
  return itinerary.days.map((day) => ({
    ...day,
    stops: day.stops.map(({ reason: _r, reasonSource: _s, ...stop }) => stop),
  }));
}

describe("POST /api/plan keeps the AI content of AI plans", () => {
  it("returns a planId on an AI plan and stores its request, ids, AI why lines and summary", async () => {
    const { app, store, logs } = tripsApp();

    const plan = await aiPlan(app);

    expect(plan.source).toBe("ai");
    expect(RecordIdSchema.safeParse(plan.planId).success).toBe(true);
    const record = PlanRecordSchema.parse(await stored(store, planKey(plan.planId as string)));
    expect(record.source).toBe("ai");
    expect(record.model).toBe(plan.meta.model);
    expect(record.summary).toBe(plan.summary);
    expect(record.days).toEqual(
      plan.days.map((day) => ({ anchorId: day.anchorId, ids: day.stops.map((s) => s.placeId) })),
    );
    const aiStops = plan.days.flatMap((day) => day.stops.filter((s) => s.reasonSource === "ai"));
    expect(record.reasons).toHaveLength(aiStops.length);
    expect(record.reasons[0]).toMatchObject({ day: 0, placeId: plan.days[0]?.stops[0]?.placeId });
    expect(lastRequestLog(logs)).toMatchObject({ tripStore: "ok" });
  });

  it("gives rules-only plans no planId", async () => {
    const { app } = tripsApp();

    const res = await postPlan(app, tripBody(), { scenario: "valid", query: "mode=deterministic" });

    const plan = expectValidItinerary(await res.json());
    expect(plan.source).toBe("deterministic");
    expect(plan.planId).toBeUndefined();
  });

  it("returns the same planId for a plan served from the cache", async () => {
    const { app } = tripsApp();

    const first = await aiPlan(app);
    const second = await aiPlan(app);

    expect(second.planId).toBe(first.planId);
  });

  it("still answers with the plan, without a planId, when the store fails", async () => {
    const broken: TripStore = {
      kind: "memory",
      putNew: async () => {
        throw new Error("ProvisionedThroughputExceededException");
      },
      get: async () => null,
    };
    const { app, logs } = makeApp({ tripStore: broken });

    const res = await postPlan(app, tripBody(), { scenario: "valid" });

    expect(res.status).toBe(200);
    const plan = expectValidItinerary(await res.json());
    expect(plan.source).toBe("ai");
    expect(plan.planId).toBeUndefined();
    expect(lastRequestLog(logs)).toMatchObject({ tripStore: "error" });
  });

  it("waits at most the store's time limit for the record, then answers without a planId", async () => {
    const stuck: TripStore = {
      kind: "memory",
      putNew: () => new Promise<boolean>(() => {}),
      get: async () => null,
    };
    const { app } = makeApp({ tripStore: stuck });
    const started = Date.now();

    const plan = await aiPlan(app);

    expect(plan.planId).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("gives no planId when saved trips are off (production without a table)", async () => {
    const { app } = makeApp({ tripStore: null });

    const plan = await aiPlan(app);

    expect(plan.source).toBe("ai");
    expect(plan.planId).toBeUndefined();
  });
});

describe("the traveler's notes stay private", () => {
  const PRIVATE_LINE = "A calm stop that suits your recent knee surgery.";
  const PRIVATE_SUMMARY = "Since you mentioned your knee, each day stays short and flat.";

  /** The fixture's valid answer, with a first why line and a summary that echo the notes. */
  function echoingClient(): LlmClient {
    const fixture = new FixtureClient(shippedData().ctx, "valid");
    const echo = async (result: Promise<LlmResult>): Promise<LlmResult> => {
      const answer = await result;
      const selection = structuredClone(answer.selection);
      const first = selection?.days[0]?.reasons[0];
      if (first) first.reason = PRIVATE_LINE;
      if (selection) selection.summary = PRIVATE_SUMMARY;
      return { ...answer, selection };
    };
    return {
      model: "echoing",
      select: (input) => echo(fixture.select(input)),
      repair: (input) => echo(fixture.repair(input)),
    };
  }

  it("keeps none of the AI's text when the plan had notes", async () => {
    const { app, store } = tripsApp({ client: echoingClient() });

    const plan = await aiPlan(
      app,
      tripBody({ notes: "I had knee surgery. We travel with a toddler." }),
    );

    // The traveler sees everything the AI wrote for them...
    expect(plan.summary).toBe(PRIVATE_SUMMARY);
    expect(plan.days[0]?.stops[0]).toMatchObject({ reason: PRIVATE_LINE, reasonSource: "ai" });
    const aiLines = plan.days.flatMap((day) => day.stops.filter((s) => s.reasonSource === "ai"));
    expect(aiLines.length).toBeGreaterThan(1);
    // ...but the record a saved trip is built from keeps none of it, and never the notes: not
    // the line that echoes them, and not the lines about the places either.
    const text = (await store.get(planKey(plan.planId as string), signal())) ?? "";
    const record = PlanRecordSchema.parse(JSON.parse(text));
    expect(record.summary).toBeUndefined();
    expect(record.reasons).toEqual([]);
    expect(record.source).toBe("ai");
    expect(record.request.notes).toBeUndefined();
    expect(text).not.toMatch(/toddler|surgery|knee/);
  });

  it("saves every stop with the rule's why line and no summary, still planned by the AI", async () => {
    const { app } = tripsApp({ client: echoingClient() });
    const plan = await aiPlan(app, tripBody({ notes: "I had knee surgery." }));

    const id = await saveTrip(app, saveBody(plan));

    const snapshot = TripSnapshotSchema.parse(await (await getTrip(app, id)).json());
    expect(snapshot.itinerary.summary).toBeUndefined();
    expect(snapshot.origin.plannedBy).toBe("ai");
    const stops = snapshot.itinerary.days.flatMap((day) => day.stops);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((stop) => stop.reasonSource === "rule")).toBe(true);
    expect(stops[0]?.reason).not.toBe(PRIVATE_LINE);
    expect(JSON.stringify(snapshot)).not.toMatch(/surgery|knee/);
  });

  it("keeps the same lines and summary when the plan had no notes", async () => {
    const { app, store } = tripsApp({ client: echoingClient() });

    const plan = await aiPlan(app);

    const text = (await store.get(planKey(plan.planId as string), signal())) ?? "";
    const record = PlanRecordSchema.parse(JSON.parse(text));
    expect(record.summary).toBe(PRIVATE_SUMMARY);
    expect(record.reasons[0]?.reason).toBe(PRIVATE_LINE);
  });
});

describe("POST /api/trips and GET /api/trips/:id", () => {
  it("saves an AI plan as it was shown and opens it exactly as saved", async () => {
    const { app, store, logs } = tripsApp();
    const plan = await aiPlan(app);

    const res = await postTrip(app, saveBody(plan));

    expect(res.status).toBe(201);
    const { id } = SaveTripResponseSchema.parse(await res.json());
    expect(id).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(lastRequestLog(logs)).toMatchObject({
      tripStore: "ok",
      aiSource: "plan",
      plannedBy: "ai",
      edited: false,
    });
    const opened = await getTrip(app, id);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("cache-control")).toBe("public, max-age=300, immutable");
    const text = await opened.text();
    expect(text).toBe(await store.get(tripKey(id), signal()));
    const snapshot = TripSnapshotSchema.parse(JSON.parse(text));
    expect(snapshot.id).toBe(id);
    expect(snapshot.origin).toEqual({ plannedBy: "ai", edited: false });
    expect(snapshot.createdAt).toBe(new Date(Date.UTC(2026, 8, 23, 12)).toISOString());
    expect(snapshot.expiresAt).toBe(new Date(Date.UTC(2027, 8, 23, 12)).toISOString());
    // The trip as the page showed it: same times, roles, why lines, summary and warnings.
    const { planId: _planId, meta: _meta, ...shown } = plan;
    const { meta: _saved, ...saved } = snapshot.itinerary;
    expect(saved).toEqual(shown);
    expect(snapshot.itinerary.meta.model).toBe(plan.meta.model);
    expectValidItinerary(snapshot.itinerary);
  });

  it("stores the data version /api/meta reports, which the page computes from /api/places", async () => {
    const { app } = tripsApp();
    const meta = MetaResponseSchema.parse(await (await app.request("/api/meta")).json());
    const places = (await (await app.request("/api/places")).json()) as { places: unknown[] };
    // The page parses the places with the planner's schema, then fingerprints them.
    const parsed = places.places.map((place) => PlaceSchema.parse(place));

    const id = await saveTrip(app, saveBody(await aiPlan(app)));

    const snapshot = TripSnapshotSchema.parse(await (await getTrip(app, id)).json());
    expect(snapshot.dataVersion).toBe(meta.dataVersion);
    expect(dataVersion(parsed)).toBe(meta.dataVersion);
  });

  it("marks a trip edited after a removal, keeps the other AI why lines and drops the notes", async () => {
    const { app } = tripsApp();
    const plan = await aiPlan(app);
    const body = saveBody(plan) as { days: { ids: string[] }[]; request: object };
    const removed = body.days[1]?.ids.splice(1, 1)[0];
    body.request = { ...body.request, notes: "Private note." };

    const id = await saveTrip(app, body);

    const snapshot = TripSnapshotSchema.parse(await (await getTrip(app, id)).json());
    expect(snapshot.origin).toEqual({ plannedBy: "ai", edited: true });
    expect(snapshot.itinerary.request.notes).toBeUndefined();
    const day = snapshot.itinerary.days[1];
    expect(day?.stops.map((s) => s.placeId)).not.toContain(removed);
    const day0 = snapshot.itinerary.days[0];
    expect(day0?.stops.every((stop) => stop.reasonSource === "ai")).toBe(true);
  });

  it("carries the AI content of a saved trip when it is opened, edited and saved again", async () => {
    const { app } = tripsApp();
    const plan = await aiPlan(app);
    const firstId = await saveTrip(app, saveBody(plan));
    const first = TripSnapshotSchema.parse(await (await getTrip(app, firstId)).json());
    const again = saveBody(first.itinerary as Itinerary, { tripId: firstId });

    const secondId = await saveTrip(app, again);

    expect(secondId).not.toBe(firstId);
    const second = TripSnapshotSchema.parse(await (await getTrip(app, secondId)).json());
    expect(second.origin).toEqual(first.origin);
    expect(second.itinerary.days).toEqual(first.itinerary.days);
    expect(second.itinerary.summary).toBe(first.itinerary.summary);
  });

  it("saves with rule why lines when the plan record is gone, and says so in the log", async () => {
    const { app, logs } = tripsApp();
    const plan = await aiPlan(app);

    const id = await saveTrip(app, saveBody(plan, { planId: "0000000000" }));

    expect(lastRequestLog(logs)).toMatchObject({ aiSource: "plan_not_found", plannedBy: "rules" });
    const snapshot = TripSnapshotSchema.parse(await (await getTrip(app, id)).json());
    expect(snapshot.origin).toEqual({ plannedBy: "rules", edited: false });
    expect(snapshot.itinerary.source).toBe("deterministic");
    expect(snapshot.itinerary.summary).toBeUndefined();
    const stops = snapshot.itinerary.days.flatMap((day) => day.stops);
    expect(stops.every((stop) => stop.reasonSource === "rule")).toBe(true);
    expect(timings(snapshot.itinerary)).toEqual(timings(plan));
  });

  it("saves a rules-only plan without a planId, with the rules' why lines", async () => {
    const { app, logs } = tripsApp();
    const res = await postPlan(app, tripBody(), { query: "mode=deterministic" });
    const plan = (await res.json()) as Itinerary;

    const id = await saveTrip(app, saveBody(plan));

    expect(lastRequestLog(logs)).toMatchObject({ aiSource: "none" });
    const snapshot = TripSnapshotSchema.parse(await (await getTrip(app, id)).json());
    expect(snapshot.itinerary.days).toEqual(plan.days);
    expect(snapshot.itinerary.warnings).toEqual(plan.warnings);
  });

  it("uses a stored record that is not a plan record as no AI content at all", async () => {
    const { app, store, logs } = tripsApp();
    const plan = await aiPlan(app);
    await store.putNew(planKey("AAAAAAAAAA"), '{"v":2}', 2_000_000_000, signal());
    await store.putNew(tripKey("BBBBBBBBBB"), "not json", 2_000_000_000, signal());

    await saveTrip(app, saveBody(plan, { planId: "AAAAAAAAAA" }));
    expect(lastRequestLog(logs)).toMatchObject({ aiSource: "unusable", plannedBy: "rules" });
    const { planId: _p, ...rest } = saveBody(plan);
    await saveTrip(app, { ...rest, tripId: "BBBBBBBBBB" });
    expect(lastRequestLog(logs)).toMatchObject({ aiSource: "unusable", plannedBy: "rules" });
  });

  it("refuses a body with why lines or a summary in it, so no client text can be saved", async () => {
    const { app } = tripsApp();
    const plan = await aiPlan(app);
    const body = saveBody(plan) as { days: Record<string, unknown>[] };

    const withSummary = await postTrip(app, { ...body, summary: "Written by a stranger." });
    const withReasons = await postTrip(app, {
      ...body,
      days: body.days.map((day) => ({ ...day, reasons: ["Written by a stranger."] })),
    });
    const withItinerary = await postTrip(app, { ...body, itinerary: plan });

    for (const res of [withSummary, withReasons, withItinerary]) {
      expect(res.status).toBe(400);
      const error = ErrorResponseSchema.parse(await res.json()).error;
      expect(error.code).toBe("bad_request");
      expect(JSON.stringify(error)).not.toContain("stranger");
    }
  });

  it("refuses unknown bases and places, too many stops, the wrong day count, and two sources", async () => {
    const { app } = tripsApp();
    const plan = await aiPlan(app);
    const body = saveBody(plan) as { days: { anchorId: string; ids: string[] }[] };
    const day = (index: number) => body.days[index] as { anchorId: string; ids: string[] };
    const cases = [
      { ...body, days: [{ ...day(0), anchorId: "atlantis" }, day(1), day(2)] },
      { ...body, days: [{ ...day(0), ids: ["place_999"] }, day(1), day(2)] },
      { ...body, days: [{ ...day(0), ids: Array.from({ length: 21 }, () => "place_001") }] },
      { ...body, days: [day(0), day(1)] },
      { ...body, tripId: "AAAAAAAAAA" },
      { ...body, planId: "not-an-id" },
    ];
    for (const bad of cases) {
      const res = await postTrip(app, bad);
      expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
  });

  it("refuses a trip that breaks a rule with 422 and a short code", async () => {
    const { app, logs } = tripsApp();
    const plan = await aiPlan(app);
    const body = saveBody(plan) as { days: { anchorId: string; ids: string[] }[] };
    const repeated = body.days[0]?.ids[0] as string;
    body.days[1]?.ids.push(repeated);

    const res = await postTrip(app, body);

    expect(res.status).toBe(422);
    expect(ErrorResponseSchema.parse(await res.json()).error.code).toBe("trip_not_valid");
    expect(lastRequestLog(logs).violationCodes).toContain("DUPLICATE_PLACE");
  });

  it("refuses bodies over 16 KB and bodies that are not JSON", async () => {
    const { app } = tripsApp();

    const big = await postTrip(app, JSON.stringify({ pad: "x".repeat(17 * 1024) }));
    const text = await postTrip(app, "hello", { "content-type": "text/plain" });
    const broken = await postTrip(app, "{");

    expect(big.status).toBe(413);
    expect(text.status).toBe(415);
    expect(broken.status).toBe(400);
  });

  it("tries another id when the first is taken, so a collision never overwrites a trip", async () => {
    // Ten bytes of 0 give "0000000000"; the next call gives ten 1s, "1111111111".
    let call = 0;
    const random = (size: number) => new Uint8Array(size).fill(call++ === 0 ? 0 : 1);
    const { app, store } = tripsApp({ random });
    await store.putNew(tripKey("0000000000"), "someone else's trip", 2_000_000_000, signal());
    const plan = (await (
      await postPlan(app, tripBody(), { query: "mode=deterministic" })
    ).json()) as Itinerary;

    const id = await saveTrip(app, saveBody(plan));

    expect(id).toBe("1111111111");
    expect(await store.get(tripKey("0000000000"), signal())).toBe("someone else's trip");
  });

  it("limits saves per client", async () => {
    const tripRateLimiter = createTokenBucket({ capacity: 1, refillPerMinute: 1, maxKeys: 10 });
    const { app } = tripsApp({ tripRateLimiter });
    const plan = await aiPlan(app);

    const first = await postTrip(app, saveBody(plan));
    const second = await postTrip(app, saveBody(plan));

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
  });

  it("answers 503 when saved trips are off or the store fails, and counts the failure", async () => {
    const off = makeApp({ tripStore: null });
    const failing: TripStore = {
      kind: "memory",
      putNew: async () => {
        throw new Error("AccessDeniedException");
      },
      get: async () => {
        throw new Error("AccessDeniedException");
      },
    };
    const broken = makeApp({ tripStore: failing, emitMetrics: true });
    const plan = await aiPlan(tripsApp().app);
    const { planId: _planId, ...rulesBody } = saveBody(plan);

    const cases = [
      await postTrip(off.app, rulesBody),
      await getTrip(off.app, "AAAAAAAAAA"),
      await postTrip(broken.app, saveBody(plan)), // the read of the plan record fails
      await postTrip(broken.app, rulesBody), // the write fails
      await getTrip(broken.app, "AAAAAAAAAA"),
    ];

    for (const res of cases) {
      expect(res.status).toBe(503);
      const body = ErrorResponseSchema.parse(await res.json());
      expect(body.error.code).toBe("trips_unavailable");
      expect(JSON.stringify(body)).not.toContain("AccessDenied");
    }
    expect(lastRequestLog(broken.logs)).toMatchObject({ tripStore: "error", TripStoreFailures: 1 });
  });

  it("answers 404 for an unknown, malformed or expired trip, never cached", async () => {
    const { app, store } = tripsApp();
    await store.putNew(tripKey("CCCCCCCCCC"), "{}", 1, signal()); // expired in 1970

    for (const id of ["AAAAAAAAAA", "short", "AAAAAAAAA!", "CCCCCCCCCC"]) {
      const res = await getTrip(app, encodeURIComponent(id));
      expect(res.status, id).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(ErrorResponseSchema.parse(await res.json()).error.code).toBe("not_found");
    }
  });

  it("answers 500 for a stored trip it cannot read, without showing it", async () => {
    const { app, store, logs } = tripsApp();
    await store.putNew(tripKey("DDDDDDDDDD"), '{"secret":"x"}', 2_000_000_000, signal());

    const res = await getTrip(app, "DDDDDDDDDD");

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret");
    expect(lastRequestLog(logs).error).toMatchObject({
      message: "A stored trip failed its schema",
    });
  });

  it("answers HEAD, and 405 with Allow for other methods", async () => {
    const { app } = tripsApp();
    const id = await saveTrip(app, saveBody(await aiPlan(app)));

    const head = await app.request(`/api/trips/${id}`, { method: "HEAD" });
    const putOne = await app.request(`/api/trips/${id}`, { method: "PUT" });
    const getAll = await app.request("/api/trips");

    expect(head.status).toBe(200);
    expect(putOne.status).toBe(405);
    expect(putOne.headers.get("allow")).toBe("GET, HEAD");
    expect(getAll.status).toBe(405);
    expect(getAll.headers.get("allow")).toBe("POST");
  });

  it("never writes a trip's why lines or summary into the log line", async () => {
    const { app, logs } = tripsApp();
    const plan = await aiPlan(app);
    const id = await saveTrip(app, saveBody(plan));
    await getTrip(app, id);

    const reason = plan.days[0]?.stops[0]?.reason as string;
    const text = logs.join("\n");
    expect(text).not.toContain(reason);
    expect(text).not.toContain(plan.summary as string);
  });
});

describe("which store the app uses", () => {
  const production = { NODE_ENV: "production", ORIGIN_VERIFY_PARAM: "/italy-planner/o" };

  it("uses DynamoDB when TRIPS_TABLE is set, memory outside production, and none in it", () => {
    const now = () => 0;
    const table = { TRIPS_TABLE: "italy-planner-trips" };

    expect(defaultTripStore(loadConfig({ ...production, ...table }), now)?.kind).toBe("dynamodb");
    expect(defaultTripStore(loadConfig(table), now)?.kind).toBe("dynamodb");
    expect(defaultTripStore(loadConfig({}), now)?.kind).toBe("memory");
    expect(defaultTripStore(loadConfig(production), now)).toBeNull();
  });
});
