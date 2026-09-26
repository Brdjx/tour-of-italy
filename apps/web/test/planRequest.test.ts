import { type TripRequest, validationErrors } from "@italy/planner";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiError";
import { fallbackCause, planLocally, requestPlan, shouldPlanLocally } from "../lib/planRequest";
import { readyMessage } from "../lib/usePlanTrip";
import { aiPlan, baseRequest, ctx, must } from "./fixtures";

// When the API cannot answer and the places are loaded, the browser plans with the same rules and
// says so (docs/decisions.md, Web and PWA). A bad request is never papered over with a local plan.

const failing = (error: unknown) =>
  vi.fn(async (_request: TripRequest) => {
    throw error;
  });

describe("requestPlan", () => {
  it("returns the API's plan when the API answers", async () => {
    const plan = aiPlan();
    const outcome = await requestPlan(baseRequest, { ctx, post: async () => plan });
    expect(outcome).toEqual({ kind: "api", itinerary: plan });
  });

  it.each([
    ["the network is down", new ApiError({ kind: "network", message: "x" }), "offline"],
    ["the API timed out", new ApiError({ kind: "timeout", message: "x" }), "timeout"],
    [
      "the API failed with 500",
      new ApiError({ kind: "http", status: 500, message: "x" }),
      "server",
    ],
    ["the API is rate limited", new ApiError({ kind: "http", status: 429, message: "x" }), "busy"],
    ["the reply was not JSON", new ApiError({ kind: "parse", message: "x" }), "unreadable"],
    ["the reply was unreadable", new ApiError({ kind: "schema", message: "x" }), "unreadable"],
    ["something unexpected was thrown", new TypeError("boom"), "server"],
  ] as const)(
    "plans in the browser, with the real cause, when %s",
    async (_label, error, cause) => {
      const outcome = await requestPlan(baseRequest, { ctx, post: failing(error), now: () => 0 });
      expect(outcome.kind).toBe("offline");
      expect(outcome.kind === "offline" && outcome.cause).toBe(cause);
      expect(fallbackCause(error)).toBe(cause);
      expect(outcome.itinerary.source).toBe("deterministic");
      expect(outcome.itinerary.meta.fallbackReason).toBe("offline");
      expect(outcome.itinerary.days).toHaveLength(3);
      expect(validationErrors(outcome.itinerary, ctx)).toEqual([]);
    },
  );

  it("never shows an API plan that breaks a rule; builds one on this device instead (F1)", async () => {
    const plan = aiPlan();
    const day = must(plan.days[0], "day");
    const first = must(day.stops[0], "stop");
    // A schema-valid plan whose first stop is at 03:00, when nothing is open.
    const broken = {
      ...plan,
      days: [
        { ...day, stops: [{ ...first, start: 180, end: 240 }, ...day.stops.slice(1)] },
        ...plan.days.slice(1),
      ],
    };
    expect(validationErrors(broken, ctx).length).toBeGreaterThan(0);
    const outcome = await requestPlan(baseRequest, { ctx, post: async () => broken, now: () => 0 });
    expect(outcome.kind).toBe("offline");
    expect(outcome.kind === "offline" && outcome.cause).toBe("invalid");
    expect(validationErrors(outcome.itinerary, ctx)).toEqual([]);
  });

  it("does not plan locally for a request the API rejected as invalid", async () => {
    const error = new ApiError({ kind: "http", status: 400, message: "x" });
    await expect(requestPlan(baseRequest, { ctx, post: failing(error) })).rejects.toBe(error);
  });

  it("does not plan locally when the traveler cancelled", async () => {
    const error = new ApiError({ kind: "aborted", message: "x" });
    await expect(requestPlan(baseRequest, { ctx, post: failing(error) })).rejects.toBe(error);
  });

  it("rethrows the API error when the places never loaded", async () => {
    const error = new ApiError({ kind: "network", message: "x" });
    await expect(requestPlan(baseRequest, { ctx: null, post: failing(error) })).rejects.toBe(error);
  });

  it("passes the abort signal and deterministic flag through to the API call", async () => {
    const post = vi.fn(async () => aiPlan());
    const controller = new AbortController();
    await requestPlan(
      baseRequest,
      { ctx, post },
      { signal: controller.signal, deterministic: true },
    );
    expect(post).toHaveBeenCalledWith(baseRequest, {
      signal: controller.signal,
      deterministic: true,
    });
  });
});

describe("readyMessage", () => {
  it("says offline only for a plan made because the service could not be reached", () => {
    const itinerary = aiPlan();
    expect(readyMessage({ kind: "api", itinerary })).toBe("Your plan is ready.");
    expect(readyMessage({ kind: "offline", itinerary, cause: "offline", error: null })).toBe(
      "Your plan is ready. It was planned without AI, offline.",
    );
    expect(readyMessage({ kind: "offline", itinerary, cause: "server", error: null })).toBe(
      "Your plan is ready. It was planned on this device, without AI.",
    );
  });
});

describe("planLocally", () => {
  it("honours must-see places and exclusions like the server would", () => {
    const plan = planLocally(
      { ...baseRequest, mustInclude: ["place_001"], exclude: ["place_002"] },
      ctx,
      () => 1_000,
    );
    const ids = plan.days.flatMap((day) => day.stops.map((stop) => stop.placeId));
    expect(ids).toContain("place_001");
    expect(ids).not.toContain("place_002");
    expect(plan.meta.generatedAt).toBe("1970-01-01T00:00:01.000Z");
  });

  it("classifies failures consistently with requestPlan", () => {
    expect(shouldPlanLocally(new ApiError({ kind: "http", status: 413, message: "x" }))).toBe(
      false,
    );
    expect(shouldPlanLocally(new ApiError({ kind: "http", status: 403, message: "x" }))).toBe(true);
    expect(shouldPlanLocally(new ApiError({ kind: "parse", message: "x" }))).toBe(true);
  });
});
