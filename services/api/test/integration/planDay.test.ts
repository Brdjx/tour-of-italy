import { describe, expect, it } from "vitest";
import { ErrorResponseSchema } from "../../src/contract";
import { shippedData } from "../../src/data";
import { staticSecret } from "../../src/lib/secrets";
import { DAY_PROMPT_VERSION } from "../../src/llm/dayPrompt";
import { FIXTURE_SCENARIOS, FixtureClient, type FixtureScenario } from "../../src/llm/fixture";
import { createMemoryStore } from "../../src/trips/store";
import { FIXED_NOW, lastRequestLog, makeApp, postPlan, tripBody } from "../helpers/app";
import { dayBody, expectValidDay, plannedTrip, postDay } from "../helpers/day";

// POST /api/plan/day end to end through app.request, with fixture model clients: every way the
// model can answer or fail ends in a day that adds no error to the trip, repeats no place of
// another day, and changes no other day; a city the day cannot take is refused with its reason;
// and the route is guarded like POST /api/plan.

const { ctx } = shippedData();

/** A Rome trip; day 3 (index 2) can move to any city. */
const rome = plannedTrip();
/** A Rome trip from a Saturday, so day 3 is a Monday and Florence has a place closed then. */
const romeFromSaturday = plannedTrip({ startDate: "2026-10-17" });

async function replan(scenario?: string, trip = rome, day = 2, anchorId = "florence") {
  const { app, logs } = makeApp();
  const res = await postDay(app, dayBody(trip, day, anchorId), { scenario });
  return { res, body: await res.json(), logs };
}

const EXPECTED: Record<FixtureScenario, { source: string; reason?: string; attempts: number }> = {
  valid: { source: "ai", attempts: 1 },
  "unknown-id-then-valid": { source: "ai_repaired", attempts: 2 },
  "closed-day-tidied": { source: "ai_repaired", attempts: 1 },
  "repeat-tidied": { source: "ai_repaired", attempts: 1 },
  "messy-tidied": { source: "ai_repaired", attempts: 1 },
  "always-invalid": { source: "deterministic", reason: "invalid_after_repair", attempts: 2 },
  "schema-invalid": { source: "ai_repaired", attempts: 2 },
  truncated: { source: "deterministic", reason: "max_tokens", attempts: 1 },
  refusal: { source: "deterministic", reason: "refusal", attempts: 1 },
  "rate-limited": { source: "deterministic", reason: "rate_limited", attempts: 1 },
  overloaded: { source: "deterministic", reason: "rate_limited", attempts: 2 },
  "server-error": { source: "deterministic", reason: "llm_error", attempts: 2 },
  "connection-error": { source: "deterministic", reason: "llm_error", attempts: 2 },
  "connection-reset-then-valid": { source: "ai", attempts: 2 },
  "slow-first-call": { source: "deterministic", reason: "timeout", attempts: 1 },
  "slow-repair": { source: "deterministic", reason: "timeout", attempts: 2 },
  "non-sdk-throw": { source: "deterministic", reason: "llm_error", attempts: 1 },
  "injection-echo": { source: "ai_repaired", attempts: 2 },
};

/** Short model timeouts, so the slow scenarios run in well under a second. */
const FAST = {
  env: { LLM_TIMEOUT_MS: "300", PLAN_DEADLINE_MS: "2000" },
  timing: {
    reserveMs: 200,
    minCallMs: 100,
    minRepairMs: 100,
    retry: { defaultPauseMs: 10, maxPauseMs: 50 },
  },
};

describe("POST /api/plan/day with every fixture scenario", () => {
  for (const scenario of FIXTURE_SCENARIOS) {
    const want = EXPECTED[scenario];
    it(`"${scenario}" ends in a valid ${want.source} day`, async () => {
      const { app, logs } = makeApp(FAST);
      const res = await postDay(app, dayBody(romeFromSaturday, 2, "florence"), { scenario });

      expect(res.status).toBe(200);
      const day = expectValidDay(await res.json(), romeFromSaturday, 2);
      expect(day.source).toBe(want.source);
      expect(day.meta.fallbackReason).toBe(want.reason);
      expect(day.meta.attempts).toBe(want.attempts);
      expect(day.meta.model).toBe(`fixture:${scenario}`);
      expect(day.meta.promptVersion).toBe(DAY_PROMPT_VERSION);
      expect(day.dayPlan.anchorId).toBe("florence");
      expect(lastRequestLog(logs)).toMatchObject({ source: want.source, day: 2 });
    });
  }
});

describe("POST /api/plan/day", () => {
  it("returns an AI day with AI reasons, timed after the transfer, and logs no content", async () => {
    const { res, body, logs } = await replan("valid");

    expect(res.status).toBe(200);
    const day = expectValidDay(body, rome, 2);
    expect(day.source).toBe("ai");
    expect(day.dayPlan.transferMin).toBe(130);
    expect(day.dayPlan.date).toBe(rome.days[2]?.date);
    expect(day.dayPlan.stops.every((stop) => stop.reasonSource === "ai")).toBe(true);
    const log = lastRequestLog(logs);
    expect(log).toMatchObject({
      source: "ai",
      attempts: 1,
      promptVersion: DAY_PROMPT_VERSION,
      model: "fixture:valid",
      cache: "miss",
      tidied: [],
    });
    expect(log.usage).toMatchObject({ inputTokens: expect.any(Number) });
    // The log line has ids and counts, never the model's text.
    const reason = day.dayPlan.stops[0]?.reason ?? "";
    expect(JSON.stringify(log)).not.toContain(reason);
  });

  it("drops a repeat of another day's place before the check, with no repair turn", async () => {
    const { body, logs } = await replan("repeat-tidied");

    const day = expectValidDay(body, rome, 2);
    expect(day.source).toBe("ai_repaired");
    const log = lastRequestLog(logs);
    expect(log.violationCodes).toEqual([]);
    expect(log.tidied).toEqual([expect.objectContaining({ rule: "duplicate", day: 2, answer: 1 })]);
  });

  it("treats an id outside the day's shortlist as an error the repair turn fixes", async () => {
    const { body, logs } = await replan("unknown-id-then-valid");

    const day = expectValidDay(body, rome, 2);
    expect(day.source).toBe("ai_repaired");
    expect(day.dayPlan.stops.map((s) => s.placeId)).not.toContain("place_999");
    expect(lastRequestLog(logs).violationCodes).toEqual(["UNKNOWN_PLACE"]);
  });

  it("drops a place closed on the day's date before the check", async () => {
    const { body, logs } = await replan("closed-day-tidied", romeFromSaturday);

    expect(expectValidDay(body, romeFromSaturday, 2).source).toBe("ai_repaired");
    expect(lastRequestLog(logs).tidied).toEqual([
      expect.objectContaining({ rule: "closed", day: 2, placeId: "place_026" }),
    ]);
  });

  it("falls back to the rules-only day after a failed repair, with rule reasons", async () => {
    const { body } = await replan("always-invalid");

    const day = expectValidDay(body, rome, 2);
    expect(day.source).toBe("deterministic");
    expect(day.meta.fallbackReason).toBe("invalid_after_repair");
    expect(day.dayPlan.stops.every((stop) => stop.reasonSource === "rule")).toBe(true);
  });

  it("plans with the rules alone for ?mode=deterministic, with no model call", async () => {
    const client = new FixtureClient(ctx, "valid");
    const { app } = makeApp({ client });
    const res = await postDay(app, dayBody(rome, 2, "venice"), { query: "mode=deterministic" });

    const day = expectValidDay(await res.json(), rome, 2);
    expect(day.source).toBe("deterministic");
    expect(day.meta.fallbackReason).toBe("requested");
    expect(client.calls).toBe(0);
  });

  it("plans with the rules alone when the AI layer is off, and says why", async () => {
    const { app } = makeApp({ env: { LLM_MODE: "off", LLM_ENABLED: "false" } });
    const res = await postDay(app, dayBody(rome, 2, "venice"));

    const day = expectValidDay(await res.json(), rome, 2);
    expect(day.meta.fallbackReason).toBe("disabled");
  });

  it("plans a new version of a day at its own city, leaving out the places it avoids", async () => {
    const current = rome.days[1]?.stops.map((stop) => stop.placeId) ?? [];
    const { app } = makeApp();
    const res = await postDay(app, dayBody(rome, 1, "rome", { avoid: current }));

    const day = expectValidDay(await res.json(), rome, 1);
    expect(day.dayPlan.stops.map((s) => s.placeId).filter((id) => current.includes(id))).toEqual(
      [],
    );
  });

  it("refuses a city the day cannot take, with the reason the page shows (422)", async () => {
    const { app, logs } = makeApp();
    const res = await postDay(app, dayBody(rome, 1, "florence"));

    expect(res.status).toBe(422);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.error).toMatchObject({
      code: "day_not_allowed",
      message:
        "A trip changes city once at most, so it cannot go from Rome to Florence and back. Move day 3 to Florence first.",
    });
    expect(lastRequestLog(logs)).toMatchObject({ status: 422, dayRefused: true });
  });

  it("refuses a third city", async () => {
    const trip = plannedTrip({ anchors: ["rome", "florence"], startDate: "2026-10-18" });
    const { app } = makeApp();
    const res = await postDay(app, dayBody(trip, 0, "venice"));

    expect(res.status).toBe(422);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.error.message).toMatch(/^A trip can use at most 2 cities/);
  });

  it("answers 405 with an Allow header for any method but POST", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/plan/day", { method: "GET" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("POST /api/plan/day: the AI day cache", () => {
  it("serves the same day from memory without asking the model again", async () => {
    const client = new FixtureClient(ctx, "valid");
    const { app, logs } = makeApp({ client });

    const first = await (await postDay(app, dayBody(rome, 2, "florence"))).json();
    const second = await (await postDay(app, dayBody(rome, 2, "florence"))).json();

    expect(client.calls).toBe(1);
    expect(second).toEqual(first);
    expect(lastRequestLog(logs)).toMatchObject({ cache: "hit-memory", source: "ai" });
  });

  it("keys on the base, the day, the other days and the places avoided", async () => {
    const client = new FixtureClient(ctx, "valid");
    const { app } = makeApp({ client });

    await postDay(app, dayBody(rome, 2, "florence"));
    await postDay(app, dayBody(rome, 2, "venice"));
    await postDay(app, dayBody(rome, 2, "florence", { avoid: ["place_026"] }));
    await postDay(app, dayBody(romeFromSaturday, 2, "florence"));

    expect(client.calls).toBe(4);
  });

  it("shares an AI day between instances through the table, and never writes a rules-only day", async () => {
    const store = createMemoryStore(() => FIXED_NOW);
    const client = new FixtureClient(ctx, "valid");
    const one = makeApp({ client, tripStore: store });
    const two = makeApp({ client, tripStore: store });

    await postDay(one.app, dayBody(rome, 2, "florence"));
    await postDay(two.app, dayBody(rome, 2, "florence"));
    expect(client.calls).toBe(1);
    expect(lastRequestLog(two.logs)).toMatchObject({ cache: "hit-store" });

    await postDay(one.app, dayBody(rome, 2, "venice"), { query: "mode=deterministic" });
    await postDay(two.app, dayBody(rome, 2, "venice"), { query: "mode=deterministic" });
    expect(lastRequestLog(two.logs).cacheWrite).toBeUndefined();
  });

  it("keeps a day planned for notes in memory only, never in the shared table", async () => {
    const store = createMemoryStore(() => FIXED_NOW);
    const writes: string[] = [];
    const putNew = store.putNew.bind(store);
    store.putNew = (key, body, expiresAt, signal) => {
      writes.push(key);
      return putNew(key, body, expiresAt, signal);
    };
    const client = new FixtureClient(ctx, "valid");
    const one = makeApp({ client, tripStore: store });
    const two = makeApp({ client, tripStore: store });
    const trip = plannedTrip({ notes: "We love quiet gardens." });

    await postDay(one.app, dayBody(trip, 2, "florence"));
    await postDay(one.app, dayBody(trip, 2, "florence"));
    await postDay(two.app, dayBody(trip, 2, "florence"));

    expect(writes.filter((key) => key.startsWith("cache#"))).toEqual([]);
    expect(lastRequestLog(one.logs).cache).toBe("hit-memory");
    expect(lastRequestLog(two.logs).cache).toBe("miss");
    expect(client.calls).toBe(2);
  });
});

describe("POST /api/plan/day: guards", () => {
  it("answers 429 with Retry-After when the client's budget is spent", async () => {
    const limited = makeApp({
      rateLimiter: {
        take: () => ({ allowed: false, remaining: 0, retryAfterSec: 7 }),
        size: () => 0,
      },
    });

    const res = await postDay(limited.app, dayBody(rome, 2, "florence"));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("spends one budget across /api/plan and /api/plan/day", async () => {
    let taken = 0;
    const { app } = makeApp({
      rateLimiter: {
        take: () => {
          taken++;
          return { allowed: taken <= 2, remaining: 0, retryAfterSec: 1 };
        },
        size: () => 0,
      },
    });

    expect((await postPlan(app, tripBody(), { query: "mode=deterministic" })).status).toBe(200);
    expect((await postDay(app, dayBody(rome, 2, "florence"))).status).toBe(200);
    expect((await postDay(app, dayBody(rome, 2, "florence"))).status).toBe(429);
  });

  it("is behind the origin check whenever the origin parameter is set", async () => {
    const { app } = makeApp({
      env: { NODE_ENV: "development", ORIGIN_VERIFY_PARAM: "/italy-planner/o" },
      originSecret: staticSecret("origin-secret-for-tests"),
    });

    const without = await postDay(app, dayBody(rome, 2, "florence"));
    const withHeader = await postDay(app, dayBody(rome, 2, "florence"), {
      headers: { "x-origin-verify": "origin-secret-for-tests" },
    });

    expect(without.status).toBe(403);
    expect(withHeader.status).toBe(200);
  });

  it("takes JSON only, within the body cap", async () => {
    const { app } = makeApp();
    const text = JSON.stringify(dayBody(rome, 2, "florence"));

    const plain = await app.request("/api/plan/day", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: text,
    });
    const broken = await postDay(app, "{not json");
    const huge = await postDay(app, dayBody(rome, 2, "florence", { pad: "x".repeat(17_000) }));

    expect(plain.status).toBe(415);
    expect(broken.status).toBe(400);
    expect(ErrorResponseSchema.parse(await broken.json()).error.code).toBe("invalid_json");
    expect(huge.status).toBe(413);
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ["an unknown field", { summary: "hi" }, ""],
    ["a day out of range", { day: 3 }, "day"],
    ["an unknown base", { anchorId: "atlantis" }, "anchorId"],
    ["an unknown place to avoid", { avoid: ["place_999"] }, "avoid.0"],
    [
      "a request the plan route would refuse",
      { request: { ...rome.request, pace: "sprint" } },
      "request.pace",
    ],
  ];
  it.each(invalid)("refuses a body with %s (400)", async (_name, extra, path) => {
    const { app } = makeApp();
    const res = await postDay(app, dayBody(rome, 2, "florence", extra));

    expect(res.status).toBe(400);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.error.code).toBe("bad_request");
    expect(body.error.details?.map((d) => d.path)).toContain(path);
  });

  it("refuses a trip the page could not have made (400)", async () => {
    const { app } = makeApp();
    const days = dayBody(rome, 2, "florence").days as { anchorId: string; ids: string[] }[];
    const repeat = days[0]?.ids[0] as string;
    const cases = [
      // A place on two days.
      days.map((d, i) => (i === 1 ? { ...d, ids: [...d.ids, repeat] } : d)),
      // A place of another base.
      days.map((d, i) => (i === 0 ? { ...d, ids: [...d.ids, "place_026"] } : d)),
      // An unknown place, and an unknown base.
      days.map((d, i) => (i === 0 ? { anchorId: "atlantis", ids: ["place_999"] } : d)),
      // An empty day that is not the one being planned.
      days.map((d, i) => (i === 0 ? { ...d, ids: [] } : d)),
      // Only two days.
      days.slice(0, 2),
    ];
    for (const trip of cases) {
      const res = await postDay(app, { ...dayBody(rome, 2, "florence"), days: trip });
      expect(res.status).toBe(400);
    }
    // The day being planned may be sent empty.
    const empty = days.map((d, i) => (i === 2 ? { ...d, ids: [] } : d));
    const res = await postDay(app, { ...dayBody(rome, 2, "florence"), days: empty });
    expect(res.status).toBe(200);
  });

  it("answers 400 for an unknown fixture scenario", async () => {
    const { res } = await replan("no-such-scenario");
    expect(res.status).toBe(400);
  });
});
