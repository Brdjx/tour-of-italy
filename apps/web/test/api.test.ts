import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchDataIssues,
  fetchHealth,
  fetchMeta,
  fetchPlaces,
  postPlan,
  requestJson,
  resolveApiBase,
} from "../lib/api";
import { ApiError } from "../lib/apiError";
import { MetaSchema } from "../lib/apiSchemas";
import { aiPlan, baseRequest, dataset, jsonResponse, places, XSS } from "./fixtures";

// F8: the frontend must never crash or render garbage on an unexpected API response. Every
// failure mode of the transport and of the body has to come out as a typed ApiError.

afterEach(() => {
  vi.useRealTimers();
});

function fetchReturning(response: Response | Promise<Response>) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response);
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("Expected the call to fail");
}

describe("resolveApiBase", () => {
  it("never calls localhost from a production build when the variable is missing", () => {
    expect(resolveApiBase(undefined, "production")).toBe("");
    expect(resolveApiBase(undefined, "development")).toBe("http://localhost:8787");
  });

  it("drops a trailing slash so paths never double up", () => {
    expect(resolveApiBase("https://example.test//", "production")).toBe("https://example.test");
    expect(resolveApiBase("", "development")).toBe("");
  });
});

describe("requestJson transport failures", () => {
  it("turns a rejected fetch (offline, DNS, CORS) into a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const error = await caught(fetchMeta({ fetchImpl, base: "" }));
    expect(error.kind).toBe("network");
  });

  it("gives up after the deadline instead of hanging on a silent server", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("x", "AbortError")),
          );
        }),
    );
    const pending = caught(fetchPlaces({ fetchImpl, base: "", timeoutMs: 5000 }));
    await vi.advanceTimersByTimeAsync(5001);
    const error = await pending;
    expect(error.kind).toBe("timeout");
  });

  it("reports a caller cancel as aborted, not as a failure to show", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return jsonResponse({});
    });
    const error = await caught(fetchMeta({ fetchImpl, base: "", signal: controller.signal }));
    expect(error.kind).toBe("aborted");
  });
});

describe("requestJson http errors", () => {
  it("keeps the code, message, details and request id of a 400", async () => {
    const body = {
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid trip request",
        details: [{ path: ["startDate"], message: "bad" }],
        requestId: "req-123",
      },
    };
    const error = await caught(
      postPlan(baseRequest, { fetchImpl: fetchReturning(jsonResponse(body, 400)), base: "" }),
    );
    expect(error).toMatchObject({ kind: "http", status: 400, code: "INVALID_REQUEST" });
    expect(error.requestId).toBe("req-123");
    expect(error.details).toEqual(body.error.details);
  });

  it("survives a 500 whose body is not JSON (an HTML error page from a proxy)", async () => {
    const page = new Response("<html><body>Bad gateway</body></html>", { status: 502 });
    const error = await caught(fetchMeta({ fetchImpl: fetchReturning(page), base: "" }));
    expect(error).toMatchObject({ kind: "http", status: 502 });
    expect(error.message).not.toContain("<html>");
  });

  it("survives a 500 whose JSON is not the error envelope", async () => {
    const error = await caught(
      fetchMeta({ fetchImpl: fetchReturning(jsonResponse({ oops: true }, 500)), base: "" }),
    );
    expect(error).toMatchObject({ kind: "http", status: 500, code: undefined });
  });
});

describe("requestJson body checks", () => {
  it("rejects a 200 whose body is not JSON", async () => {
    const response = new Response("{not json", { status: 200 });
    const error = await caught(fetchPlaces({ fetchImpl: fetchReturning(response), base: "" }));
    expect(error.kind).toBe("parse");
  });

  it("rejects an itinerary with a missing day instead of rendering two days", async () => {
    const plan = aiPlan();
    const broken = { ...plan, days: plan.days.slice(0, 2) };
    const error = await caught(
      postPlan(baseRequest, { fetchImpl: fetchReturning(jsonResponse(broken)), base: "" }),
    );
    expect(error.kind).toBe("schema");
    expect(error.details).toContain("days");
  });

  it("never echoes a hostile value from a schema mismatch into the error", async () => {
    const plan = aiPlan();
    const hostile = { ...plan, source: XSS };
    const error = await caught(
      postPlan(baseRequest, { fetchImpl: fetchReturning(jsonResponse(hostile)), base: "" }),
    );
    expect(error.kind).toBe("schema");
    expect(JSON.stringify(error.details)).not.toContain("onerror");
    expect(error.message).not.toContain("onerror");
  });

  it("rejects a place list where a place has an impossible coordinate", async () => {
    const bad = [{ ...places[0], lat: "41.9" }];
    const error = await caught(
      fetchPlaces({ fetchImpl: fetchReturning(jsonResponse(bad)), base: "" }),
    );
    expect(error.kind).toBe("schema");
  });
});

describe("successful calls", () => {
  it("parses a plan and sends the request as JSON to the deterministic path when asked", async () => {
    const plan = aiPlan();
    const fetchImpl = fetchReturning(jsonResponse(plan));
    const result = await postPlan(baseRequest, {
      fetchImpl,
      base: "https://api.test",
      deterministic: true,
    });
    expect(result.days).toHaveLength(3);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.test/api/plan?mode=deterministic");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(baseRequest);
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("accepts the place list bare or wrapped in { places }", async () => {
    const bare = await fetchPlaces({ fetchImpl: fetchReturning(jsonResponse(places)), base: "" });
    const wrapped = await fetchPlaces({
      fetchImpl: fetchReturning(jsonResponse({ places })),
      base: "",
    });
    expect(bare).toHaveLength(places.length);
    expect(wrapped).toHaveLength(places.length);
  });

  it("reads meta while ignoring fields it does not know, so an API addition cannot break it", async () => {
    const meta = {
      anchors: [{ id: "rome", name: "Rome", placeCount: 30, centroid: { lat: 1, lng: 2 } }],
      interests: [{ tag: "food", label: "Food", count: 39 }],
      tripDays: 3,
      somethingNew: { nested: true },
    };
    const parsed = await fetchMeta({ fetchImpl: fetchReturning(jsonResponse(meta)), base: "" });
    expect(parsed.anchors[0]).toEqual({ id: "rome", name: "Rome", placeCount: 30 });
    expect(MetaSchema.safeParse({ anchors: [], interests: [] }).success).toBe(false);
  });

  it("reads data issues as a summary, a raw list, or both, but not neither", async () => {
    const withSummary = await fetchDataIssues({
      fetchImpl: fetchReturning(jsonResponse({ summary: dataset.summary })),
      base: "",
    });
    expect(withSummary.summary?.items.length).toBeGreaterThan(0);
    const error = await caught(
      fetchDataIssues({ fetchImpl: fetchReturning(jsonResponse({ totals: 1 })), base: "" }),
    );
    expect(error.kind).toBe("schema");
  });

  it("reads the health check", async () => {
    const health = await fetchHealth({
      fetchImpl: fetchReturning(jsonResponse({ ok: true, version: "0.1.0", commit: "abc" })),
      base: "",
    });
    expect(health.commit).toBe("abc");
  });

  it("clears its deadline timer so a finished call cannot abort later", async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await requestJson({
      path: "/api/meta",
      schema: MetaSchema,
      options: {
        fetchImpl: fetchReturning(
          jsonResponse({ anchors: [{ id: "rome", name: "Rome" }], interests: [] }),
        ),
        base: "",
      },
    });
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
