import { addDays, TRIP_DAYS } from "@italy/planner";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import {
  DataIssuesResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  MetaResponseSchema,
  PlacesResponseSchema,
} from "../../src/contract";
import { shippedData } from "../../src/data";
import { lastRequestLog, makeApp } from "../helpers/app";

// Plan scenario 1: every read route answers with the published shape, and anything else gets a
// JSON error, never HTML, never a stack trace.

const { dataset, ctx } = shippedData();

describe("GET /api/health", () => {
  it("returns ok with the package version and deployed commit, for the deploy smoke test", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    const body = HealthResponseSchema.parse(await res.json());
    expect(body).toEqual({
      ok: true,
      version: packageJson.version,
      commit: "abc1234",
      llmAvailable: true,
      model: "fixture",
    });
  });

  it("reports AI planning as unavailable when the AI layer is off", async () => {
    const { app } = makeApp({ env: { LLM_MODE: "off" } });

    const body = HealthResponseSchema.parse(await (await app.request("/api/health")).json());

    expect(body.llmAvailable).toBe(false);
    expect(body.model).toBeNull();
  });
});

describe("GET /api/meta", () => {
  it("lists bases, interests, types, prices, paces, meals, limits, and the data summary", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/meta");

    expect(res.status).toBe(200);
    const meta = MetaResponseSchema.parse(await res.json());
    expect(meta.anchors.map((a) => a.id)).toEqual(ctx.anchors.map((a) => a.id));
    expect(meta.anchors.find((a) => a.id === "rome")?.placeCount).toBe(
      ctx.anchorById.get("rome")?.placeIds.length,
    );
    expect(meta.tripDays).toBe(TRIP_DAYS);
    expect(meta.paces.map((p) => p.id)).toEqual(["relaxed", "balanced", "packed"]);
    expect(meta.paces[1]).toMatchObject({ maxVisits: 5, dayStart: "09:30", dayEnd: "22:30" });
    expect(meta.meals.lunch).toEqual({ earliestStart: "12:00", latestStart: "14:30" });
    expect(meta.priceLevels.map((p) => p.label)).toEqual(["€", "€€", "€€€", "€€€€"]);
    expect(meta.limits).toMatchObject({ maxInterests: 8, maxAnchors: 2, notesMaxChars: 500 });
    // The planner schema's own bounds, the same the web form uses, so the two never disagree.
    expect(meta.limits.earliestStartDate).toBe("2000-01-01");
    expect(meta.limits.latestStartDate).toBe(addDays("2100-12-31", -(TRIP_DAYS - 1)));
    expect(meta.dataSummary.totals.records).toBe(dataset.places.length + dataset.excluded.length);
  });

  it("never offers price, crowd, or time-of-day tags as interests", async () => {
    const { app } = makeApp();

    const meta = MetaResponseSchema.parse(await (await app.request("/api/meta")).json());
    const tags = meta.interests.map((i) => i.tag);

    for (const tag of ["free", "budget", "splurge", "tourist-heavy", "morning", "evening"]) {
      expect(tags).not.toContain(tag);
    }
    expect(meta.interests.find((i) => i.tag === "local-favorite")?.label).toBe("Local favorite");
    const counts = meta.interests.map((i) => i.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("counts issues by kind so the data panel can say what was fixed", async () => {
    const { app } = makeApp();

    const meta = MetaResponseSchema.parse(await (await app.request("/api/meta")).json());
    const total = Object.values(meta.issueCounts).reduce((sum, n) => sum + (n ?? 0), 0);

    expect(total).toBe(dataset.issues.length);
  });
});

describe("GET /api/places", () => {
  it("returns every schedulable place in the planner's Place shape, with chips", async () => {
    const { app } = makeApp();

    const body = PlacesResponseSchema.parse(await (await app.request("/api/places")).json());

    expect(body.places).toHaveLength(dataset.places.length);
    expect(Object.keys(body.chips)).toHaveLength(dataset.places.length);
    const brera = body.places.find((p) => p.id === "place_059");
    expect(brera?.locationSource).not.toBe("listed");
    expect(body.approximateLocation).toContain("place_059");
    expect(body.chips.place_059?.map((c) => c.label)).toContain("Approximate location");
  });

  it("strips fields the normalizer might add for internal use", async () => {
    const data = shippedData();
    const withExtra = {
      ...data,
      dataset: {
        ...data.dataset,
        places: data.dataset.places.map((p) => ({ ...p, internalScore: 42 })),
      },
    };
    const { app } = makeApp({ data: withExtra });

    const body = (await (await app.request("/api/places")).json()) as { places: object[] };

    expect(body.places[0]).not.toHaveProperty("internalScore");
  });
});

describe("GET /api/data-issues", () => {
  it("returns every issue and excluded record with totals and the plain summary", async () => {
    const { app } = makeApp();

    const body = DataIssuesResponseSchema.parse(
      await (await app.request("/api/data-issues")).json(),
    );

    expect(body.issues).toHaveLength(dataset.issues.length);
    expect(body.totals.issues).toBe(dataset.issues.length);
    expect(body.summary.headline.length).toBeGreaterThan(0);
  });
});

describe("unknown routes and methods", () => {
  it("answers unknown API paths with a JSON 404", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/nope");

    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(await res.json()).error.code).toBe("not_found");
  });

  it("only serves routes under /api", async () => {
    const { app } = makeApp();

    expect((await app.request("/health")).status).toBe(404);
  });

  it("answers a wrong method with 405 and an Allow header", async () => {
    const { app } = makeApp();

    const del = await app.request("/api/health", { method: "DELETE" });
    const get = await app.request("/api/plan");

    expect(del.status).toBe(405);
    expect(del.headers.get("allow")).toBe("GET, HEAD");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(ErrorResponseSchema.parse(await get.json()).error.code).toBe("method_not_allowed");
  });

  it("answers HEAD on read routes without a body", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/meta", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("request ids and logs", () => {
  it("echoes a caller's request id and logs one line with it", async () => {
    const { app, logs } = makeApp();

    const res = await app.request("/api/meta", { headers: { "x-request-id": "trace-123" } });

    expect(res.headers.get("x-request-id")).toBe("trace-123");
    expect(lastRequestLog(logs)).toMatchObject({
      requestId: "trace-123",
      method: "GET",
      path: "/api/meta",
      status: 200,
    });
  });

  it("puts the request id in every error body so a report can be traced", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/nope", { headers: { "x-request-id": "trace-404" } });

    expect(ErrorResponseSchema.parse(await res.json()).error.requestId).toBe("trace-404");
  });
});

describe("CORS", () => {
  it("allows the local web dev server outside production", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/plan", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,HEAD,POST,OPTIONS");
  });

  it("never allows another origin", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/meta", { headers: { origin: "https://evil.example" } });

    expect(res.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });
});
